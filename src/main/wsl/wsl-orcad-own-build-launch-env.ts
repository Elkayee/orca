import { hostMallocTunablesLaunchEnv } from '../memory/host-malloc-tunables'
import type { OrcadHostTransport } from '../ssh/orcad-host-transport'

/** An older slot would leak GLIBC_TUNABLES to user shells, so only this build's own slot gets it. */
export function withOwnBuildLaunchEnv(
  conn: OrcadHostTransport,
  ownBuildVersion: () => string | null
): OrcadHostTransport {
  const orcadLaunchEnv: OrcadHostTransport['orcadLaunchEnv'] = async (launch) => [
    ...((await conn.orcadLaunchEnv?.(launch)) ?? []),
    ...(launch.fullVersion === ownBuildVersion() ? hostMallocTunablesLaunchEnv() : [])
  ]
  // Delegate rather than spread: a class-based transport keeps its prototype methods.
  return Object.create(conn, { orcadLaunchEnv: { value: orcadLaunchEnv } })
}
