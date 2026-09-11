/**
 * Rate breaker for the focus-follow worktree promotion (#12370).
 *
 * Focusing a terminal in another worktree promotes that worktree to active.
 * Two `focusedId` writers that disagree about which terminal owns focus turn
 * that promotion into a workspace-wide oscillation — every switch re-runs the
 * terminal policy and repaints the grid — and because the switches are
 * focus-sourced they leave no trace in persisted state. The seed writer is
 * not known, so the guard is rate-based rather than a re-entrancy flag: a
 * burst of promotions back onto worktrees the window already passed through
 * (A→B→A, or A→B→C→A) is a fault, not a state to keep serving. A one-way tour
 * across many worktrees — cycling agents with the keyboard — never revisits
 * and never counts.
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
  /** The destination was already an end of a hop inside the window. */
  revisit: boolean;
}

export type FocusFollowOutcome = "allow" | "recovered" | "tripped" | "suppressed";

export interface FocusFollowBreakerOptions {
  /** Revisits inside `windowMs` that trip the breaker; the Nth is blocked. */
  threshold?: number;
  windowMs?: number;
  /** Quiet period with no attempts before promotions are served again. */
  cooldownMs?: number;
  now?: () => number;
}

export interface FocusFollowBreaker {
  record: (promotion: FocusPromotion) => FocusFollowOutcome;
  /** Milliseconds until the hold lapses on its own; 0 when not held. */
  holdRemainingMs: () => number;
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

  // Every promotion inside the window, revisit or not — a later hop needs
  // the earlier ones to recognise a return, and the trip warning shows the
  // whole pattern with the writer stacks. Bounded well above the trip point
  // so a pathological tour cannot grow it; cleared on release.
  const maxHistory = threshold * 2;
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
      const revisit = history.some((p) => p.to === promotion.to || p.from === promotion.to);
      history.push({ ...promotion, at, revisit });
      if (history.length > maxHistory) history.shift();

      let revisits = 0;
      for (const p of history) if (p.revisit) revisits++;
      if (revisits >= threshold) {
        holdUntil = at + cooldownMs;
        suppressedCount = 0;
        return "tripped";
      }
      return recovered ? "recovered" : "allow";
    },
    holdRemainingMs() {
      return holdUntil === null ? 0 : Math.max(0, holdUntil - now());
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
