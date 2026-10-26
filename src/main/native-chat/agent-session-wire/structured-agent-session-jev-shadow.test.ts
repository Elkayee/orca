import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, resolve } from 'node:path'
import type { AgentJournalMessageItem } from '../../../shared/agent-session-journal-types'
import { JevActionShadow } from '../jev-action-shadow'
import { closeTestJournalHostDatabase } from '../agent-session-journal/journal-host-database-test-support'
import {
  createQueuedMessageTestRig,
  type QueuedMessageTestRig
} from './structured-agent-session-queued-message-rig.test-fixture'
import {
  attach,
  CALLER,
  envelope,
  hostTestState
} from './structured-agent-session-host-test-harness'
import {
  hostTestMessage,
  HOST_TEST_SESSION as SESSION,
  HOST_TEST_LOCATION
} from './structured-agent-session-host-test-data'

function response() {
  return new Response(
    JSON.stringify({
      model: 'jev-1.13.0',
      answers: {
        action: {
          type: 'choice',
          choice: 'runtime_status',
          confidence: 1,
          probabilities: {
            runtime_status: 1,
            repo_list: 0,
            worktree_list: 0,
            worker_output: 0,
            ordinary_agent: 0,
            clarification: 0,
            unsupported: 0
          }
        },
        target: {
          type: 'choice',
          choice: 'target_0',
          confidence: 1,
          probabilities: { target_0: 1 }
        }
      },
      usage: { input_tokens: 123, output_tokens: 8 }
    })
  )
}

let request = vi.fn<typeof fetch>()
let queuedRig: QueuedMessageTestRig | undefined

beforeEach(() => {
  vi.stubEnv('ORCA_JEV_MODE', 'off')
  vi.stubEnv('ORCA_JEV_DIAGNOSTICS', '0')
  vi.stubEnv('TYPESAFE_API_KEY', 'sentinel-host-key')
  request = vi.fn<typeof fetch>(async () => response())
  vi.stubGlobal('fetch', request)
})

