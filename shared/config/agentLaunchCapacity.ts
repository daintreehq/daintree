const GIB = 1024 ** 3;

/**
 * Memory one agent is given when a host works out how many to start at once
 * (#14221). Measured, not chosen: a 36 GB host running 13 to 14 `/work`
 * agents filled its RAM and 11.8 GB of swap, Daintree itself 0.6 GB of that,
 * so each agent's checks peaked near 3.5 GB once they coincided. A raw count
 * of idle agents is cheap; this is what they cost when their checks overlap.
 */
export const AGENT_LAUNCH_BUDGET_BYTES = 4 * GIB;

/** Share of memory kept back for the OS and Daintree itself... */
export const AGENT_LAUNCH_RESERVE_FRACTION = 0.1;
/** ...never more than this, so a large machine isn't left with a fraction-sized hole (#11092). */
export const AGENT_LAUNCH_RESERVE_MAX_BYTES = 4 * GIB;

/**
 * How many agents a host starts before further launches wait: one at least,
 * so a small machine can always run one. Null when total memory is unknown,
 * which never holds a launch.
 */
export function agentLaunchLimit(totalBytes: number | null | undefined): number | null {
  if (typeof totalBytes !== "number" || !Number.isFinite(totalBytes) || totalBytes <= 0) {
    return null;
  }
  const reserve = Math.min(
    totalBytes * AGENT_LAUNCH_RESERVE_FRACTION,
    AGENT_LAUNCH_RESERVE_MAX_BYTES
  );
  return Math.max(1, Math.floor((totalBytes - reserve) / AGENT_LAUNCH_BUDGET_BYTES));
}
