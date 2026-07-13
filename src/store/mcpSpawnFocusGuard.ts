import { logWarn } from "@/utils/logger";

/**
 * Ambient focus-suppression leases for MCP-dispatched actions.
 *
 * The bridge wraps every MCP action dispatch in a lease so panels spawned
 * *indirectly* by the action (handlers that don't thread `focusPolicy`
 * through their args) still resolve to "preserve" and can't steal focus
 * (#6959). Direct spawn actions don't depend on this: `tagMcpSpawnSource`
 * stamps `focusPolicy: "preserve"` on their args explicitly.
 *
 * Leases expire. Main's MCP bridge abandons a dispatch after
 * `MCP_DISPATCH_TIMEOUT_MS` (30s) without cancelling the renderer-side
 * action, so a handler awaiting something unbounded (a confirm dialog, a
 * hung IPC) holds its lease forever. Under the old depth counter that
 * permanently forced "preserve" on every later panel creation in this
 * project view — the dock's launch popover never auto-opened again until
 * the view reloaded. An expired lease stops suppressing but stays tracked
 * until its dispatch settles, so a late settle can only release itself.
 */
const LEASE_TTL_MS = 45_000;

interface SuppressionLease {
  label: string | undefined;
  startedAt: number;
  warned: boolean;
}

let nextLeaseId = 0;
const activeLeases = new Map<number, SuppressionLease>();

export function isMcpSpawnFocusSuppressed(): boolean {
  if (activeLeases.size === 0) return false;
  const now = Date.now();
  let suppressed = false;
  for (const lease of activeLeases.values()) {
    if (now - lease.startedAt < LEASE_TTL_MS) {
      suppressed = true;
    } else if (!lease.warned) {
      lease.warned = true;
      logWarn(
        "[McpSpawnFocusGuard] Focus-suppression lease outlived the MCP dispatch timeout — the action handler never settled; ignoring the lease",
        { label: lease.label, heldMs: now - lease.startedAt }
      );
    }
  }
  return suppressed;
}

export async function runWithMcpSpawnFocusSuppressed<T>(
  fn: () => Promise<T>,
  label?: string
): Promise<T> {
  const leaseId = nextLeaseId++;
  activeLeases.set(leaseId, { label, startedAt: Date.now(), warned: false });
  try {
    return await fn();
  } finally {
    activeLeases.delete(leaseId);
  }
}