afterEach(async () => {
  const rig = queuedRig
  queuedRig = undefined
  if (rig) {
    await rig.host.flushAllStreamedEvents()
    closeTestJournalHostDatabase(rig.root)
    const directory = resolve(rig.root)
    expect(dirname(directory)).toBe(resolve(tmpdir()))
    expect(basename(directory)).toMatch(/^orca-queued-messages-/)
    await rm(directory, { recursive: true, force: true })
  }
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

function message(text = 'sentinel-user-text: show runtime status') {
  const body = hostTestMessage(text)
  return { body, envelope: envelope('agentSession.send', { body }), userSend: true as const }
}

describe('local native-chat Jev shadow observation', () => {
  it.each([undefined, 'off', '', 'read_only', 'unrecognized'])(
    'preserves provider sends without observation in mode %j',
    async (mode) => {
      vi.stubEnv('ORCA_JEV_MODE', mode)
      const { host, dispatch } = hostTestState()
      await attach()
      const initial = message()
      const options = { model: 'model-a', effort: 'low' }
      const sent = {
        ...initial,
        options,
        envelope: envelope('agentSession.send', { body: initial.body, options })
      }
      const result = await host.send(CALLER, sent)
      expect(result.ok).toBe(true)
      await vi.waitFor(() => expect(dispatch).toHaveBeenCalledOnce())
      expect(request).not.toHaveBeenCalled()
    }
  )

  it('observes the accepted plain text once while retaining provider send and durable replay', async () => {
    vi.stubEnv('ORCA_JEV_MODE', 'shadow')
    const { host, dispatch, log } = hostTestState()
    await attach()
    const initial = message()
    const options = { model: 'model-a', effort: 'low' }
    const sent = {
      ...initial,
      options,
      envelope: envelope('agentSession.send', { body: initial.body, options })
    }
    const first = await host.send(CALLER, sent)
    expect(first).toMatchObject({
      ok: true,
      replayed: false,
      value: { clientMessageId: sent.envelope.clientOperationId }
    })
    await vi.waitFor(() => expect(request).toHaveBeenCalledOnce())
    const replay = await host.send(CALLER, sent)
    expect(replay).toMatchObject({
      ok: true,
      replayed: true,
      value: { clientMessageId: sent.envelope.clientOperationId }
    })
    expect(dispatch).toHaveBeenCalledOnce()
    expect(dispatch.mock.calls[0]?.[0].body).toEqual(sent.body)
    expect(dispatch.mock.calls[0]?.[0].executionOptions).toEqual(options)
    expect(request).toHaveBeenCalledOnce()
    const body = request.mock.calls[0]?.[1]?.body
    if (typeof body !== 'string') {
      throw new Error('Expected a captured JSON request')
    }
    expect(JSON.parse(body)).toMatchObject({
      state: { request: sent.body.blocks[0].type === 'text' ? sent.body.blocks[0].text : '' }
    })
    expect(log.entries.filter((entry) => entry.fields.scope === 'jev.shadow')).toEqual([])
  })

  it('settles sends and the next mutation while classification is still pending', async () => {
    vi.stubEnv('ORCA_JEV_MODE', 'shadow')
    request.mockImplementation(
      async (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), {
            once: true
          })
        })
    )
    const { host, dispatch } = hostTestState()
    await attach()
    const first = message('first plain request')
    expect((await host.send(CALLER, first)).ok).toBe(true)
    await vi.waitFor(() => expect(request).toHaveBeenCalledOnce())
    const second = message('second plain request')
    expect((await host.send(CALLER, second)).ok).toBe(true)
    await vi.waitFor(() => expect(dispatch).toHaveBeenCalledTimes(2))
    expect(
      await host.waitForSendSettlement(SESSION, first.envelope.clientOperationId, {
        until: 'answered',
        budgetMs: 100
      })
    ).toMatchObject({
      value: { clientMessageId: first.envelope.clientOperationId }
    })
  })

  const specialized: AgentJournalMessageItem[] = [
    hostTestMessage('/help'),
    { ...hostTestMessage('a skill request'), skills: [{ name: 'picked', path: 'SKILL.md' }] },
    {
      ...hostTestMessage('an image'),
      blocks: [{ type: 'image-ref', url: 'https://example.invalid/image.png' }]
    },
    { ...hostTestMessage('a goal'), sentAs: 'goal' }
  ]
  it.each(specialized)(
    'keeps specialized accepted payload %# on the provider path',
    async (body) => {
      vi.stubEnv('ORCA_JEV_MODE', 'shadow')
      const { host, dispatch } = hostTestState()
      await attach()
      const sent = {
        body,
        envelope: envelope('agentSession.send', { body }),
        userSend: true as const
      }
      expect((await host.send(CALLER, sent)).ok).toBe(true)
      await vi.waitFor(() => expect(dispatch).toHaveBeenCalledOnce())
      expect(dispatch.mock.calls[0]?.[0].body).toEqual(body)
      expect(request).not.toHaveBeenCalled()
    }
  )

  it('does not observe a host-origin send', async () => {
    vi.stubEnv('ORCA_JEV_MODE', 'shadow')
    const { host, dispatch } = hostTestState()
    await attach()
    const { userSend: _origin, ...sent } = message()
    expect((await host.send(CALLER, sent)).ok).toBe(true)
    await vi.waitFor(() => expect(dispatch).toHaveBeenCalledOnce())
    expect(request).not.toHaveBeenCalled()
  })

  it('preserves the accepted explicit command journal entry without observing it', async () => {
    vi.stubEnv('ORCA_JEV_MODE', 'shadow')
    const { host } = hostTestState()
    await attach()
    const body: AgentJournalMessageItem = {
      ...hostTestMessage('a command'),
      command: { name: 'help' }
    }
    expect(
      (
        await host.send(CALLER, {
          body,
          envelope: envelope('agentSession.send', { body }),
          userSend: true
        })
      ).ok
    ).toBe(true)
    const journal = await host.journalSnapshot(SESSION)
    expect(
      journal.items.some(
        (item) => item.body.kind === 'message' && item.body.command?.name === 'help'
      )
    ).toBe(true)
    expect(request).not.toHaveBeenCalled()
  })

  it('does not observe a rejected operation or a superseded explicit continuation', async () => {
    vi.stubEnv('ORCA_JEV_MODE', 'shadow')
    const { host, dispatch } = hostTestState()
    await attach()
    const sent = message()
    expect(
      (
        await host.send(CALLER, {
          ...sent,
          envelope: { ...sent.envelope, payloadFingerprint: 'invalid' }
        })
      ).ok
    ).toBe(false)
    const body = hostTestMessage('continue')
    const fields = { body, usageLimitContinuationOfTurnItemId: 'superseded-turn' }
    expect(
      (
        await host.send(CALLER, {
          ...fields,
          envelope: envelope('agentSession.send', fields),
          userSend: true
        })
      ).ok
    ).toBe(false)
    expect(dispatch).not.toHaveBeenCalled()
    expect(request).not.toHaveBeenCalled()
  })

  it('does not observe the queued receipt behind an active provider turn', async () => {
    vi.stubEnv('ORCA_JEV_MODE', 'shadow')
    queuedRig = await createQueuedMessageTestRig()
    await queuedRig.workingSend()
    await vi.waitFor(() => expect(request).toHaveBeenCalledOnce())
    const queued = queuedRig.send('queued text', 'queue-if-active')
    expect(await queued.result).toMatchObject({ ok: true, value: { queued: { state: 'waiting' } } })
    expect(queuedRig.dispatch).toHaveBeenCalledOnce()
    expect(request).toHaveBeenCalledOnce()
  })

  it('keeps a classifier outage on the original send path without a retry', async () => {
    vi.stubEnv('ORCA_JEV_MODE', 'shadow')
    request.mockImplementation(async () => {
      throw new Error('sentinel-host-key: sentinel-user-text')
    })
    const { host, dispatch, log } = hostTestState()
    await attach()
    const sent = message()
    expect((await host.send(CALLER, sent)).ok).toBe(true)
    await vi.waitFor(() => expect(request).toHaveBeenCalledOnce())
    expect(await host.send(CALLER, sent)).toMatchObject({ ok: true, replayed: true })
    expect(dispatch).toHaveBeenCalledOnce()
    expect(request).toHaveBeenCalledOnce()
    expect(log.entries.filter((entry) => entry.fields.scope === 'jev.shadow')).toEqual([])
  })

  it('reports only opt-in metadata, including the accepted operation identity', async () => {
    vi.stubEnv('ORCA_JEV_MODE', 'shadow')
    vi.stubEnv('ORCA_JEV_DIAGNOSTICS', '1')
    const { host, log } = hostTestState()
    await attach()
    const sent = message('sentinel-user-text / sentinel-worker-output')
    expect((await host.send(CALLER, sent)).ok).toBe(true)
    await vi.waitFor(() =>
      expect(log.entries.filter((entry) => entry.fields.scope === 'jev.shadow')).toHaveLength(1)
    )
    const diagnostic = log.entries.filter((entry) => entry.fields.scope === 'jev.shadow')
    expect(diagnostic[0]?.fields).toMatchObject({
      sessionId: SESSION,
      clientOperationId: sent.envelope.clientOperationId,
      status: 'evaluated',
      action: 'runtime_status',
      model: 'jev-1.13.0',
      inputTokens: 123,
      outputTokens: 8
    })
    expect(JSON.stringify(diagnostic)).not.toMatch(/sentinel|blocks|workspaceId|arguments|"args"/)
  })

  it('contains a failing diagnostic recorder after provider acceptance', async () => {
    vi.stubEnv('ORCA_JEV_MODE', 'shadow')
    vi.stubEnv('ORCA_JEV_DIAGNOSTICS', '1')
    const { host, dispatch } = hostTestState()
    const report = vi.spyOn(host.deps.logger, 'warn').mockImplementation(() => {
      throw new Error('recorder unavailable')
    })
    await attach()
    expect((await host.send(CALLER, message())).ok).toBe(true)
    await vi.waitFor(() => expect(report).toHaveBeenCalledOnce())
    expect(dispatch).toHaveBeenCalledOnce()
  })

  it('cancels only the observer-owned request when host delivery stops', async () => {
    vi.stubEnv('ORCA_JEV_MODE', 'shadow')
    request.mockImplementation(
      async (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), {
            once: true
          })
        })
    )
    const { host, dispatch, cancelTurn } = hostTestState()
    await attach()
    expect((await host.send(CALLER, message())).ok).toBe(true)
    await vi.waitFor(() => expect(request).toHaveBeenCalledOnce())
    host.stopDelivery()
    expect(request.mock.calls[0]?.[1]?.signal?.aborted).toBe(true)
    expect(dispatch).toHaveBeenCalledOnce()
    expect(cancelTurn).not.toHaveBeenCalled()
  })
})

