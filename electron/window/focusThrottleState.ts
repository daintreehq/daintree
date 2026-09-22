// Near-leaf module: imports only the import-free powerPolicy leaf, so it stays
// safe to import from any process-global service. Shared between powerMonitor's power-policy polling throttle (the
// only writer) and ResourceProfileService (a concurrent writer of the same
// polling knobs) so a profile transition landing mid-throttle keeps the
// multiplier applied instead of silently un-throttling the pollers
// (last-writer-wins at each consumer).
import {
  ACTIVE_WORKSPACE_POLLING_POLICY,
  type WorkspacePollingPolicy,
} from "../../shared/types/powerPolicy.js";

let throttled = false;
let multiplier = 1;
let workspacePolicy: WorkspacePollingPolicy = { ...ACTIVE_WORKSPACE_POLLING_POLICY };

/**
 * Record the throttle powerMonitor just applied. `throttled` means no user can
 * be looking at a window (blurred, hidden, or locked); the multiplier can be
 * above 1 without it — battery alone slows the pollers while the user watches.
 */
export function setPollThrottle(state: { throttled: boolean; multiplier: number }): void {
  throttled = state.throttled;
  multiplier = state.multiplier;
}

/**
 * Record the workspace policy powerMonitor just pushed. The workspace host's
 * cadence does NOT follow `multiplier` — see `workspacePollingCadence` — so the
 * other writer needs the policy itself to derive the same numbers.
 */
export function setWorkspacePollingPolicy(policy: WorkspacePollingPolicy): void {
  workspacePolicy = { ...policy };
}

export function getWorkspacePollingPolicy(): WorkspacePollingPolicy {
  return workspacePolicy;
}

export function isFocusThrottled(): boolean {
  return throttled;
}

export function getFocusThrottlePollMultiplier(): number {
  return multiplier;
}
