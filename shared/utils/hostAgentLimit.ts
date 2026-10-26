/**
 * The ceiling on live agent terminals a host serves across all of its
 * projects, Shells and launch paths (#14704). Taken from the host's own memory,
 * never a Shell's: the panel limits are per view and per machine at the screen,
 * and none of them stops the host's total from outgrowing it.
 */

const GiB = 1024 * 1024 * 1024;

/** Memory left to the OS, Daintree itself and everything else on the host. */
const HOST_RESERVED_GIB = 4;
/**
 * What one agent may grow to with the tools it runs (a compiler, a test
 * runner). Thirteen agents took a 36 GB host down, so the ceiling sits below.
 */
const PER_AGENT_GIB = 3;
const MIN_HOST_AGENT_LIMIT = 2;

export function computeHostAgentLimit(totalMemoryBytes: number): number {
  if (!Number.isFinite(totalMemoryBytes) || totalMemoryBytes <= 0) return MIN_HOST_AGENT_LIMIT;
  const usable = totalMemoryBytes / GiB - HOST_RESERVED_GIB;
  return Math.max(MIN_HOST_AGENT_LIMIT, Math.floor(usable / PER_AGENT_GIB));
}

/** The host's agent count and ceiling, as a launch was judged against them. */
export interface HostAgentLimitSnapshot {
  /** The host as it names itself to people. */
  host: string;
  count: number;
  limit: number;
}

export function describeHostAgentLimit(snapshot: HostAgentLimitSnapshot): string {
  return `${snapshot.host} has reached its limit of ${snapshot.limit} live agent terminals. Close an agent terminal there to launch another.`;
}
