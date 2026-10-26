import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { proposeJevAction } from './jev-action-client'

const input = {
  text: 'Read dispatch-alpha output',
  snapshot: {
    targets: [
      { hostId: 'local', workspaceId: 'folder', workers: ['dispatch-alpha'] },
      { hostId: 'remote', workspaceId: 'other', workers: ['dispatch-beta'] }
    ]
  }
}

function reply() {
  return {
    model: 'jev-1.13.0',
    answers: {
      action: {
        type: 'choice',
        choice: 'worker_output',
        confidence: 0.7,
        probabilities: {
          runtime_status: 0,
          repo_list: 0,
          worktree_list: 0,
          worker_output: 1,
          ordinary_agent: 0,
          clarification: 0,
          unsupported: 0
        }
      },
      target: {
        type: 'choice',
        choice: 'target_0',
        confidence: 1,
        probabilities: { target_0: 1, target_1: 0 }
      },
      worker: {
        type: 'choice',
        choice: 'worker_0',
        confidence: 1,
        probabilities: { worker_0: 1, worker_1: 0 }
      }
    },
    usage: { input_tokens: 123, output_tokens: 17 }
  }
}

function serving(body: unknown): typeof fetch {
  return async () => new Response(JSON.stringify(body))
}

beforeEach(() => vi.stubEnv('TYPESAFE_API_KEY', 'sentinel-api-key'))
afterEach(() => {
  vi.unstubAllEnvs()
  vi.useRealTimers()
})

