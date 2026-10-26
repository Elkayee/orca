import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { LaunchAgentInNewTabArgs } from './launch-agent-in-new-tab'
import { planLaunchAgentStartupPrompt } from './launch-agent-startup-prompt-plan'

const launchAgentInNewTab = vi.hoisted(() => vi.fn())
const writeClipboardText = vi.hoisted(() => vi.fn(async () => undefined))
const ensureDetectedAgentsForWorktree = vi.hoisted(() => vi.fn())
const toast = vi.hoisted(() => ({ error: vi.fn(), success: vi.fn(), warning: vi.fn() }))
const store: {
  settings: { disabledTuiAgents: string[]; experimentalNativeChat?: boolean }
  folderWorkspaces: {
    id: string
    folderPath: string
    projectGroupId: string
    executionHostId: 'local'
  }[]
} = vi.hoisted(() => ({
  settings: { disabledTuiAgents: [] },
  folderWorkspaces: [
    { id: 'project', folderPath: '/project', projectGroupId: 'group', executionHostId: 'local' }
  ]
}))

vi.mock('@/store', () => ({ useAppStore: { getState: () => store } }))
vi.mock('@/lib/launch-agent-in-new-tab', () => ({ launchAgentInNewTab }))
vi.mock('@/lib/agent-catalog', () => ({
  getAgentCatalog: () => [{ id: 'claude', label: 'Claude' }],
  getAgentLabel: (agent: string) => (agent === 'codex' ? 'Codex' : 'Claude')
}))
vi.mock('@/lib/agent-detection-target-inventory', () => ({
  ensureDetectedAgentsForWorktree,
  // A declined chat falls back to a terminal only where the agent's CLI was detected.
  readAgentInventoryForTarget: () => ({ ids: ['claude'], state: 'successful' })
}))
vi.mock('sonner', () => ({ toast }))
vi.mock('./host-chat-program-acquisition', () => ({
  acquireAgentLaunchChoices: async (_: unknown, run: () => unknown) => {
    const detected = await run()
    return { detected, offered: detected }
  }
}))
vi.mock('./host-chat-program', () => ({ agentChoicePending: () => false }))
vi.mock('@/runtime/structured-agent-session-client', () => ({
  callStructuredAgentSession: vi.fn(async () => ({ supported: false, reason: 'wsl' }))
}))
vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string, values?: Record<string, string>) =>
    Object.entries(values ?? {}).reduce(
      (message, [key, value]) => message.replace(`{{${key}}}`, value),
      fallback
    )
}))

