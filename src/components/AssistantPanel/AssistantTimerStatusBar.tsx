import { cn } from "@/lib/utils";
import { describeAction, formatDueIn } from "./AssistantTimersSection";
import { useTimerClock } from "./useTimerClock";
import type { AssistantTimerRow } from "@shared/types/ipc/assistantHost";

/**
 * The live countdown strip, directly above the composer.
 *
 * A scheduled timer was the only thing the assistant could commit to doing later, and
 * the only place it appeared was the operations deck — a surface you reach through a
 * header overflow menu and which REPLACES the transcript while it is open. So the
 * whole of "something is going to happen in ten seconds" lived behind a menu, and the
 * reported experience of scheduling a timer was watching a reply say "Scheduled." and
 * then looking at a panel where nothing whatsoever indicated that a clock was running.
 *
 * It answers two questions and no others: WHEN, and WHAT WILL HAPPEN. Cancelling,
 * repeats, grants and history stay in the deck — this strip sits above the input on
 * every turn, so anything it says is said permanently, and a control here would be a
 * destructive action one slip away from the thing the user is actually typing into.
 *
 * It is deliberately quiet: panel-secondary ink, no accent, no icon colour. A pending
 * timer is the assistant doing what it was asked to; it is not a warning, and a strip
 * that read as one would be wrong on every turn it appeared.
 */

export interface AssistantTimerStatusBarProps {
  /** The scheduled timers, as the engine last listed them. */
  timers: AssistantTimerRow[];
  /**
   * Whether the panel is actually on screen.
   *
   * Drives the clock. The panel hides by sliding off-canvas rather than unmounting, so
   * without this the strip keeps ticking behind a closed sidebar for the life of the
   * session.
   */
  visible: boolean;
  /** Open the deck, where a timer can be inspected and cancelled. */
  onOpenDeck?: () => void;
}

/**
 * The timer to lead with: the one firing soonest.
 *
 * Overdue rows sort first because they are the more urgent reading — a timer that is
 * past due and has not fired is the state a user most needs to see, and burying it
 * under a later timer that is behaving normally would hide exactly the case where the
 * strip has something to say.
 */
export function soonest(timers: AssistantTimerRow[]): AssistantTimerRow | null {
  if (timers.length === 0) return null;
  return timers.reduce((best, row) => (row.dueAt < best.dueAt ? row : best));
}

export function AssistantTimerStatusBar({
  timers,
  visible,
  onOpenDeck,
}: AssistantTimerStatusBarProps) {
  // Ticking is gated on there being something to count down as well as on visibility:
  // an empty list renders nothing, and a hidden panel is not watching.
  const active = visible && timers.length > 0;
  const now = useTimerClock(active);

  const next = soonest(timers);
  if (!next) return null;

  const others = timers.length - 1;
  const body = (
    <>
      {/* A dot, not an icon. Every other lit dot in this panel means "live", and a
          pending timer is the same claim — a glyph would be a second vocabulary for
          one idea. */}
      <span
        aria-hidden="true"
        className="size-1.5 shrink-0 rounded-full bg-[var(--assistant-fg-secondary)]"
      />
      <span className="min-w-0 flex-1 truncate">
        {next.label}
        <span className="ml-1.5 text-[var(--assistant-fg-secondary)]">{describeAction(next)}</span>
      </span>
      {/* Tabular so the countdown does not jitter the row's width once a second. */}
      <span className="shrink-0 tabular-nums">{formatDueIn(next.dueAt, now)}</span>
      {others > 0 ? (
        <span className="shrink-0 text-[var(--assistant-fg-secondary)]">+{others}</span>
      ) : null}
    </>
  );

  const className = cn(
    "flex w-full items-center gap-2 px-3.5 py-1 assistant-text-sm",
    "text-[var(--assistant-fg)]"
  );

  // A button only when there is somewhere to go. Rendering a dead button would put a
  // focus stop above the composer on every turn that buys the keyboard user nothing.
  if (!onOpenDeck) {
    return (
      <div className={cn(className, "shrink-0")} data-testid="assistant-timer-status">
        {body}
      </div>
    );
  }
  return (
    <button
      type="button"
      onClick={onOpenDeck}
      data-testid="assistant-timer-status"
      // The strip is a readout that happens to be actionable, so it takes the hover
      // treatment of a row rather than the affordances of a control: no border, no
      // background at rest.
      className={cn(
        className,
        "shrink-0 text-left transition-colors duration-150 ease-out",
        "hover:bg-[var(--assistant-hover)]"
      )}
      aria-label={`${timers.length === 1 ? "1 scheduled timer" : `${timers.length} scheduled timers`} — open operations`}
    >
      {body}
    </button>
  );
}
