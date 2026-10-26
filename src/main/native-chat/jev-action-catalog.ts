export type JevCatalogSnapshot = {
  readonly targets: readonly {
    readonly hostId: string
    readonly workspaceId: string
    readonly workers: readonly string[]
  }[]
}

const actionChoices = Object.freeze([
  'runtime_status',
  'repo_list',
  'worktree_list',
  'worker_output',
  'ordinary_agent',
  'clarification',
  'unsupported'
] as const)

type ActionChoice = (typeof actionChoices)[number]
type TargetArgs = Readonly<{ hostId: string; workspaceId: string }>
type CatalogResult =
  | Readonly<{
      kind: 'proposal'
      action: 'runtime_status' | 'repo_list' | 'worktree_list'
      args: TargetArgs
    }>
  | Readonly<{
      kind: 'proposal'
      action: 'worker_output'
      args: TargetArgs & Readonly<{ dispatchId: string }>
    }>
  | Readonly<{ kind: 'ordinary_agent' | 'clarification' | 'unsupported' | 'invalid' }>

type CatalogQuestion = Readonly<{ prompt: string }> &
  (
    | Readonly<{ id: 'action'; choices: readonly ActionChoice[] }>
    | Readonly<{ id: 'target' | 'worker'; choices: readonly string[] }>
  )

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key))
}

function selectedChoice<Choice extends string>(
  value: unknown,
  choices: readonly Choice[]
): Choice | undefined {
  if (!isRecord(value) || !hasKeys(value, ['choice', 'probabilities'])) {
    return undefined
  }
  const choice = choices.find((candidate) => candidate === value.choice)
  const probabilities = value.probabilities
  if (!choice || !isRecord(probabilities) || !hasKeys(probabilities, choices)) {
    return undefined
  }
  let total = 0
  for (const candidate of choices) {
    const probability = probabilities[candidate]
    if (
      typeof probability !== 'number' ||
      !Number.isFinite(probability) ||
      probability < 0 ||
      probability > 1
    ) {
      return undefined
    }
    total += probability
  }
  return Math.abs(total - 1) <= 1e-9 ? choice : undefined
}

export function createJevActionCatalog(snapshot: JevCatalogSnapshot): Readonly<{
  questions: readonly CatalogQuestion[]
  validate: (response: unknown) => CatalogResult
}> {
  const targets = Object.freeze(
    snapshot.targets.map((target) =>
      Object.freeze({ ...target, workers: Object.freeze([...target.workers]) })
    )
  )
  const workers = Object.freeze(
    targets.flatMap((target) =>
      target.workers.map((dispatchId) =>
        Object.freeze({ hostId: target.hostId, workspaceId: target.workspaceId, dispatchId })
      )
    )
  )
  const nonempty = (value: string): boolean => value.length > 0 && value.trim() === value
  const contextValid =
    targets.length > 0 &&
    targets.every(
      (target) =>
        nonempty(target.hostId) && nonempty(target.workspaceId) && target.workers.every(nonempty)
    ) &&
    new Set(targets.map((target) => JSON.stringify([target.hostId, target.workspaceId]))).size ===
      targets.length &&
    new Set(workers.map((worker) => worker.dispatchId)).size === workers.length
  const targetChoices = Object.freeze(targets.map((_, index) => `target_${index}`))
  const workerChoices = Object.freeze(workers.map((_, index) => `worker_${index}`))
  const questions: readonly CatalogQuestion[] = Object.freeze([
    Object.freeze({
      id: 'action',
      prompt:
        'Choose runtime status, repository listing, worktree listing, output of one known worker, ordinary agent work, clarification for ambiguous requests, or unsupported requests. This is a proposal only.',
      choices: actionChoices
    }),
    Object.freeze({
      id: 'target',
      prompt: `For runtime_status, repo_list, worktree_list or worker_output, explicitly select the host/workspace pair: ${JSON.stringify(
        targets.map((target, index) => ({
          choice: targetChoices[index],
          hostId: target.hostId,
          workspaceId: target.workspaceId
        }))
      )}`,
      choices: targetChoices
    }),
    Object.freeze({
      id: 'worker',
      prompt: `For worker_output, explicitly select one known worker belonging to the selected target: ${JSON.stringify(
        workers.map((worker, index) => ({ choice: workerChoices[index], ...worker }))
      )}`,
      choices: workerChoices
    })
  ])
  const invalid: CatalogResult = Object.freeze({ kind: 'invalid' })

  return Object.freeze({
    questions,
    validate(response: unknown): CatalogResult {
      if (!isRecord(response)) {
        return invalid
      }
      const action = selectedChoice(response.action, actionChoices)
      if (!action) {
        return invalid
      }
      const keys = ['action']
      if (Object.hasOwn(response, 'confidence')) {
        const confidence = response.confidence
        if (
          typeof confidence !== 'number' ||
          !Number.isFinite(confidence) ||
          confidence < 0 ||
          confidence > 1
        ) {
          return invalid
        }
        keys.push('confidence')
      }
      if (action === 'ordinary_agent' || action === 'clarification' || action === 'unsupported') {
        return hasKeys(response, keys) ? Object.freeze({ kind: action }) : invalid
      }
      keys.push('target')
      if (action === 'worker_output') {
        keys.push('worker')
      }
      if (!contextValid || !hasKeys(response, keys)) {
        return invalid
      }
      const targetChoice = selectedChoice(response.target, targetChoices)
      const target =
        targetChoice === undefined ? undefined : targets[targetChoices.indexOf(targetChoice)]
      if (!target) {
        return invalid
      }
      const args = { hostId: target.hostId, workspaceId: target.workspaceId }
      if (action === 'worker_output') {
        const workerChoice = selectedChoice(response.worker, workerChoices)
        const worker =
          workerChoice === undefined ? undefined : workers[workerChoices.indexOf(workerChoice)]
        if (
          !worker ||
          worker.hostId !== target.hostId ||
          worker.workspaceId !== target.workspaceId
        ) {
          return invalid
        }
        return Object.freeze({
          kind: 'proposal',
          action,
          args: Object.freeze({ ...args, dispatchId: worker.dispatchId })
        })
      }
      return Object.freeze({ kind: 'proposal', action, args: Object.freeze(args) })
    }
  })
}
