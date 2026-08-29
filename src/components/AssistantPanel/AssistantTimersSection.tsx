import { useCallback, useState } from "react";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { cn } from "@/lib/utils";
import type { AssistantTimerRow } from "@shared/types/ipc/assistantHost";

/**
 * The SCHEDULED section of the operations deck, as a manager rather than a readout.
 *
 * Timers were the one thing on this deck a user could see and not act on. They are also
 * the one thing on it that OUTLIVES the conversation — a reminder or a scheduled tool
 * call keeps its appointment after the transcript is cleared and after the panel is
 * closed — so "I can see it but the only way to stop it is to ask the assistant to" was
 * the wrong shape for the one row that most needs a direct control.
 *
 * It draws in the panel's own palette (`--assistant-*`), not the app's semantic tokens,
 * because it renders inside `.assistant-panel`, which derives its colours from the
 * terminal theme. The confirmation is the deliberate exception: a modal is app chrome,
 * it portals out of this tree, and it should look like every other dialog in Daintree.
 */

export interface AssistantTimersSectionProps {
  timers: AssistantTimerRow[];
  /** Timers with a cancel in flight. */
  pending: Record<string, true>;
  /** Why a cancel failed, per timer. */
  errors: Record<string, string>;
  onCancel: (timerId: string) => void;
  /** Now, in epoch ms — passed in so the whole deck shares one clock reading. */
  now: number;
}

const MINUTE = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;

/**
 * "in 5m" / "in 2h" / "3m ago".
 *
 * A timer is the one row on this deck that points FORWARDS, and it can also point
 * backwards: a due timer that has not fired yet (the scheduler ticks on an interval, and
 * nothing ticks at all while no engine is running) sits in the list with its time in the
 * past. Rendering that as "in -3m" would read as a bug; saying it is overdue is the
 * actual state.
 */
export function formatDueIn(dueAt: number, now: number): string {
  const ms = dueAt - now;
  const overdue = ms < 0;
  const abs = Math.abs(ms);
  let value: string;
  if (abs < MINUTE) value = `${Math.max(1, Math.round(abs / 1000))}s`;
  else if (abs < HOUR) value = `${Math.round(abs / MINUTE)}m`;
  else if (abs < DAY) value = `${Math.round(abs / HOUR)}h`;
  else value = `${Math.round(abs / DAY)}d`;
  return overdue ? `due ${value} ago` : `in ${value}`;
}

/** The exact clock time, so "in 8h" is checkable against a real appointment. */
export function formatDueAt(dueAt: number): string {
  const d = new Date(dueAt);
  const time = d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  const sameDay = new Date().toDateString() === d.toDateString();
  return sameDay
    ? time
    : `${d.toLocaleDateString(undefined, { month: "short", day: "numeric" })}, ${time}`;
}

/** "every 1h", with the bound when it has one — an unbounded repeat pings forever. */
export function formatRepeat(row: AssistantTimerRow): string | null {
  if (row.repeatEveryMs <= 0) return null;
  const every =
    row.repeatEveryMs >= DAY
      ? `${Math.round(row.repeatEveryMs / DAY)}d`
      : row.repeatEveryMs >= HOUR
        ? `${Math.round(row.repeatEveryMs / HOUR)}h`
        : row.repeatEveryMs >= MINUTE
          ? `${Math.round(row.repeatEveryMs / MINUTE)}m`
          : `${Math.round(row.repeatEveryMs / 1000)}s`;
  if (row.repeatMaxRuns > 0)
    return `every ${every} · run ${row.runCount + 1} of ${row.repeatMaxRuns}`;
  if (row.repeatUntilAt > 0) return `every ${every} · until ${formatDueAt(row.repeatUntilAt)}`;
  return `every ${every} · ${row.runCount} so far`;
}

/**
 * What the timer will DO — the line that decides whether a user wants to keep it.
 *
 * "Reminder" and "Runs terminal.sendCommand" are very different things to leave running
 * unattended, and before this the deck showed both as a bare title.
 */
export function describeAction(row: AssistantTimerRow): string {
  switch (row.payloadKind) {
    case "tool_call":
      return row.toolName ? `Runs ${row.toolName}` : "Runs a tool";
    case "reminder":
      return "Reminder";
    default:
      // A row written by a payload type the engine has retired. It still fires, as a
      // plain reminder — saying "Reminder" outright would overclaim a shape we could
      // not actually read off the row.
      return "Reminder (legacy)";
  }
}

