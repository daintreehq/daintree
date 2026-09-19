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
 * Multiplier applied to main's optional pollers (workspace, project stats,
 * process tree, disk space, app metrics, idle-terminal notifications). Battery
 * alone doubles them while the user is still looking; losing the user entirely
 * keeps the historical ×5 blur throttle, and `deep` goes further.
 */
export function powerPolicyPollMultiplier(snapshot: PowerPolicySnapshot): number {
  if (snapshot.level === "deep") return 10;
  if (!snapshot.canObserve) return 5;
  return snapshot.onBattery ? 2 : 1;
}

export function isPowerPolicyLevel(value: unknown): value is PowerPolicyLevel {
  return value === "active" || value === "saving" || value === "deep";
}
