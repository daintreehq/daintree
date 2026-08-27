import { useEffect, useRef, useState } from "react";
import { Check, CircleSlash, Loader2, TriangleAlert, X } from "lucide-react";
import { Activity } from "@/components/icons";
import { Popover, PopoverTrigger, PopoverContent } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import { UI_DOHERTY_THRESHOLD } from "@/lib/animationUtils";
import { logWarn } from "@/utils/logger";
import type { McpAuditRecord } from "@shared/types";
import type { McpToolActivityState } from "@/controllers/HelpSessionController";
import { RecentCallsPopover } from "./RecentCallsPopover";

// Deliberately small — the popover is a quick glance at what the assistant
// just did, not a full audit surface.
const MAX_RECENT_CALLS = 5;

/**
 * How long a settled success row stays visible before decaying back to the
 * resting "Recent activity" label. Errors do not decay — a failed call is the
 * one ambient signal worth keeping until the next call supersedes it.
 */
const SETTLED_DECAY_MS = 5000;

interface McpActivityStripProps {
  /** Current assistant session. Empty/null means hibernated — strip is hidden. */
  sessionId: string | null;
  /** Live tool-call state pushed from the controller (#9759). */
  activity: McpToolActivityState | null;
}

/**
 * The footer's single activity element: live tool-call status and the
 * recent-calls history share one always-mounted popover trigger. At rest it
 * reads "Recent activity"; while a call runs it shows a spinner + tool id
 * (coalescing same-turn bursts as "2 calls · tool"); a settled call shows its
 * glyph + duration, then successes decay back to the resting label.
 *
 * The button's accessible name is pinned to "Recent tool calls" — morphing
 * text inside a focused control is unreliable across screen readers, so the
 * live content is presentation-only and the popover is the accessible record.
 *
 * Doherty gate: the in-flight row is withheld for the first 400ms so a
 * sub-400ms call settles first and renders its settled state directly —
 * during the gate the previous content (resting label or last settled call)
 * stays put instead of flickering a spinner.
 */
export function McpActivityStrip({ sessionId, activity }: McpActivityStripProps) {
  const [open, setOpen] = useState(false);
  const [records, setRecords] = useState<McpAuditRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);

  // Monotonic token: discard any fetch that resolves after a newer open/session
  // change so a slow response can't overwrite fresher state.
  const fetchSeq = useRef(0);

  // A session change invalidates the open popover — its calls belong to the old
  // session. Close it, drop the stale list, and bump the fetch token so any
  // in-flight request from the previous session can't land its results.
  useEffect(() => {
    fetchSeq.current++;
    setOpen(false);
    setRecords([]);
    setLoading(false);
    setError(false);
  }, [sessionId]);

  useEffect(() => {
    if (!open || !sessionId) return;

    const seq = ++fetchSeq.current;
    setLoading(true);
    setError(false);

    void (async () => {
      try {
        const all = await window.electron.mcpServer.getAuditRecords();
        if (fetchSeq.current !== seq) return;
        // Audit records carry the MCP transport id in `sessionId`; the help
        // session id the renderer holds only ever matches `helpSessionId`.
        const mine = all.filter((r) => r.helpSessionId === sessionId).slice(0, MAX_RECENT_CALLS);
        setRecords(mine);
        setLoading(false);
      } catch (err) {
        if (fetchSeq.current !== seq) return;
        logWarn("[McpActivityStrip] Failed to load audit records", { error: err });
        setError(true);
        setLoading(false);
      }
    })();
  }, [open, sessionId]);

  // Doherty gate for the in-flight row. Keyed on the coalescing turn (or the
  // call's start timestamp) so a burst within one turn doesn't re-arm the
  // gate on every call.
  const inFlight = activity?.status === "in-flight";
  const rowKey = activity ? (activity.turnId ?? String(activity.startedAt)) : null;
  const [shownKey, setShownKey] = useState<string | null>(null);
  useEffect(() => {
    if (rowKey === null || shownKey === rowKey) return;
    // A settled row renders immediately, which means its key is now on
    // screen — mark it shown so a same-turn follow-up call doesn't re-arm
    // the gate and flash back to the resting label mid-burst.
    if (activity?.status === "settled") {
      setShownKey(rowKey);
      return;
    }
    if (!inFlight) return;
    const id = setTimeout(() => setShownKey(rowKey), UI_DOHERTY_THRESHOLD);
    return () => clearTimeout(id);
  }, [activity?.status, inFlight, rowKey, shownKey]);

  // Success decay: after a quiet period the settled row yields back to the
  // resting label. Errors persist until the next call replaces them.
  const [decayed, setDecayed] = useState(false);
  useEffect(() => {
    setDecayed(false);
    if (activity?.status !== "settled" || activity.isError) return;
    const id = setTimeout(() => setDecayed(true), SETTLED_DECAY_MS);
    return () => clearTimeout(id);
  }, [activity]);

  if (!sessionId) return null;

  // Settled rows always render (a sub-400ms call settles before its gate
  // fires, matching the old "never flicker the spinner" behavior); in-flight
  // rows wait out the gate showing the resting label instead of a flash.
  const showLive = Boolean(
    activity && (activity.status === "settled" ? !decayed : shownKey === rowKey)
  );

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label="Recent tool calls"
          title={activity && showLive ? buildTitle(activity) : "Recent tool calls"}
          className={cn(
            "flex items-center gap-1.5 min-w-0 transition-colors duration-150 ease-out",
            "hover:text-daintree-text/60 focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-primary focus-visible:outline-offset-2",
            showLive && activity?.isError
              ? "text-status-danger"
              : showLive && inFlight
                ? "text-daintree-text/55"
                : undefined
          )}
        >
          {activity && showLive ? (
            <LiveContent activity={activity} inFlight={inFlight} />
          ) : (
            <span aria-hidden className="flex items-center gap-1 min-w-0">
              <Activity className="w-3.5 h-3.5 shrink-0" />
              Recent activity
            </span>
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent
        side="top"
        align="start"
        sideOffset={6}
        collisionPadding={8}
        onOpenAutoFocus={(event) => event.preventDefault()}
        aria-label="Recent tool calls"
        className="w-72"
      >
        <RecentCallsPopover records={records} loading={loading} error={error} />
      </PopoverContent>
    </Popover>
  );
}

/**
 * The live/settled row content. Deliberately compact: glyph + tool id (with
 * a same-turn coalescing count). No duration or elapsed ticker — calls are
 * almost always sub-100ms, so the metric is noise; args and per-call recency
 * live in the popover and the hover title instead.
 */
function LiveContent({
  activity,
  inFlight,
}: {
  activity: McpToolActivityState;
  inFlight: boolean;
}) {
  const coalesced = activity.callCount > 1;
  const label = coalesced ? `${activity.callCount} calls · ${activity.toolId}` : activity.toolId;
  return (
    <span aria-hidden className="flex items-center gap-1.5 min-w-0">
      <ActivityGlyph activity={activity} inFlight={inFlight} />
      <span className="font-medium truncate">{label}</span>
      {activity.danger && inFlight && <span className="shrink-0">awaiting confirmation</span>}
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

function buildTitle(activity: McpToolActivityState): string {
  const parts: string[] = [activity.toolId];
  if (activity.callCount > 1) parts.push(`${activity.callCount} calls this turn`);
  if (activity.argsSummary && activity.argsSummary !== "{}") parts.push(activity.argsSummary);
  if (activity.status === "settled" && activity.result) parts.push(activity.result);
  return parts.join(" — ");
}
