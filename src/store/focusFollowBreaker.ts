/**
 * Rate breaker for the focus-follow worktree promotion (#12370).
 *
 * Focusing a terminal in another worktree promotes that worktree to active.
 * Two `focusedId` writers that disagree about which terminal owns focus turn
 * that promotion into a workspace-wide oscillation — every switch re-runs the
 * terminal policy and repaints the grid — and because the switches are
 * focus-sourced they leave no trace in persisted state. The seed writer is
 * not known, so the guard is rate-based rather than a re-entrancy flag: a
 * burst of cross-worktree promotions inside a short window is a fault, not a
 * state to keep serving.
 *
 * Pure and clock-injected; no timers. Once tripped, every further attempt
 * extends the hold, so a sustained oscillator keeps the breaker open and it
 * only releases after the writer has been quiet for `cooldownMs`.
 */

export interface FocusPromotion {
  from: string | null;
  to: string;
  panelId: string;
  stack?: string;
}

export interface RecordedFocusPromotion extends FocusPromotion {
  at: number;
}

export type FocusFollowOutcome = "allow" | "recovered" | "tripped" | "suppressed";

export interface FocusFollowBreakerOptions {
  /** Promotions inside `windowMs` that trip the breaker; the Nth is blocked. */
  threshold?: number;
  windowMs?: number;
  /** Quiet period with no attempts before promotions are served again. */
  cooldownMs?: number;
  now?: () => number;
}

export interface FocusFollowBreaker {
  record: (promotion: FocusPromotion) => FocusFollowOutcome;
  snapshot: () => {
    tripped: boolean;
    history: readonly RecordedFocusPromotion[];
    suppressedCount: number;
  };
  reset: () => void;
}

export const FOCUS_FOLLOW_BREAKER_DEFAULTS = {
  threshold: 8,
  windowMs: 5_000,
  cooldownMs: 2_000,
} as const;

export function createFocusFollowBreaker(
  options: FocusFollowBreakerOptions = {}
): FocusFollowBreaker {
  const threshold = options.threshold ?? FOCUS_FOLLOW_BREAKER_DEFAULTS.threshold;
  const windowMs = options.windowMs ?? FOCUS_FOLLOW_BREAKER_DEFAULTS.windowMs;
  const cooldownMs = options.cooldownMs ?? FOCUS_FOLLOW_BREAKER_DEFAULTS.cooldownMs;
  // Wall clock on purpose: the `at` stamps in the trip warning line up with
  // the rest of the log, and a wake-from-sleep jump only ever releases early.
  // Resolved per call rather than captured, so a clock swapped in after
  // construction (fake timers) is honoured.
  const now = options.now ?? (() => Date.now());

  // Never longer than `threshold`: recording stops at the trip and the window
  // is cleared on release. The ring exists to show the A→B→A pattern and the
  // writer stacks in the trip warning, not to keep an audit trail.
  const history: RecordedFocusPromotion[] = [];
  let holdUntil: number | null = null;
  let suppressedCount = 0;

  return {
    record(promotion) {
      const at = now();
      if (holdUntil !== null && at < holdUntil) {
        holdUntil = at + cooldownMs;
        suppressedCount++;
        return "suppressed";
      }
      const recovered = holdUntil !== null;
      if (recovered) {
        holdUntil = null;
        history.length = 0;
      }

      while (history.length > 0 && at - history[0]!.at > windowMs) history.shift();
      history.push({ ...promotion, at });

      if (history.length >= threshold) {
        holdUntil = at + cooldownMs;
        suppressedCount = 0;
        return "tripped";
      }
      return recovered ? "recovered" : "allow";
    },
    snapshot() {
      return { tripped: holdUntil !== null, history: [...history], suppressedCount };
    },
    reset() {
      history.length = 0;
      holdUntil = null;
      suppressedCount = 0;
    },
  };
}