/** The consequence line for the confirmation — grants are the part users forget. */
export function describeCancelConsequence(row: AssistantTimerRow): string {
  const when = `${formatDueAt(row.dueAt)} (${formatDueIn(row.dueAt, Date.now())})`;
  const base =
    row.payloadKind === "tool_call"
      ? `It won't run ${row.toolName || "its tool"} at ${when}`
      : `It won't remind you at ${when}`;
  const repeat = row.repeatEveryMs > 0 ? ", and it won't repeat again" : "";
  // Three states, not two. A failed grant read must not render as "no grants": on a
  // destructive confirmation that is a silent fallback default, and it would tell the
  // user there is no standing authority to withdraw at the exact moment they are
  // deciding whether to withdraw it.
  const grants = row.grantsUnknown
    ? " It may also hold automation grants — that could not be read, so cancelling may revoke authority not listed here."
    : row.liveGrants > 0
      ? ` This also revokes the ${row.liveGrants === 1 ? "automation grant" : `${row.liveGrants} automation grants`} it holds.`
      : "";
  return `${base}${repeat}.${grants}`;
}

function TimerRow({
  row,
  isPending,
  error,
  now,
  onRequestCancel,
}: {
  row: AssistantTimerRow;
  isPending: boolean;
  error: string | undefined;
  now: number;
  onRequestCancel: () => void;
}) {
  const repeat = formatRepeat(row);
  const target = row.targetWorktreeId || row.targetTerminalId;
  return (
    <div className="rounded-sm px-1.5 py-1 assistant-text-base">
      <div className="flex items-baseline gap-2">
        <span className="min-w-0 flex-1 truncate">{row.label}</span>
        <span className="shrink-0 tabular-nums text-[var(--assistant-fg-secondary)]">
          {formatDueIn(row.dueAt, now)}
        </span>
        {/* The SAME button throughout, relabelled and disabled while the engine
            settles it. No spinner: the wait is a local SQLite write answered over a
            pipe, so it is normally far under the 400ms Doherty threshold, and a
            Spinner has no delay built in — it would flash on almost every cancel,
            which is the exact case the loading rules say never to use it for. A
            disabled button reading "Cancelling…" says the same thing in words, and
            says it without the row's controls jumping width as they swap. */}
        <button
          type="button"
          onClick={onRequestCancel}
          disabled={isPending}
          aria-live="polite"
          // Neutral, not the danger colour. Every row carries one of these, and a
          // list of red buttons reads as a list of problems — the timer is doing
          // exactly what it was asked to. The danger framing belongs in the
          // confirmation, where there is one of it and it is about to happen.
          className={cn(
            "shrink-0 rounded-sm px-1.5 py-0.5 assistant-text-sm",
            "text-[var(--assistant-fg-secondary)] transition-colors duration-150 ease-out",
            "hover:bg-[var(--assistant-hover)] hover:text-[var(--assistant-fg)]",
            "disabled:cursor-default disabled:text-[var(--assistant-fg-dim)] disabled:hover:bg-transparent"
          )}
        >
          {isPending ? "Cancelling…" : "Cancel"}
        </button>
      </div>
      <div className="flex items-baseline gap-2 assistant-text-sm text-[var(--assistant-fg-secondary)]">
        <span className="min-w-0 truncate">
          {describeAction(row)}
          {repeat ? ` · ${repeat}` : ""}
          {target ? ` · ${target}` : ""}
        </span>
        <span className="ml-auto shrink-0 tabular-nums">{formatDueAt(row.dueAt)}</span>
      </div>
      {error ? (
        // Inline, against the row that failed. The user is looking straight at it and
        // the recovery is the button they just pressed, so a toast would move the
        // message away from both.
        <div className="mt-0.5 assistant-text-sm text-[var(--assistant-danger)]">{error}</div>
      ) : null}
    </div>
  );
}

export function AssistantTimersSection({
  timers,
  pending,
  errors,
  onCancel,
  now,
}: AssistantTimersSectionProps) {
  // The row the confirmation is about, FROZEN at open time. Holding the id instead
  // would let an arriving refresh change what the dialog is describing between the
  // user reading it and pressing the button.
  const [confirming, setConfirming] = useState<AssistantTimerRow | null>(null);

  const confirmCancel = useCallback(() => {
    if (confirming) onCancel(confirming.id);
    setConfirming(null);
  }, [confirming, onCancel]);

  return (
    <>
      <div className="space-y-1">
        {timers.map((row) => (
          <TimerRow
            key={row.id}
            row={row}
            isPending={pending[row.id] === true}
            error={errors[row.id]}
            now={now}
            onRequestCancel={() => setConfirming(row)}
          />
        ))}
      </div>
      <ConfirmDialog
        isOpen={confirming !== null}
        onClose={() => setConfirming(null)}
        // Names the entity, and asks a question rather than "Are you sure".
        title={confirming ? `Cancel '${confirming.label}'?` : ""}
        description={confirming ? describeCancelConsequence(confirming) : ""}
        confirmLabel="Cancel timer"
        // The default "Cancel" would be two buttons reading Cancel, one of which
        // cancels the timer and one of which cancels the cancelling.
        cancelLabel="Keep timer"
        variant="destructive"
        onConfirm={confirmCancel}
      />
    </>
  );
}