describe('host Jev proposal client', () => {
  it('uses the fixed authenticated endpoint and binds a complete reply to the caller snapshot', async () => {
    let sentUrl: unknown
    let sent: RequestInit | undefined
    const result = await proposeJevAction(input, {
      fetch: async (url, init) => {
        sentUrl = url
        sent = init
        return new Response(JSON.stringify(reply()))
      }
    })
    expect(sentUrl).toBe('https://api.typesafe.ai/v1/systemone')
    expect(sent?.method).toBe('POST')
    expect(sent?.redirect).toBe('error')
    expect(new Headers(sent?.headers).get('authorization')).toBe('Bearer sentinel-api-key')
    if (typeof sent?.body !== 'string') {
      throw new Error('Expected a JSON request body')
    }
    expect(JSON.parse(sent.body)).toMatchObject({
      model: 'jev-1.13.0',
      state: { request: input.text },
      questions: { worker: { type: 'choice', criteria: { worker_0: expect.any(String) } } }
    })
    expect(sent.body).not.toContain('sentinel-api-key')
    expect(result.status).toBe('evaluated')
    if (result.status !== 'evaluated') {
      throw new Error('Expected an evaluated reply')
    }
    expect(result.proposal).toEqual({
      kind: 'proposal',
      action: 'worker_output',
      args: { hostId: 'local', workspaceId: 'folder', dispatchId: 'dispatch-alpha' }
    })
    expect(result.answers.action.confidence).toBe(0.7)
    expect(result.answers.action.probabilities.worker_output).toBe(1)
    expect(result.usage).toEqual({ inputTokens: 123, outputTokens: 17 })
    expect(result.model).toBe('jev-1.13.0')
    expect(result.catalogBinding).toMatch(/^[a-f0-9]{64}$/)
    expect(result.durationMs).toBeGreaterThanOrEqual(0)
    expect(Reflect.set(result.answers.action.probabilities, 'worker_output', 0)).toBe(false)
  })

  it.each([
    null,
    { ...reply(), model: 'jev-latest' },
    { ...reply(), command: 'orca status' },
    { ...reply(), usage: undefined },
    { ...reply(), usage: { input_tokens: -1, output_tokens: 0 } },
    { ...reply(), usage: { input_tokens: 1.5, output_tokens: 0 } },
    { ...reply(), usage: { input_tokens: Number.MAX_SAFE_INTEGER + 1, output_tokens: 0 } },
    { ...reply(), usage: { input_tokens: 1, output_tokens: 0, secret: 'sentinel-body' } },
    { ...reply(), answers: { action: reply().answers.action } },
    { ...reply(), answers: { ...reply().answers, extra: reply().answers.action } },
    {
      ...reply(),
      answers: {
        ...reply().answers,
        worker: { ...reply().answers.worker, choice: 'dispatch-foreign' }
      }
    },
    {
      ...reply(),
      answers: { ...reply().answers, target: { ...reply().answers.target, choice: 'target_1' } }
    },
    {
      ...reply(),
      answers: { ...reply().answers, action: { ...reply().answers.action, confidence: -0.1 } }
    },
    {
      ...reply(),
      answers: {
        ...reply().answers,
        action: { ...reply().answers.action, probabilities: { worker_output: 1 } }
      }
    },
    {
      ...reply(),
      answers: { ...reply().answers, action: { ...reply().answers.action, choice: 'repo_list' } }
    },
    {
      ...reply(),
      answers: {
        ...reply().answers,
        worker: { ...reply().answers.worker, command: 'sentinel-body' }
      }
    },
    {
      ...reply(),
      answers: {
        ...reply().answers,
        target: {
          ...reply().answers.target,
          choice: 'target_1',
          probabilities: { target_0: 0, target_1: 1 }
        }
      }
    },
    {
      ...reply(),
      answers: { ...reply().answers, worker: { ...reply().answers.worker, type: 'score' } }
    },
    {
      ...reply(),
      answers: { ...reply().answers, worker: { ...reply().answers.worker, confidence: null } }
    },
    {
      ...reply(),
      answers: {
        ...reply().answers,
        worker: { ...reply().answers.worker, probabilities: { worker_0: 0.9, worker_1: 0 } }
      }
    },
    {
      ...reply(),
      answers: {
        ...reply().answers,
        worker: { ...reply().answers.worker, probabilities: { worker_0: '1', worker_1: 0 } }
      }
    }
  ])(
    'returns no actionable result for an incomplete, foreign or malformed reply: %j',
    async (body) => {
      const result = await proposeJevAction(input, { fetch: serving(body) })
      expect(result.status).toBe('unevaluated')
      expect(JSON.stringify(result)).not.toMatch(/sentinel-api-key|sentinel-body|dispatch-foreign/)
    }
  )

  it('ignores valid speculative answers for ordinary agent work', async () => {
    const body = reply()
    body.answers.action.choice = 'ordinary_agent'
    body.answers.action.confidence = 0
    body.answers.action.probabilities.worker_output = 0
    body.answers.action.probabilities.ordinary_agent = 1
    const result = await proposeJevAction(input, { fetch: serving(body) })
    expect(result.status === 'evaluated' && result.proposal).toEqual({ kind: 'ordinary_agent' })
  })

  it('omits empty target and worker questions while preserving a non-action outcome', async () => {
    const body = reply()
    const action = {
      ...body.answers.action,
      choice: 'clarification',
      probabilities: { ...body.answers.action.probabilities, worker_output: 0, clarification: 1 }
    }
    const result = await proposeJevAction(
      { text: 'Which one?', snapshot: { targets: [] } },
      {
        fetch: serving({ ...body, answers: { action } })
      }
    )
    expect(result.status === 'evaluated' && result.proposal).toEqual({ kind: 'clarification' })
  })

  it('does not contact the provider without a host key or for oversized input', async () => {
    const request = vi.fn(serving(reply()))
    vi.stubEnv('TYPESAFE_API_KEY', '')
    expect(await proposeJevAction(input, { fetch: request })).toMatchObject({
      status: 'unevaluated',
      reason: 'missing_key'
    })
    vi.stubEnv('TYPESAFE_API_KEY', 'sentinel-api-key')
    expect(
      await proposeJevAction({ ...input, text: 'x'.repeat(70_000) }, { fetch: request })
    ).toMatchObject({
      status: 'unevaluated',
      reason: 'input_limit'
    })
    expect(request).not.toHaveBeenCalled()
  })

  it('cancels an oversized headerless response before allocating or parsing its entire body', async () => {
    let cancelled = false
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(65_537))
      },
      cancel() {
        cancelled = true
      }
    })
    expect(await proposeJevAction(input, { fetch: async () => new Response(body) })).toMatchObject({
      status: 'unevaluated',
      reason: 'response_limit'
    })
    expect(cancelled).toBe(true)
  })

  it('rejects an excessive declared length and cancels its unread response', async () => {
    let cancelled = false
    const body = new ReadableStream<Uint8Array>({
      cancel() {
        cancelled = true
      }
    })
    const result = await proposeJevAction(input, {
      fetch: async () => new Response(body, { headers: { 'content-length': '65537' } })
    })
    expect(result).toMatchObject({ status: 'unevaluated', reason: 'response_limit' })
    expect(cancelled).toBe(true)
  })

  it.each(['not JSON: sentinel-body', `${'{"nested":'.repeat(20)}0${'}'.repeat(20)}`])(
    'rejects invalid or excessively nested JSON',
    async (body) => {
      const result = await proposeJevAction(input, { fetch: async () => new Response(body) })
      expect(result).toMatchObject({ status: 'unevaluated', reason: 'invalid_response' })
      expect(JSON.stringify(result)).not.toContain('sentinel-body')
    }
  )

  it('limits choice counts before generating or sending a request', async () => {
    const request = vi.fn(serving(reply()))
    const result = await proposeJevAction(
      {
        ...input,
        snapshot: {
          targets: [
            {
              hostId: 'local',
              workspaceId: 'folder',
              workers: Array.from({ length: 256 }, (_, i) => `worker-${i}`)
            }
          ]
        }
      },
      { fetch: request }
    )
    expect(result).toMatchObject({ status: 'unevaluated', reason: 'input_limit' })
    expect(request).not.toHaveBeenCalled()
  })

  it('preserves a copied target binding while the request is in flight', async () => {
    const mutable = structuredClone(input)
    const result = await proposeJevAction(mutable, {
      fetch: async () => {
        mutable.snapshot.targets[0].workers[0] = 'dispatch-foreign'
        mutable.snapshot.targets[0].workspaceId = 'foreign-folder'
        return new Response(JSON.stringify(reply()))
      }
    })
    expect(result.status === 'evaluated' && result.proposal).toEqual({
      kind: 'proposal',
      action: 'worker_output',
      args: { hostId: 'local', workspaceId: 'folder', dispatchId: 'dispatch-alpha' }
    })
  })

  it('does not expose transport error text and clears the completed request timer', async () => {
    vi.useFakeTimers()
    const result = await proposeJevAction(input, {
      fetch: async () => {
        throw new Error(`sentinel-api-key ${input.text}`)
      }
    })
    expect(result).toMatchObject({ status: 'unevaluated', reason: 'transport_error' })
    expect(JSON.stringify(result)).not.toMatch(/sentinel|dispatch-alpha/)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('cancels unread HTTP error bodies and returns no provider text or key', async () => {
    let cancelled = false
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('sentinel-body'))
      },
      cancel() {
        cancelled = true
      }
    })
    const result = await proposeJevAction(input, {
      fetch: async () => new Response(body, { status: 401 })
    })
    expect(result).toMatchObject({ status: 'unevaluated', reason: 'http_error' })
    expect(JSON.stringify(result)).not.toMatch(/sentinel/)
    expect(cancelled).toBe(true)
  })

  it('bounds a stalled native fetch with a deadline and releases its timer', async () => {
    vi.useFakeTimers()
    const pending = proposeJevAction(input, {
      fetch: async (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new Error('sentinel-api-key')), {
            once: true
          })
        })
    })
    await vi.advanceTimersByTimeAsync(10_000)
    expect(await pending).toMatchObject({ status: 'unevaluated', reason: 'timeout' })
    expect(vi.getTimerCount()).toBe(0)
  })

  it('keeps the deadline active through response-body consumption', async () => {
    vi.useFakeTimers()
    const pending = proposeJevAction(input, {
      fetch: async (_url, init) =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              init?.signal?.addEventListener(
                'abort',
                () => controller.error(new Error('sentinel-body')),
                { once: true }
              )
            }
          })
        )
    })
    await vi.advanceTimersByTimeAsync(10_000)
    expect(await pending).toMatchObject({ status: 'unevaluated', reason: 'timeout' })
    expect(vi.getTimerCount()).toBe(0)
  })

  it('honors an already aborted caller without reading the network', async () => {
    const request = vi.fn(serving(reply()))
    const signal = AbortSignal.abort()
    expect(await proposeJevAction(input, { fetch: request, signal })).toMatchObject({
      status: 'unevaluated',
      reason: 'cancelled'
    })
    expect(request).not.toHaveBeenCalled()
  })

  it('does not accept a buffered response after caller cancellation', async () => {
    const caller = new AbortController()
    const result = await proposeJevAction(input, {
      signal: caller.signal,
      fetch: async () => {
        caller.abort()
        return new Response(JSON.stringify(reply()))
      }
    })
    expect(result).toMatchObject({ status: 'unevaluated', reason: 'cancelled' })
  })

  it('bounds stalled error-body cleanup within the same overall deadline', async () => {
    vi.useFakeTimers()
    const body = new ReadableStream<Uint8Array>({
      cancel: () => new Promise<void>(() => {})
    })
    const pending = proposeJevAction(input, {
      fetch: async () => new Response(body, { status: 503 })
    })
    let settled: unknown
    void pending.then((result) => {
      settled = result
    })
    await vi.advanceTimersByTimeAsync(10_000)
    expect(settled).toMatchObject({ status: 'unevaluated', reason: 'timeout' })
    expect(vi.getTimerCount()).toBe(0)
  })
})
