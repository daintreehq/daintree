import { generateProjectId } from "./projectStorePaths.js";

/**
 * Per-project poll-lease service. One workspace-host per project is elected as
 * the active poller; siblings short-circuit `checkForPRs()` and rely on the
 * shared PR events the elected host emits through the existing main → renderer
 * fan-out. This is Layer 2 of the cross-window dedup pair (#9055): Layer 1 is
 * the singleflight at `forgeRpcServer.dispatchForgeRpc` that collapses any
 * concurrent identical RPC calls that still cross the boundary.
 *
 * The lease lives in the main process — the workspace-host UtilityProcess
 * can't share state with peers, and we deliberately don't run it on a renderer
 * because `electron-store` is main-only (#8316).
 */

// TTL is the safety net for a crashed or wedged holder: the next poll attempt
// from any peer will acquire after this elapses. 90s = 3× FOCUSED_POLL_INTERVAL_MS
// (the workspace-host's active poll cadence). A healthy holder renews every 30s
// so the lease never expires under it; a holder that misses three polls in a
// row is presumed dead and a sibling takes over. Static, not wired to
// ResourceProfileService — the forge layer must not cross subsystem boundaries
// for resource tuning (#4629).
export const FORGE_POLL_LEASE_TTL_MS = 90_000;

interface PollLease {
  holderId: string;
  expiresAt: number;
}

const leases = new Map<string, PollLease>();

/**
 * Try to acquire (or renew) the lease for `projectPath`. Returns `true` when
 * the caller now holds the lease, `false` when a different live holder owns
 * it. The current holder always succeeds in renewing — that's the happy-path
 * branch for the elected workspace-host's regular poll cycle.
 *
 * `now` is injectable for tests; defaults to `Date.now()`.
 */
export function acquirePollLease(
  projectPath: string,
  holderId: string,
  now: number = Date.now()
): boolean {
  const key = generateProjectId(projectPath);
  const existing = leases.get(key);
  if (existing && existing.holderId !== holderId && existing.expiresAt > now) {
    return false;
  }
  leases.set(key, { holderId, expiresAt: now + FORGE_POLL_LEASE_TTL_MS });
  return true;
}

/**
 * Release the lease only if held by `holderId`. A no-op when the lease has
 * already expired, been preempted, or never existed — so a stale release from
 * a host that just lost the lease never frees a sibling's fresh acquisition.
 */
export function releasePollLease(projectPath: string, holderId: string): void {
  const key = generateProjectId(projectPath);
  const existing = leases.get(key);
  if (existing && existing.holderId === holderId) {
    leases.delete(key);
  }
}

/**
 * Drop every lease this holder owns. Called from `WorkspaceHostProcess.dispose`
 * so a closing window's leases are immediately reclaimable by siblings
 * regardless of whether the cooperative release event landed. A crashed host
 * gets the same treatment via the exit handler.
 */
export function releaseAllLeasesForHolder(holderId: string): void {
  for (const [key, lease] of leases) {
    if (lease.holderId === holderId) {
      leases.delete(key);
    }
  }
}

/** Test-only reset. */
export function _resetForgePollLeasesForTests(): void {
  leases.clear();
}
