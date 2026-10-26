import type { AgentJournalMessageItem } from '../../shared/agent-session-journal-types'
import { isNativeLocalLocation, LOCAL_EXECUTION_HOST_ID } from '../../shared/execution-host'
import type { AgentSessionExecutionLocation } from '../../shared/agent-session-record'
import { proposeJevAction } from './jev-action-client'

type ShadowIdentity = Readonly<{
  sessionId: string
  clientOperationId: string
  location: AgentSessionExecutionLocation
}>

type ShadowDiagnostic = Readonly<{
  sessionId: string
  clientOperationId: string
  status: 'evaluated' | 'unevaluated'
  reason?: string
  action?: string
  model?: string
  catalogBinding?: string
  durationMs?: number
  inputTokens?: number
  outputTokens?: number
}>

export class JevActionShadow {
  private readonly active = new Set<AbortController>()
  private stopped = false

  constructor(private readonly report: (diagnostic: ShadowDiagnostic) => void) {}

  private enabled = () => !this.stopped && process.env.ORCA_JEV_MODE === 'shadow'

  capture(body: AgentJournalMessageItem): string | undefined {
    if (
      !this.enabled() ||
      body.role !== 'user' ||
      body.command ||
      body.sentAs ||
      body.from ||
      body.skills?.length ||
      body.blocks.length > 256
    ) {
      return undefined
    }
    const parts: string[] = []
    let bytes = 0
    for (const block of body.blocks) {
      if (block.type !== 'text') {
        return undefined
      }
      bytes += Buffer.byteLength(block.text) + 1
      if (bytes > 64 * 1024) {
        return undefined
      }
      parts.push(block.text)
    }
    const text = parts.join('\n')
    return text.trim() && !text.trimStart().startsWith('/') ? text : undefined
  }

  observe(identity: ShadowIdentity, text: string): void {
    if (!this.enabled() || !isNativeLocalLocation(identity.location) || this.active.size >= 4) {
      return
    }
    const metadata = Object.freeze({
      sessionId: identity.sessionId,
      clientOperationId: identity.clientOperationId
    })
    const workspaceId = identity.location.workspaceId
    const controller = new AbortController()
    this.active.add(controller)
    void Promise.resolve()
      .then(() => {
        if (!this.enabled() || controller.signal.aborted) {
          return undefined
        }
        return proposeJevAction(
          {
            text,
            snapshot: { targets: [{ hostId: LOCAL_EXECUTION_HOST_ID, workspaceId, workers: [] }] }
          },
          { signal: controller.signal }
        )
      })
      .then((result) => {
        if (!result) {
          return
        }
        this.diagnose(
          result.status === 'evaluated'
            ? {
                ...metadata,
                status: result.status,
                action:
                  result.proposal.kind === 'proposal'
                    ? result.proposal.action
                    : result.proposal.kind,
                model: result.model,
                catalogBinding: result.catalogBinding,
                durationMs: result.durationMs,
                inputTokens: result.usage.inputTokens,
                outputTokens: result.usage.outputTokens
              }
            : {
                ...metadata,
                status: result.status,
                reason: result.reason,
                durationMs: result.durationMs
              }
        )
      })
      .catch(() => {
        this.diagnose({ ...metadata, status: 'unevaluated', reason: 'observer_failed' })
      })
      .finally(() => this.active.delete(controller))
  }

  private diagnose(diagnostic: ShadowDiagnostic): void {
    if (!this.enabled() || process.env.ORCA_JEV_DIAGNOSTICS !== '1') {
      return
    }
    try {
      this.report(Object.freeze(diagnostic))
    } catch {
      // Diagnostic failures cannot own or fail a send.
    }
  }

  dispose(): void {
    this.stopped = true
    for (const controller of this.active) {
      controller.abort()
    }
    this.active.clear()
  }
}
