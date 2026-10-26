import { describe, expect, it } from 'vitest'
import { createJevActionCatalog, type JevCatalogSnapshot } from './jev-action-catalog'

function snapshot() {
  return {
    targets: [
      { hostId: 'host-local', workspaceId: 'folder-not-a-worktree', workers: ['dispatch-alpha'] },
      { hostId: 'host-remote', workspaceId: 'workspace-beta', workers: ['dispatch-beta'] }
    ]
  } satisfies JevCatalogSnapshot
}

const actionProbabilities = {
  runtime_status: 0,
  repo_list: 0,
  worktree_list: 0,
  worker_output: 1,
  ordinary_agent: 0,
  clarification: 0,
  unsupported: 0
}

function workerResponse() {
  return {
    action: { choice: 'worker_output', probabilities: { ...actionProbabilities } },
    target: { choice: 'target_0', probabilities: { target_0: 1, target_1: 0 } },
    worker: { choice: 'worker_0', probabilities: { worker_0: 1, worker_1: 0 } }
  }
}

describe('Jev closed proposal catalog', () => {
  it('binds a worker proposal to the explicitly selected known dispatch and folder workspace', () => {
    expect(createJevActionCatalog(snapshot()).validate(workerResponse())).toEqual({
      kind: 'proposal',
      action: 'worker_output',
      args: {
        hostId: 'host-local',
        workspaceId: 'folder-not-a-worktree',
        dispatchId: 'dispatch-alpha'
      }
    })
  })

  it.each(['runtime_status', 'repo_list', 'worktree_list'] as const)(
    'binds %s to the selected host and workspace',
    (action) => {
      const response = workerResponse()
      const result = createJevActionCatalog(snapshot()).validate({
        action: {
          choice: action,
          probabilities: { ...actionProbabilities, worker_output: 0, [action]: 1 }
        },
        target: response.target
      })
      expect(result).toEqual({
        kind: 'proposal',
        action,
        args: { hostId: 'host-local', workspaceId: 'folder-not-a-worktree' }
      })
    }
  )

  it.each(['ordinary_agent', 'clarification', 'unsupported'] as const)(
    'preserves the non-action outcome %s without requiring a target',
    (choice) => {
      expect(
        createJevActionCatalog({ targets: [] }).validate({
          action: {
            choice,
            probabilities: { ...actionProbabilities, worker_output: 0, [choice]: 1 }
          }
        })
      ).toEqual({ kind: choice })
    }
  )

  it.each(['foreign-worker', 'orca status; rm -rf /', 'runtime.status', ''])(
    'rejects an unknown action choice %j',
    (choice) => {
      const response = workerResponse()
      response.action.choice = choice
      expect(createJevActionCatalog(snapshot()).validate(response)).toEqual({ kind: 'invalid' })
    }
  )

  it.each([
    null,
    [],
    {},
    { action: 'worker_output' },
    { action: { choice: 'worker_output' } },
    { ...workerResponse(), command: 'orca status' },
    { ...workerResponse(), action: { ...workerResponse().action, arguments: {} } },
    { ...workerResponse(), hostId: 'foreign-host' },
    { ...workerResponse(), workspaceId: 'foreign-workspace' }
  ])('rejects malformed or additional provider fields: %j', (response) => {
    expect(createJevActionCatalog(snapshot()).validate(response)).toEqual({ kind: 'invalid' })
  })

  it.each([
    undefined,
    null,
    [],
    { worker_output: 1 },
    { ...actionProbabilities, unknown: 0 },
    { ...actionProbabilities, runtime_status: '0' },
    { ...actionProbabilities, runtime_status: Number.NaN },
    { ...actionProbabilities, runtime_status: Infinity },
    { ...actionProbabilities, runtime_status: -0.1 },
    { ...actionProbabilities, worker_output: 1.1 },
    { ...actionProbabilities, worker_output: 0.5 },
    { ...actionProbabilities, runtime_status: 1 }
  ])('rejects incomplete or invalid probability distributions: %j', (probabilities) => {
    expect(
      createJevActionCatalog(snapshot()).validate({
        ...workerResponse(),
        action: { choice: 'worker_output', probabilities }
      })
    ).toEqual({ kind: 'invalid' })
  })

  it.each([Number.NaN, Infinity, -1, 1.1, '0.9', null])(
    'rejects invalid SDK confidence %j',
    (confidence) => {
      expect(
        createJevActionCatalog(snapshot()).validate({ ...workerResponse(), confidence })
      ).toEqual({ kind: 'invalid' })
    }
  )

  it('does not apply a confidence cutoff or confuse confidence with response probabilities', () => {
    const catalog = createJevActionCatalog(snapshot())
    expect(catalog.validate({ ...workerResponse(), confidence: 0 })).toEqual(
      catalog.validate(workerResponse())
    )
    const response = workerResponse()
    response.action.probabilities.worker_output = 0.1
    response.action.probabilities.runtime_status = 0.9
    expect(catalog.validate({ ...response, confidence: 1 }).kind).toBe('proposal')
  })

  it.each([
    { ...workerResponse(), target: undefined },
    { ...workerResponse(), worker: undefined },
    { ...workerResponse(), target: { choice: 'host-foreign', probabilities: {} } },
    {
      ...workerResponse(),
      worker: { choice: 'dispatch-alpha', probabilities: { worker_0: 1, worker_1: 0 } }
    },
    {
      ...workerResponse(),
      worker: { choice: 'foreign-worker', probabilities: { worker_0: 1, worker_1: 0 } }
    },
    {
      ...workerResponse(),
      worker: { choice: 'worker_1', probabilities: { worker_0: 0, worker_1: 1 } }
    },
    {
      ...workerResponse(),
      target: { choice: 'target_1', probabilities: { target_0: 0, target_1: 1 } }
    },
    { ...workerResponse(), target: { choice: 'target_0', probabilities: { target_0: 1 } } },
    {
      ...workerResponse(),
      worker: { choice: 'worker_0', probabilities: { worker_0: 1, worker_1: Number.NaN } }
    }
  ])('rejects absent, foreign, mismatched or malformed target selection: %j', (response) => {
    expect(createJevActionCatalog(snapshot()).validate(response)).toEqual({ kind: 'invalid' })
  })

  it.each([
    { targets: [] },
    { targets: [{ hostId: '', workspaceId: 'workspace', workers: [] }] },
    { targets: [{ hostId: 'host', workspaceId: '  ', workers: [] }] },
    { targets: [{ hostId: 'host', workspaceId: 'workspace', workers: [''] }] },
    {
      targets: [{ hostId: 'host', workspaceId: 'workspace', workers: ['duplicate', 'duplicate'] }]
    },
    { targets: [snapshot().targets[0], snapshot().targets[0]] },
    { targets: [snapshot().targets[0], { ...snapshot().targets[1], workers: ['dispatch-alpha'] }] }
  ])('cannot propose actions from empty or ambiguous required context: %j', (context) => {
    const catalog = createJevActionCatalog(context)
    expect(
      catalog.validate({
        action: {
          choice: 'runtime_status',
          probabilities: { ...actionProbabilities, worker_output: 0, runtime_status: 1 }
        },
        target: {
          choice: 'target_0',
          probabilities:
            context.targets.length === 2 ? { target_0: 1, target_1: 0 } : { target_0: 1 }
        }
      })
    ).toEqual({ kind: 'invalid' })
  })

  it('binds the second known worker to its remote host and workspace', () => {
    expect(
      createJevActionCatalog(snapshot()).validate({
        action: workerResponse().action,
        target: { choice: 'target_1', probabilities: { target_0: 0, target_1: 1 } },
        worker: { choice: 'worker_1', probabilities: { worker_0: 0, worker_1: 1 } }
      })
    ).toEqual({
      kind: 'proposal',
      action: 'worker_output',
      args: { hostId: 'host-remote', workspaceId: 'workspace-beta', dispatchId: 'dispatch-beta' }
    })
  })

  it('rejects a known worker from another workspace on the same host', () => {
    const context = snapshot()
    context.targets[1].hostId = 'host-local'
    expect(
      createJevActionCatalog(context).validate({
        ...workerResponse(),
        worker: { choice: 'worker_1', probabilities: { worker_0: 0, worker_1: 1 } }
      })
    ).toEqual({ kind: 'invalid' })
  })

  it('allows listing in a folder workspace with no known workers but cannot propose worker output', () => {
    const catalog = createJevActionCatalog({
      targets: [{ hostId: 'host-local', workspaceId: 'folder', workers: [] }]
    })
    const target = { choice: 'target_0', probabilities: { target_0: 1 } }
    expect(
      catalog.validate({
        action: {
          choice: 'worktree_list',
          probabilities: { ...actionProbabilities, worker_output: 0, worktree_list: 1 }
        },
        target
      })
    ).toEqual({
      kind: 'proposal',
      action: 'worktree_list',
      args: { hostId: 'host-local', workspaceId: 'folder' }
    })
    expect(catalog.validate({ ...workerResponse(), target })).toEqual({ kind: 'invalid' })
  })

  it('copies caller context and prevents question or proposal mutation from retargeting later validation', () => {
    const context = snapshot()
    const catalog = createJevActionCatalog(context)
    const response = workerResponse()
    const first = catalog.validate(response)
    context.targets[0].hostId = 'foreign-host'
    context.targets[0].workspaceId = 'foreign-workspace'
    context.targets[0].workers[0] = 'foreign-worker'
    context.targets.reverse()
    const questions = catalog.questions
    expect(Reflect.set(questions[0].choices, '0', 'shell command')).toBe(false)
    expect(Reflect.set(questions[1], 'prompt', 'foreign target')).toBe(false)
    expect(Reflect.set(questions, '1', {})).toBe(false)
    if (first.kind !== 'proposal') {
      throw new Error('Expected a proposal')
    }
    expect(Reflect.set(first.args, 'dispatchId', 'foreign-worker')).toBe(false)
    expect(Reflect.set(first, 'args', { hostId: 'foreign-host' })).toBe(false)
    expect(catalog.validate(response)).toEqual({
      kind: 'proposal',
      action: 'worker_output',
      args: {
        hostId: 'host-local',
        workspaceId: 'folder-not-a-worktree',
        dispatchId: 'dispatch-alpha'
      }
    })
  })
})