describe('launchAgentSessionContinuation', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    store.settings.disabledTuiAgents = []
    ensureDetectedAgentsForWorktree.mockResolvedValue(['claude', 'codex'])
    launchAgentInNewTab.mockReturnValue({
      surface: { kind: 'local-terminal', tabId: 'tab-new' },
      promptDeliveryResult: Promise.resolve({ delivered: true, failureNotified: false })
    })
    writeClipboardText.mockClear()
    vi.stubGlobal('window', {
      api: {
        ui: { writeClipboardText }
      }
    })
  })

  afterEach(() => vi.unstubAllGlobals())

  it('launches any detected target Agent in the same workspace and cwd', async () => {
    const { launchAgentSessionContinuation } = await import('./launch-agent-session-continuation')

    await expect(
      launchAgentSessionContinuation({
        agent: 'claude',
        prompt: 'continue the unfinished task',
        worktreeId: 'wt-1',
        groupId: 'group-1',
        initialCwd: '/repo/worktree/packages/app',
        launchSource: 'terminal_context_menu'
      })
    ).resolves.toBe(true)

    expect(launchAgentInNewTab).toHaveBeenCalledWith(
      expect.objectContaining({
        agent: 'claude',
        worktreeId: 'wt-1',
        groupId: 'group-1',
        initialCwd: '/repo/worktree/packages/app',
        promptDelivery: 'draft'
      })
    )
  })

  it("detects the target Agent in the workspace host's inventory", async () => {
    const { detectAgentSessionContinuationAgents } =
      await import('./launch-agent-session-continuation')

    const { detected } = await detectAgentSessionContinuationAgents('wt-1')
    expect(detected).toEqual(['claude', 'codex'])
    expect(ensureDetectedAgentsForWorktree).toHaveBeenCalledWith(store, 'wt-1')
  })

  it('carries a lossless single-line Codex handoff through native startup on every platform', async () => {
    const { launchAgentSessionContinuation } = await import('./launch-agent-session-continuation')
    const samples = [
      'one\ntwo\r\nthree',
      'Tiếng Việt 😀\n```js\nconst x = "quoted"\n```',
      'C:\\folder\\file\rterminal\u001b[201~',
      '\n\n'
    ]
    for (const platform of ['win32', 'darwin', 'linux'] as const) {
      for (const prompt of samples) {
        launchAgentInNewTab.mockImplementation((args: LaunchAgentInNewTabArgs) => {
          expect(args.promptDelivery).toBe('auto-submit')
          expect(args.prompt).toMatch(/^JSON: /)
          if (!args.prompt || !args.promptDelivery) {
            throw new Error('Missing handoff prompt')
          }
          expect(args.prompt).not.toMatch(/[\r\n]/)
          expect(JSON.parse(args.prompt.slice('JSON: '.length))).toBe(prompt)
          const plan = planLaunchAgentStartupPrompt({
            base: { agent: args.agent, cmdOverrides: {}, platform },
            prompt: args.prompt,
            promptDelivery: args.promptDelivery,
            isFollowupPath: false
          })
          expect(plan.pasteDraftAfterLaunch).toBeNull()
          expect(plan.submitPastedPrompt).toBe(false)
          expect(plan.startupPlan?.startupCommandDelivery).toBe('shell-ready')
          expect(plan.startupPlan?.launchCommand).toContain('JSON: ')
          expect(plan.startupPlan?.launchCommand).not.toMatch(/[\r\n]/)
          return { surface: { kind: 'local-terminal', tabId: 'tab-new' } }
        })
        await expect(
          launchAgentSessionContinuation({
            agent: 'codex',
            prompt,
            worktreeId: 'folder:project',
            initialCwd: '/project',
            launchSource: 'sidebar'
          })
        ).resolves.toBe(true)
      }
    }
  })

  it('keeps other providers on their existing delivery path with the original text', async () => {
    const { launchAgentSessionContinuation } = await import('./launch-agent-session-continuation')
    ensureDetectedAgentsForWorktree.mockResolvedValue(['claude', 'antigravity'])
    for (const agent of ['claude', 'antigravity'] as const) {
      await launchAgentSessionContinuation({
        agent,
        prompt: 'unchanged\nmultiline context',
        worktreeId: 'wt-1',
        launchSource: 'sidebar'
      })
      expect(launchAgentInNewTab).toHaveBeenLastCalledWith(
        expect.objectContaining({
          agent,
          prompt: 'unchanged\nmultiline context',
          promptDelivery: agent === 'claude' ? 'draft' : 'submit-after-ready'
        })
      )
    }
  })

  it('stops before launch when the selected Agent is unavailable', async () => {
    ensureDetectedAgentsForWorktree.mockResolvedValue(['claude'])
    const { launchAgentSessionContinuation } = await import('./launch-agent-session-continuation')

    await expect(
      launchAgentSessionContinuation({
        agent: 'codex',
        prompt: 'continue',
        worktreeId: 'wt-1',
        launchSource: 'sidebar'
      })
    ).resolves.toBe(false)

    expect(launchAgentInNewTab).not.toHaveBeenCalled()
    expect(toast.error).toHaveBeenCalledWith('Codex was not detected on this workspace host.')
  })

  it('distinguishes prompt delivery failure from terminal launch failure', async () => {
    launchAgentInNewTab.mockReturnValue({
      surface: { kind: 'local-terminal', tabId: 'tab-new' },
      promptDeliveryResult: Promise.resolve({ delivered: false, failureNotified: false })
    })
    const { launchAgentSessionContinuation } = await import('./launch-agent-session-continuation')

    await launchAgentSessionContinuation({
      agent: 'codex',
      prompt: 'continue',
      worktreeId: 'wt-1',
      launchSource: 'sidebar'
    })

    expect(launchAgentInNewTab).toHaveBeenCalledWith(
      expect.objectContaining({ agent: 'codex', promptDelivery: 'auto-submit' })
    )
    await vi.waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(
        'The new Codex session started, but its context could not be sent.',
        expect.objectContaining({ action: expect.objectContaining({ label: 'Copy prompt' }) })
      )
    )
  })

  it('hedges instead of claiming success when the paste went out unconfirmed', async () => {
    // Windows may force blind paste; do not report a handoff delivered when its composer was never observed (#22479).
    launchAgentInNewTab.mockImplementation(
      (args: {
        onPromptDelivered?: () => void
        onPromptDeliveryUnconfirmed?: () => void
      }): unknown => {
        args.onPromptDeliveryUnconfirmed?.()
        args.onPromptDelivered?.()
        return {
          surface: { kind: 'local-terminal', tabId: 'tab-new' },
          promptDeliveryResult: Promise.resolve({ delivered: true, failureNotified: false })
        }
      }
    )
    const { launchAgentSessionContinuation } = await import('./launch-agent-session-continuation')

    await launchAgentSessionContinuation({
      agent: 'codex',
      prompt: 'continue the unfinished task',
      worktreeId: 'wt-1',
      launchSource: 'sidebar'
    })

    expect(toast.success).not.toHaveBeenCalled()
    expect(toast.warning).toHaveBeenCalledWith(
      'Orca could not confirm Codex received the session context. Check the new session, and paste it yourself if its input is empty.',
      expect.objectContaining({ action: expect.objectContaining({ label: 'Copy prompt' }) })
    )
    toast.warning.mock.calls[0][1].action.onClick()
    expect(writeClipboardText).toHaveBeenCalledWith('continue the unfinished task')
  })

  it('still reports a confirmed delivery as a success', async () => {
    launchAgentInNewTab.mockImplementation((args: { onPromptDelivered?: () => void }): unknown => {
      args.onPromptDelivered?.()
      return {
        surface: { kind: 'local-terminal', tabId: 'tab-new' },
        promptDeliveryResult: Promise.resolve({ delivered: true, failureNotified: false })
      }
    })
    const { launchAgentSessionContinuation } = await import('./launch-agent-session-continuation')

    await launchAgentSessionContinuation({
      agent: 'codex',
      prompt: 'continue',
      worktreeId: 'wt-1',
      launchSource: 'sidebar'
    })

    expect(toast.success).toHaveBeenCalledWith('Session context sent to Codex in a new session.')
    expect(toast.warning).not.toHaveBeenCalled()
  })
})

