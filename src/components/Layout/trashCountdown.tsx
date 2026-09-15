import { useState } from "react";
import { TRASH_TTL_MS } from "@shared/config/trash";
import { useVisibilityAwareInterval } from "@/hooks/useVisibilityAwareInterval";
import { cn } from "@/lib/utils";

/**
 * The shared deadline vocabulary for the recently-closed list.
 *
 * A trashed pane is destroyed outright `TRASH_TTL_MS` after it is closed, so
 * the deadline is the single most load-bearing thing on the row — not metadata
 * about it. Both the single-pane row and the tab-group row spell it the same
 * way, and they spell it here so they cannot drift apart.
 */

/** The window in whole seconds, for copy that has to name it. */
export const TRASH_TTL_SECONDS = Math.round(TRASH_TTL_MS / 1000);

/**
 * The final approach. Inside it the row stops being neutral: the label takes
 * the warning tone and the meter goes with it. Outside it the row is quiet but
 * never silent — the number and the bar are on screen the whole time.
 */
export const COUNTDOWN_CRITICAL_SECONDS = 5;

export interface TrashCountdown {
  /** Whole seconds left, floored at zero. */
  seconds: number;
  /** Fraction of the TTL still to run, 0-1 — what the meter draws. */
  fraction: number;
  /** Milliseconds left, which is how long the meter has to finish draining. */
  remainingMs: number;
  isCritical: boolean;
}

/**
 * One second of resolution, paused while the window is hidden and snapped back
 * to wall-clock time on return — Chromium coalesces hidden-document timers, so
 * a ticker that counts its own wake-ups drifts away from the expiry the store
 * actually scheduled.
 */
export function useTrashCountdown(expiresAt: number): TrashCountdown {
  const [now, setNow] = useState(() => Date.now());
  useVisibilityAwareInterval(() => setNow(Date.now()), 1000);

  const remainingMs = Math.max(0, expiresAt - now);
  return {
    seconds: Math.ceil(remainingMs / 1000),
    fraction: Math.min(1, remainingMs / TRASH_TTL_MS),
    remainingMs,
    isCritical: Math.ceil(remainingMs / 1000) <= COUNTDOWN_CRITICAL_SECONDS,
  };
}

interface TrashCountdownLabelProps {
  countdown: TrashCountdown;
  /** What is expiring, so the timer's accessible name says what it is counting. */
  name: string;
}

/**
 * The numeric deadline, on screen for the whole window rather than on hover.
 *
 * `role="timer"` is implicitly `aria-live="off"`, which is the point: a screen
 * reader can read the value on demand, and a 1 Hz counter never interrupts to
 * announce itself. The expiry itself is announced once, by the container.
 */
export function TrashCountdownLabel({ countdown, name }: TrashCountdownLabelProps) {
  const { seconds, isCritical } = countdown;
  return (
    <span
      role="timer"
      data-trash-countdown
      data-critical={isCritical ? "true" : undefined}
      aria-label={`${name}: ${seconds} seconds until it is removed`}
      className={cn(
        "shrink-0 tabular-nums transition-colors",
        isCritical ? "font-medium text-status-warning" : "text-text-secondary"
      )}
    >
      {seconds}s left
    </span>
  );
}

interface TrashTtlMeterProps {
  countdown: TrashCountdown;
}

/**
 * The row's remaining time as a length, pinned to its bottom edge.
 *
 * The number tells you how long one row has; the meter is what lets you rank a
 * list of them without reading any of them. It is decoration in the
 * accessibility tree (`aria-hidden`) because the label beside it already
 * carries the value as text.
 *
 * Motion: the bar drains over the row's *actual* remaining milliseconds, which
 * is a duration the shared motion tiers deliberately exempt — decay is the
 * signal here, not a transition between two UI states
 * (`.claude/rules/design-system.md`, semantic exceptions). One CSS animation
 * does the whole drain, so the 1 Hz re-render costs no extra paint. The
 * element's own `transform` already holds the current fraction, so under
 * reduced motion dropping the animation leaves a correct bar that steps down
 * once a second instead of sliding — `index.css` overrides it through the
 * repo's own `reduce-motion` variant, which covers the in-app
 * `data-reduce-animations` setting as well as the media query.
 */
export function TrashTtlMeter({ countdown }: TrashTtlMeterProps) {
  const { fraction, remainingMs, isCritical } = countdown;
  return (
    <span
      aria-hidden="true"
      data-trash-meter
      className="pointer-events-none absolute inset-x-0 bottom-0 h-0.5 overflow-hidden bg-overlay-subtle"
    >
      <span
        className={cn(
          "block h-full w-full origin-left animate-trash-meter",
          isCritical ? "bg-status-warning" : "bg-text-secondary"
        )}
        style={
          {
            transform: `scaleX(${fraction})`,
            "--trash-meter-start": fraction,
            "--trash-meter-duration": `${remainingMs}ms`,
          } as React.CSSProperties
        }
      />
    </span>
  );
}
