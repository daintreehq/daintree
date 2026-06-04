import { useEffect, useRef, useState } from "react";
import { Check, CircleSlash, Loader2, TriangleAlert, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { UI_DOHERTY_THRESHOLD } from "@/lib/animationUtils";
import type { McpToolActivityState } from "@/controllers/HelpSessionController";

/** Cadence of the in-flight elapsed-timer tick — one second of resolution is plenty for an ambient strip. */
const ELAPSED_TICK_MS = 1000;

/**
 * Ambient single-line strip in the Assistant panel's info bar showing the
 * live MCP tool call (#9759). In-flight: tool id + args + an elapsed timer.
 * Settled: dimmed glyph + duration, red when errored. Tier-1 ambient chrome —
 * no accent color, 150ms state transition.
 *
 * Doherty gate: the animated in-flight row is withheld for the first 400ms so a
 * sub-400ms call settles first and renders its settled state directly, never
 * flickering the spinner ("<400ms: show nothing"). The elapsed timer mutates
 * the DOM directly via a ref so its per-second tick never re-renders the panel.
 */
export function McpToolActivityStrip({ activity }: { activity: McpToolActivityState }) {
  const inFlight = activity.status === "in-flight";
  // Stable identity for the current row: a coalesced burst shares its turnId,
  // so the gate isn't re-armed (and the row isn't re-hidden) on each new call
  // within the turn. Non-coalescing calls fall back to their start timestamp.
  const rowKey = activity.turnId ?? String(activity.startedAt);
  const [shownKey, setShownKey] = useState<string | null>(null);

  useEffect(() => {
    if (!inFlight || shownKey === rowKey) return;
    const id = setTimeout(() => setShownKey(rowKey), UI_DOHERTY_THRESHOLD);
    return () => clearTimeout(id);
  }, [inFlight, rowKey, shownKey]);

  // Sub-400ms in-flight: show nothing until it either crosses the gate or
  // settles (settled rows always render).
  if (inFlight && shownKey !== rowKey) return null;

  // A settled call under the Doherty threshold never animated in, so it must
  // not fade on settle either — render its resting state directly.
  const skipTransition =
    activity.status === "settled" &&
    activity.durationMs !== undefined &&
    activity.durationMs < UI_DOHERTY_THRESHOLD;

  const coalesced = activity.callCount > 1;
  const label = coalesced ? `${activity.callCount} calls · ${activity.toolId}` : activity.toolId;

  return (
    <span
      className={cn(
        "flex items-center gap-1.5 min-w-0",
        !skipTransition && "transition-colors duration-150",
        activity.isError
          ? "text-status-danger"
          : inFlight
            ? "text-daintree-text/55"
            : "text-daintree-text/30"
      )}
      title={buildTitle(activity)}
    >
      <ActivityGlyph activity={activity} inFlight={inFlight} />
      {/* Tool id wins the row — never truncates. */}
      <span className="shrink-0 font-medium truncate max-w-[60%]">{label}</span>
      {activity.danger && inFlight ? (
        <span className="shrink-0">awaiting confirmation</span>
      ) : (
        !coalesced &&
        activity.argsSummary &&
        activity.argsSummary !== "{}" && (
          // Args truncate first when the row is tight.
          <span className="truncate min-w-0 opacity-80">{activity.argsSummary}</span>
        )
      )}
      <TrailingMetric activity={activity} inFlight={inFlight} />
    </span>
  );
}

function ActivityGlyph({
  activity,
  inFlight,
}: {
  activity: McpToolActivityState;
  inFlight: boolean;
}) {
  if (inFlight) {
    return <Loader2 aria-hidden className="w-3 h-3 shrink-0 animate-spin" />;
  }
  if (activity.isError) {
    return <X aria-hidden className="w-3 h-3 shrink-0" />;
  }
  if (activity.result === "unauthorized" || activity.result === "rate_limited") {
    return <CircleSlash aria-hidden className="w-3 h-3 shrink-0" />;
  }
  if (activity.severity === "warning" || activity.severity === "notice") {
    return <TriangleAlert aria-hidden className="w-3 h-3 shrink-0" />;
  }
  return <Check aria-hidden className="w-3 h-3 shrink-0" />;
}

/**
 * The right-aligned metric: a live elapsed timer while in-flight, the final
 * duration once settled. The elapsed value is written straight to the DOM node
 * on a 1s interval — `startedAt` is read once at mount, so the closure stays
 * stable and the tick never triggers a React render.
 */
function TrailingMetric({
  activity,
  inFlight,
}: {
  activity: McpToolActivityState;
  inFlight: boolean;
}) {
  const elapsedRef = useRef<HTMLSpanElement>(null);
  const startedAt = activity.startedAt;

  useEffect(() => {
    if (!inFlight) return;
    const node = elapsedRef.current;
    if (!node) return;
    const tick = () => {
      node.textContent = formatElapsed(Date.now() - startedAt);
    };
    tick();
    const id = setInterval(tick, ELAPSED_TICK_MS);
    return () => clearInterval(id);
  }, [inFlight, startedAt]);

  if (inFlight) {
    // The "awaiting confirmation" state has no meaningful elapsed wait to show.
    if (activity.danger) return null;
    return (
      <span ref={elapsedRef} className="shrink-0 ml-auto tabular-nums">
        {formatElapsed(Math.max(0, Date.now() - startedAt))}
      </span>
    );
  }

  if (activity.durationMs === undefined) return null;
  return (
    <span className="shrink-0 ml-auto tabular-nums">{formatDuration(activity.durationMs)}</span>
  );
}

function buildTitle(activity: McpToolActivityState): string {
  const parts: string[] = [activity.toolId];
  if (activity.callCount > 1) parts.push(`${activity.callCount} calls this turn`);
  if (activity.argsSummary && activity.argsSummary !== "{}") parts.push(activity.argsSummary);
  if (activity.status === "settled" && activity.result) parts.push(activity.result);
  return parts.join(" — ");
}

/** Elapsed wall-clock for an in-flight call: `0s`, `12s`, `3m 04s`. */
function formatElapsed(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
}

/** Settled duration: sub-second as `840ms`, else reuse the elapsed format. */
function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return formatElapsed(ms);
}