it('retains the accepted route across detection, and explicit chat declines without the preference fallback', async () => {
  const { launchAgentSessionContinuation } = await import('./launch-agent-session-continuation')
  const { beginHostAdmittedStructuredLaunch } =
    await import('./structured-agent-session-launch-admission')
  for (const requestedSurface of [undefined, 'chat'] as const) {
    const detected = Promise.withResolvers<string[]>()
    ensureDetectedAgentsForWorktree.mockReturnValueOnce(detected.promise)
    const pending = launchAgentSessionContinuation({
      agent: 'claude',
      prompt: 'continue',
      worktreeId: 'wt-1',
      groupId: 'group-1',
      initialCwd: '/repo/.',
      launchSource: 'sidebar',
      launchChoice: {
        agent: 'claude',
        route: 'structured-native-chat',
        executionHostId: 'local',
        requestedSurface
      }
    })
    store.settings.experimentalNativeChat = false
    detected.resolve(['claude'])
    await pending
    const args = launchAgentInNewTab.mock.calls.at(-1)?.[0]
    expect(args).toMatchObject({
      initialCwd: '/repo/.',
      groupId: 'group-1',
      prompt: 'continue',
      agentSessionLaunchPlan: { route: 'structured-native-chat', requestedSurface }
    })
    const fallback = vi.fn(() => ({ opened: true }))
    const launch = beginHostAdmittedStructuredLaunch({
      plan: args.agentSessionLaunchPlan,
      hooks: {},
      worktreeId: 'wt-1',
      executionHostId: 'local',
      target: { kind: 'local' },
      openAdmitted: vi.fn(),
      onHostDeclined: fallback
    })
    await expect(launch.settlement).resolves.toMatchObject({
      kind: requestedSurface ? 'failed' : 'terminal'
    })
    expect(fallback).toHaveBeenCalledTimes(requestedSurface ? 0 : 1)
  }
})