function identity(clientOperationId: string): Parameters<JevActionShadow['observe']>[0] {
  return {
    sessionId: SESSION,
    clientOperationId,
    location: { ...HOST_TEST_LOCATION, workspaceKind: 'folder' }
  }
}

describe('bounded shadow observer ownership', () => {
  it('captures an immutable bounded text copy without retaining message blocks', async () => {
    vi.stubEnv('ORCA_JEV_MODE', 'shadow')
    const observer = new JevActionShadow(() => {})
    const body = hostTestMessage('original text')
    const text = observer.capture(body)
    if (text === undefined || body.blocks[0].type !== 'text') {
      throw new Error('Expected captured plain text')
    }
    body.blocks[0].text = 'mutated text'
    observer.observe(identity('immutable'), text)
    await vi.waitFor(() => expect(request).toHaveBeenCalledOnce())
    const payload = request.mock.calls[0]?.[1]?.body
    if (typeof payload !== 'string') {
      throw new Error('Expected a JSON payload')
    }
    expect(JSON.parse(payload)).toMatchObject({ state: { request: 'original text' } })
    expect(observer.capture(hostTestMessage('x'.repeat(70_000)))).toBeUndefined()
    observer.dispose()
  })

  it('excludes WSL and remote locations while accepting its native local control', async () => {
    vi.stubEnv('ORCA_JEV_MODE', 'shadow')
    const observer = new JevActionShadow(() => {})
    const remote = identity('remote')
    remote.location.executionHostId = 'ssh:remote'
    observer.observe(remote, 'remote request')
    const wsl = identity('wsl')
    wsl.location.wslDistro = 'Ubuntu'
    observer.observe(wsl, 'WSL request')
    observer.observe(identity('local'), 'local request')
    await vi.waitFor(() => expect(request).toHaveBeenCalledOnce())
    observer.dispose()
  })

  it('bounds concurrent work, prevents new off/stopped work and cancels every owned request', async () => {
    vi.stubEnv('ORCA_JEV_MODE', 'shadow')
    request.mockImplementation(
      async (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), {
            once: true
          })
        })
    )
    const observer = new JevActionShadow(() => {})
    try {
      for (let i = 0; i < 8; i++) {
        observer.observe(identity(`operation-${i}`), 'pending request')
      }
      await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(4))
      vi.stubEnv('ORCA_JEV_MODE', 'off')
      observer.observe(identity('off'), 'off request')
      expect(request).toHaveBeenCalledTimes(4)
      observer.dispose()
      expect(request.mock.calls.every(([, init]) => init?.signal?.aborted)).toBe(true)
      vi.stubEnv('ORCA_JEV_MODE', 'shadow')
      observer.observe(identity('stopped'), 'stopped request')
      expect(request).toHaveBeenCalledTimes(4)
    } finally {
      observer.dispose()
    }
  })
})
