import { conversationCommandInFlight } from './structured-conversation-command-admission'
import { sendStructuredAgentSessionTurn } from './structured-agent-session-host-mutations'
import {
  runStructuredConversationCommand,
  type ConversationCommandParams
} from './structured-conversation-command'
import { runStructuredCompaction } from './structured-conversation-compaction'
import type { StructuredAgentSessionMutationContext } from './structured-agent-session-host-mutations'
import type { StructuredAgentSessionCaller } from './structured-agent-session-host-types'
import type { StructuredAgentSessionHost } from './structured-agent-session-host'
import { JevActionShadow } from '../jev-action-shadow'

export class StructuredConversationCommandController {
  /** Clear changes send context; compaction instead queues ahead of later sends. */
  readonly pending = new Map<string, { key: string; count: number }>()
  private readonly jevShadow = new JevActionShadow((diagnostic) => {
    this.context().deps.logger.warn('Jev shadow observation', {
      scope: 'jev.shadow',
      ...diagnostic
    })
  })
  constructor(
    private readonly context: () => StructuredAgentSessionMutationContext,
    private readonly host: Pick<StructuredAgentSessionHost, 'waitForSendSettlement'>
  ) {}
  /** Refuse only first-run sends during clear; recorded IDs still replay their answers. */
  send = (
    caller: StructuredAgentSessionCaller,
    params: Parameters<typeof sendStructuredAgentSessionTurn>[2]
  ): ReturnType<typeof sendStructuredAgentSessionTurn> => {
    let text: string | undefined
    try {
      if (params.userSend && params.usageLimitContinuationOfTurnItemId === undefined) {
        text = this.jevShadow.capture(params.body)
      }
    } catch {
      // Observation cannot reject the original send.
    }
    const sent = sendStructuredAgentSessionTurn(this.context(), caller, params, {
      clearInFlight: this.pending.has(params.envelope.sessionId)
    })
    if (text !== undefined) {
      const capturedText = text
      void sent
        .then((result) => {
          if (!result.ok || result.replayed || !('submission' in result.value)) {
            return
          }
          const record = this.context().deps.store.getRecord(params.envelope.sessionId)
          if (record) {
            this.jevShadow.observe(
              {
                sessionId: record.sessionId,
                clientOperationId: result.value.clientMessageId,
                location: { ...record.location }
              },
              capturedText
            )
          }
        })
        .catch(() => undefined)
    }
    return sent
  }

  stop(delivery: { dispose: () => void }, queuedDrain: { dispose: () => void }): void {
    delivery.dispose()
    queuedDrain.dispose()
    this.jevShadow.dispose()
  }

  run = (caller: StructuredAgentSessionCaller, params: ConversationCommandParams) => {
    if (params.command === 'compact') {
      return runStructuredCompaction(this.context(), this.host, caller, params, {
        clearInFlight: this.pending.has(params.envelope.sessionId)
      })
    }
    const key = JSON.stringify([caller.callerKey, params.envelope.clientOperationId])
    const pending = this.pending.get(params.envelope.sessionId)
    if (pending && pending.key !== key) {
      return Promise.resolve({ ok: false as const, refusal: conversationCommandInFlight() })
    }
    const entry = pending ?? { key, count: 0 }
    entry.count++
    this.pending.set(params.envelope.sessionId, entry)
    return runStructuredConversationCommand(this.context(), caller, params).finally(() => {
      if (--entry.count === 0 && this.pending.get(params.envelope.sessionId) === entry) {
        this.pending.delete(params.envelope.sessionId)
      }
      // Refusals may write no row; wake drafts without waiting for an unrelated commit.
      this.context().wakeQueuedDrain?.(params.envelope.sessionId)
    })
  }
}
