/**
 * How hard the app should cut back on background work, derived from what main
 * can actually observe about the machine and its windows — never from agent
 * state, which is a heuristic.
 *
 * - `active` — on AC power with a focused, visible window on an unlocked screen.
 * - `saving` — on battery, or no Daintree window has focus.
 * - `deep` — the screen is locked or no Daintree window is visible (hidden,
 *   minimized, or none open). Nobody can see the app.
 *
 * Linux often never reports lock-screen or battery state, so `deep` must stay
 * reachable through window visibility alone.
 */
export type PowerPolicyLevel = "active" | "saving" | "deep";

export interface PowerObservations {
  onBattery: boolean;
  screenLocked: boolean;
  anyWindowFocused: boolean;
  anyWindowVisible: boolean;
}

export interface PowerPolicySnapshot extends PowerObservations {
  level: PowerPolicyLevel;
  /** A user can be looking at a Daintree window right now. */
  canObserve: boolean;
}

export function derivePowerPolicy(observations: PowerObservations): PowerPolicySnapshot {
  const canObserve =
    observations.anyWindowFocused && observations.anyWindowVisible && !observations.screenLocked;
  let level: PowerPolicyLevel;
  if (observations.screenLocked || !observations.anyWindowVisible) {
    level = "deep";
  } else if (observations.onBattery || !observations.anyWindowFocused) {
    level = "saving";
  } else {
    level = "active";
  }
  return { ...observations, level, canObserve };
}

/**
 * Multiplier applied to main's optional pollers (project stats, process tree,
 * disk space, app metrics, idle-terminal notifications). Battery alone doubles
 * them while the user is still looking; losing the user entirely keeps the
 * historical ×5 blur throttle, and `deep` goes further.
 *
 * Workspace git-status polling is deliberately NOT on this multiplier — see
 * {@link workspacePollingCadence}. Its freshness is what a returning user
 * reads first, and its cost is dominated by watcher-event handling rather than
 * by the timer.
 */
export function powerPolicyPollMultiplier(snapshot: PowerPolicySnapshot): number {
  if (snapshot.level === "deep") return 10;
  if (!snapshot.canObserve) return 5;
  return snapshot.onBattery ? 2 : 1;
}

/**
 * What the workspace host is allowed to do, derived from the same observations
 * as the level. Three separate permissions, because the old single "polling
 * enabled" boolean conflated work of very different cost:
 *
 * - `statusAllowed` — watchers stay armed and git status may run. Needs only a
 *   window someone *could* look at, so a Daintree left visible on a second
 *   screen keeps observing while the user works elsewhere. That is the whole
 *   point of the product: the agents write files while you are away.
 * - `backgroundWorkAllowed` — network fetch and resource-command polling. Held
 *   to the stricter `canObserve`, exactly as before: nobody is waiting on a
 *   fetch they cannot see, and these cost a subprocess or a request.
 * - `attenuated` — consume change signals at the cheaper cadence: longer
 *   watcher coalescing, a rate budget on automatic status passes, a slower
 *   fallback poll for unwatched worktrees. Set whenever no one is looking.
 */
export interface WorkspacePollingPolicy {
  statusAllowed: boolean;
  backgroundWorkAllowed: boolean;
  attenuated: boolean;
}

export const ACTIVE_WORKSPACE_POLLING_POLICY: WorkspacePollingPolicy = {
  statusAllowed: true,
  backgroundWorkAllowed: true,
  attenuated: false,
};

export function deriveWorkspacePollingPolicy(
  snapshot: PowerPolicySnapshot
): WorkspacePollingPolicy {
  return {
    statusAllowed: snapshot.anyWindowVisible && !snapshot.screenLocked,
    backgroundWorkAllowed: snapshot.canObserve,
    attenuated: !snapshot.canObserve,
  };
}

/**
 * Floor for the attenuated fallback poll. It only reaches worktrees with no
 * watcher at all — every watched tier has its own mode-aware heartbeat — so a
 * worktree here is one we can learn nothing about without asking git.
 */
export const ATTENUATED_WORKSPACE_POLL_FLOOR_MS = 30_000;
const ATTENUATED_WORKSPACE_POLL_MULTIPLIER = 5;

/**
 * The workspace host's fallback poll cadence. The single derivation both
 * writers use — powerMonitor on a policy change and ResourceProfileService on
 * a profile change — so a profile transition landing mid-blur can't reinstate
 * unattenuated intervals, and a policy change can't discard profile tuning.
 */
export function workspacePollingCadence(
  baseline: { pollIntervalActive: number; pollIntervalBackground: number },
  policy: WorkspacePollingPolicy
): { pollIntervalActive: number; pollIntervalBackground: number } {
  if (!policy.attenuated) return { ...baseline };
  const stretch = (ms: number) =>
    Math.max(ms * ATTENUATED_WORKSPACE_POLL_MULTIPLIER, ATTENUATED_WORKSPACE_POLL_FLOOR_MS);
  return {
    pollIntervalActive: stretch(baseline.pollIntervalActive),
    pollIntervalBackground: stretch(baseline.pollIntervalBackground),
  };
}

export function isPowerPolicyLevel(value: unknown): value is PowerPolicyLevel {
  return value === "active" || value === "saving" || value === "deep";
}
