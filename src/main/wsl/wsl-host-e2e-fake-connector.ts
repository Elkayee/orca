/** ORCA_E2E_FAKE_WSL_HOSTS maps fake distros directly to a headless server pairing so any CI OS can test WSL host UI without wsl.exe. */
import { appendFileSync, readFileSync } from 'node:fs'
import { z } from 'zod'
import { parsePairingCode } from '../../shared/pairing'
import type { WslHostConnector } from './wsl-host-service'
import type { WslOrcadConnection, WslOrcadConnectionDependencies } from './wsl-orcad-connection'
import { defaultWslOrcadEnvironmentId } from './wsl-orcad-deploy'
import {
  stopWslHostServer,
  wslHostRuntimeStopSteps,
  type WslHostRuntimeAccess
} from './wsl-host-server-stop'

const FakeDistrosSchema = z.array(
  z.object({
    name: z.string().min(1),
    state: z.enum(['running', 'stopped']),
    version: z.union([z.literal(1), z.literal(2)])
  })
)

const FakeWslHostsSchema = z.object({
  distros: FakeDistrosSchema,
  /** Re-read on every listing, so a test can register a distro while the app runs. */
  distrosFile: z.string().optional(),
  pairingCode: z.string().min(1),
  /** Each distro the fake is asked to start, one per line, so e2e can prove nothing respawns. */
  connectLogFile: z.string().optional(),
  /** `missing` stands in for a build shipped without the orcad template. */
  serverFiles: z.enum(['present', 'missing']).optional()
})

export function readFakeWslHostsConfig(
  raw = process.env.ORCA_E2E_FAKE_WSL_HOSTS
): z.infer<typeof FakeWslHostsSchema> | null {
  if (!raw) {
    return null
  }
  return FakeWslHostsSchema.parse(JSON.parse(raw))
}

export function createFakeWslHostConnector(
  config: z.infer<typeof FakeWslHostsSchema>,
  onChange: NonNullable<WslOrcadConnectionDependencies['onChange']>,
  options: { isKnownDistro: (distro: string) => boolean; runtime: WslHostRuntimeAccess }
): WslHostConnector {
  const offer = parsePairingCode(config.pairingCode)
  const port = offer ? Number(new URL(offer.endpoint).port) : 0
  const active = new Map<string, WslOrcadConnection>()
  const key = (distro: string): string => distro.toLowerCase()
  const readDistros = () =>
    config.distrosFile
      ? FakeDistrosSchema.parse(JSON.parse(readFileSync(config.distrosFile, 'utf8')))
      : config.distros
  // Why: a test marks a distro stopped in distrosFile, which ends its server as a real shutdown would.
  const stoppedSince = (distro: string): boolean => {
    const stopped = readDistros().some(
      (entry) => key(entry.name) === key(distro) && entry.state === 'stopped'
    )
    if (stopped && active.delete(key(distro))) {
      onChange(distro, null, { state: 'distro-stopped', terminals: 'exited', recovering: false })
    }
    return stopped
  }
  const connect = async (distro: string): Promise<WslOrcadConnection> => {
    // Same guard as the real connector: nothing starts for a host that is gone.
    if (!options.isKnownDistro(distro)) {
      throw new Error(`${distro} is no longer a WSL host; Orca will not start anything for it.`)
    }
    if (config.connectLogFile) {
      appendFileSync(config.connectLogFile, `${distro}\n`)
    }
    onChange(distro, null, { state: 'connecting' })
    const connection: WslOrcadConnection = {
      distro,
      environmentId: defaultWslOrcadEnvironmentId(distro),
      localPort: port,
      remotePort: port,
      fullVersion: 'e2e',
      pid: null,
      pairingOffer: config.pairingCode,
      deferredUpdate: null,
      close: async () => {
        active.delete(key(distro))
      }
    }
    active.set(key(distro), connection)
    onChange(distro, connection, { state: 'ready', census: null })
    return connection
  }
  return {
    listDistros: async () =>
      readDistros().map((distro, index) => ({
        ...distro,
        id: `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`
      })),
    readOrcadPublicKey: async () => null,
    connect,
    get: (distro) => active.get(key(distro)) ?? null,
    isReachable: async (distro) => !stoppedSince(distro) && active.has(key(distro)),
    isSettling: () => false,
    // A running fake distro without a server is reachable by a reconnect.
    reachability: async (distro) =>
      stoppedSince(distro) ? 'stopped' : active.has(key(distro)) ? 'available' : 'unreachable',
    disconnect: async (distro) => {
      if (active.delete(key(distro))) {
        onChange(distro, null, { state: 'closed' })
      }
    },
    // Use real terminal RPCs against the headless fixture server for removal proof; fake only decommission.
    stopServer: async (distro, environmentId) => {
      // As the real connector: the fake distro always runs, so an unbridged server is reconnected
      // to stop it, rather than read as stopped (a re-enable connects nothing since E9).
      if (!active.get(key(distro))) {
        await connect(distro)
      }
      return stopWslHostServer({
        ...wslHostRuntimeStopSteps(options.runtime, environmentId),
        closeBridge: async () => {
          if (active.delete(key(distro))) {
            onChange(distro, null, { state: 'closed' })
          }
        },
        decommission: async () => ({
          outcome: 'decommissioned',
          version: 'e2e',
          retirement: 'retired'
        })
      })
    },
    resolveDistroName: async (distro) => distro,
    releaseHolder: async () => {},
    adoptHolders: async () => {},
    dispose: async () => {
      active.clear()
    }
  }
}
