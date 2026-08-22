import { memo } from "react";
import { Check, ChevronRight, CircleDashed, Hourglass, TriangleAlert, X } from "lucide-react";
import { cn } from "@/lib/utils";
import type { AssistantToolCall } from "@/store/assistantStore";

/**
 * One tool call in the transcript.
 *
 * The states are not decoration — each one means something different about who is
 * blocked, and the row is designed so that reads at a glance:
 *
 * - `queued`   the batch was announced; this call has not started. Shown from the
 *              moment the batch lands so a five-step plan reads as a plan rather than
 *              as the assistant improvising one call at a time.
 * - `active`   running. Also the state of an accepted async call whose work continues
 *              in the background — never rendered as finished.
 * - `waiting`  blocked on the USER, not on the tool. This is the one that must not
 *              look like ordinary progress: otherwise someone watches a spinner that
 *              is waiting for their own unanswered approval.
 * - `done` / `failed` settled.
 */

interface StateStyle {
  Icon: typeof Check;
  /** Icon colour token. Semantic status colours, never the accent. */
  tone: string;
  label: string;
  spin?: boolean;
}

function styleFor(call: AssistantToolCall): StateStyle {
  switch (call.state) {
    case "queued":
      return { Icon: CircleDashed, tone: "text-text-muted", label: "Queued" };
    case "active":
      return {
        Icon: CircleDashed,
        tone: "text-text-secondary",
        label: call.asyncId ? "Running in background" : "Running",
        spin: true,
      };
    case "waiting":
      // Amber, and worded from the user's side: the system is not busy, it is waiting
      // for them.
      return { Icon: Hourglass, tone: "text-status-warning", label: "Needs your approval" };
    case "failed":
      return { Icon: X, tone: "text-status-danger", label: "Failed" };
    case "done":
    default:
      return { Icon: Check, tone: "text-status-success", label: "Done" };
  }
}

function formatDuration(ms: number | undefined): string | null {
  if (ms === undefined) return null;
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s`;
}

export interface AssistantToolRowProps {
  call: AssistantToolCall;
}

export const AssistantToolRow = memo(function AssistantToolRow({ call }: AssistantToolRowProps) {
  const { Icon, tone, label, spin } = styleFor(call);
  // A duration is only meaningful for a call that has actually FINISHED. An accepted
  // async call reports how long the dispatch took while the work carries on in the
  // background, so showing "1.2s" there reads as "done in 1.2s" — the precise
  // misreading the async state exists to prevent. The state label wins instead.
  const settled = call.state === "done" || call.state === "failed";
  const duration = settled ? formatDuration(call.durationMs) : null;

  return (
    <li
      className={cn("flex items-start gap-2 rounded-md px-2 py-1.5 text-xs", "bg-surface-inset/60")}
    >
      <Icon
        aria-hidden="true"
        className={cn("mt-px size-3.5 shrink-0", tone, spin && "animate-spin-slow")}
      />

      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-1.5">
          <span className="truncate font-mono text-[11px] text-text-primary">{call.toolId}</span>
          {call.danger && (
            <TriangleAlert
              aria-label="Mutating action"
              className="size-3 shrink-0 text-status-warning"
            />
          )}
          {/* One slot renders either a duration (metadata) or a STATE (meaning), so
              its treatment has to follow the content. A state label in the muted slot
              measured ~4.1:1 in the dark theme — too faint for the thing telling you
              the assistant is blocked on your approval. */}
          <span
            className={cn(
              "ml-auto shrink-0 tabular-nums text-[10px]",
              duration ? "text-text-muted" : cn(tone, "font-medium")
            )}
          >
            {duration ?? label}
          </span>
        </div>

        {/* The in-tool substep, when there is one — so a long call never looks frozen. */}
        {call.state === "active" && call.progress && (
          <p className="mt-0.5 truncate text-[11px] text-text-secondary">{call.progress}</p>
        )}

        {call.argsSummary && (
          <p className="mt-0.5 truncate font-mono text-[10px] text-text-secondary">
            {call.argsSummary}
          </p>
        )}

        {call.state === "failed" && call.errorCode && (
          <p className="mt-0.5 font-mono text-[10px] text-status-danger">{call.errorCode}</p>
        )}
      </div>
    </li>
  );
});

/** The collapsed group header for a turn's tool calls. */
export function AssistantToolGroupHeader({
  count,
  failedCount = 0,
  runningCount = 0,
  open,
  onToggle,
}: {
  count: number;
  /** Failures must remain visible when the group is collapsed. */
  failedCount?: number;
  /** Work still running after the turn ended (accepted async calls). */
  runningCount?: number;
  open: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={open}
      className={cn(
        "flex w-full items-center gap-1.5 rounded-md px-1.5 py-1 text-left",
        "text-[11px] text-text-secondary",
        "transition-colors duration-150 ease-out hover:bg-surface-hover",
        "focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-focus-ring"
      )}
    >
      <ChevronRight
        aria-hidden="true"
        className={cn("size-3 transition-transform duration-150 ease-out", open && "rotate-90")}
      />
      {count} {count === 1 ? "action" : "actions"}
      {/* Survives collapse: otherwise a failed run and a clean one render the same
          header, and the outcome most worth noticing is the one that disappears. */}
      {failedCount > 0 && (
        <span className="font-medium text-status-danger">· {failedCount} failed</span>
      )}
      {/* An accepted async call keeps running after the turn ends, so "the turn
          finished" is not "the work finished". Saying so in the collapsed header is
          what stops a background agent from vanishing off the transcript. */}
      {runningCount > 0 && (
        <span className="font-medium text-text-secondary">· {runningCount} still running</span>
      )}
    </button>
  );
}
