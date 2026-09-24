import { useEffect, useRef, useState } from "react";
import { Check, CircleSlash, Loader2, TriangleAlert, X } from "lucide-react";
import { Activity } from "@/components/icons";
import { Popover, PopoverTrigger, PopoverContent } from "@/components/ui/popover";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { UI_DOHERTY_THRESHOLD } from "@/lib/animationUtils";
import { logWarn } from "@/utils/logger";
import { actionService } from "@/services/ActionService";
import type { McpAuditRecord } from "@shared/types";
import type { McpToolActivityState } from "@/controllers/HelpSessionController";
import { RecentCallsPopover } from "./RecentCallsPopover";
import { FOOTER_ITEM_CLASS } from "./footerItem";

// Deliberately small — the popover is a quick glance at what the assistant
// just did, not a full audit surface.
const MAX_RECENT_CALLS = 5;

/** DOM id of the full audit log on the MCP server settings tab. */
const MCP_AUDIT_LOG_SECTION_ID = "mcp-audit-log";

/**
 * How long a settled success row stays visible before decaying back to the
 * resting glyph. Errors do not decay — a failed call is the
 * one ambient signal worth keeping until the next call supersedes it.
 */
const SETTLED_DECAY_MS = 5000;

interface McpActivityStripProps {
  /** Current assistant session. Empty/null means hibernated — strip is hidden. */
  sessionId: string | null;
  /** Live tool-call state pushed from the controller (#9759). */
  activity: McpToolActivityState | null;
  /** A crowded footer: the live row keeps its glyph and drops the tool id. */
  compact?: boolean;
}

/**
 * The footer's single activity element: live tool-call status and the
 * recent-calls history share one always-mounted popover trigger. At rest it
 * is the Activity glyph alone; while a call runs it shows a spinner + tool id
 * (coalescing same-turn bursts as "2 calls · tool"); a settled call shows its
 * glyph + duration, then successes decay back to the resting glyph.
 *
 * The button's accessible name is pinned to "Recent tool calls" — morphing
 * text inside a focused control is unreliable across screen readers, so the
 * live content is presentation-only and the popover is the accessible record.
 *
 * Doherty gate: the in-flight row is withheld for the first 400ms so a
 * sub-400ms call settles first and renders its settled state directly —
 * during the gate the previous content (resting glyph or last settled call)
 * stays put instead of flickering a spinner.
 */
export function McpActivityStrip({ sessionId, activity, compact = false }: McpActivityStripProps) {
  const [open, setOpen] = useState(false);
  const [records, setRecords] = useState<McpAuditRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  // Bumped to re-read the log without closing: a Retry, or a call settling
  // while the popover is open.
  const [reloadKey, setReloadKey] = useState(0);

  // Monotonic token: discard any fetch that resolves after a newer open/session
  // change so a slow response can't overwrite fresher state.
  const fetchSeq = useRef(0);
  const hasRecords = useRef(false);

  // A session change invalidates the open popover — its calls belong to the old
  // session. Close it, drop the stale list, and bump the fetch token so any
  // in-flight request from the previous session can't land its results.
  useEffect(() => {
    fetchSeq.current++;
    hasRecords.current = false;
    setOpen(false);
    setRecords([]);
    setLoading(false);
    setError(false);
  }, [sessionId]);

  useEffect(() => {
    if (!open || !sessionId) return;

    const seq = ++fetchSeq.current;
    // A refresh keeps the rows on screen; only a first read shows the skeleton.
    setLoading((wasLoading) => wasLoading || !hasRecords.current);

    void (async () => {
      try {
        const all = await window.electron.mcpServer.getAuditRecords();
        if (fetchSeq.current !== seq) return;
        // Audit records carry the MCP transport id in `sessionId`; the help
        // session id the renderer holds only ever matches `helpSessionId`.
        const mine = all.filter((r) => r.helpSessionId === sessionId).slice(0, MAX_RECENT_CALLS);
        hasRecords.current = mine.length > 0;
        setRecords(mine);
        setLoading(false);
        // Cleared on success rather than at the start, so a retry in flight
        // keeps its error row (and its focused button) until it has an answer.
        setError(false);
      } catch (err) {
        if (fetchSeq.current !== seq) return;
        logWarn("[McpActivityStrip] Failed to load audit records", { error: err });
        setError(true);
        setLoading(false);
      }
    })();
  }, [open, sessionId, reloadKey]);

  // A call that settles while the popover is open is exactly the one the user
  // opened it to watch for, so the list follows it rather than going stale.
  const settledKey =
    activity?.status === "settled"
      ? `${activity.turnId ?? activity.startedAt}:${activity.callCount}`
      : null;
  useEffect(() => {
    if (settledKey !== null) setReloadKey((k) => k + 1);
  }, [settledKey]);

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
    // the gate and flash back to the resting glyph mid-burst.
    if (activity?.status === "settled") {
      setShownKey(rowKey);
      return;
    }
    if (!inFlight) return;
    const id = setTimeout(() => setShownKey(rowKey), UI_DOHERTY_THRESHOLD);
    return () => clearTimeout(id);
  }, [activity?.status, inFlight, rowKey, shownKey]);

  // Success decay: after a quiet period the settled row yields back to the
  // resting glyph. Errors persist until the next call replaces them.
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
  // rows wait out the gate showing the resting glyph instead of a flash.
  const showLive = Boolean(
    activity && (activity.status === "settled" ? !decayed : shownKey === rowKey)
  );

  const tooltip = activity && showLive ? buildTitle(activity) : "Recent tool calls";
  const awaiting = Boolean(showLive && inFlight && activity?.danger);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <Tooltip>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            <button
              type="button"
              aria-label="Recent tool calls"
              className={cn(
                FOOTER_ITEM_CLASS,
                "hover:text-text-primary",
                // Room for the glyph and a few characters of text; below that
                // the footer compacts the row instead of squeezing this. A
                // confirmation keeps its words even then, because it is the
                // one live state waiting on the user.
                showLive && (!compact || awaiting) ? "min-w-[5.5rem]" : "min-w-0",
                showLive && activity?.isError
                  ? "text-status-danger hover:text-status-danger"
                  : showLive && inFlight
                    ? "text-text-secondary"
                    : undefined
              )}
            >
              {activity && showLive ? (
                <LiveContent activity={activity} inFlight={inFlight} compact={compact} />
              ) : (
                // At rest this is only the way into the history, so it is a
                // glyph: a permanent caption here competed with every signal
                // that shares the row and wrapped the row at default width.
                <Activity aria-hidden className="w-3.5 h-3.5 shrink-0" />
              )}
            </button>
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent side="top">{tooltip}</TooltipContent>
      </Tooltip>
      <PopoverContent
        side="top"
        align="start"
        sideOffset={6}
        collisionPadding={8}
        onOpenAutoFocus={(event) => event.preventDefault()}
        aria-label="Recent tool calls"
        className="w-80 max-w-[var(--radix-popover-content-available-width)]"
      >
        <RecentCallsPopover
          records={records}
          loading={loading}
          error={error}
          onRetry={() => setReloadKey((k) => k + 1)}
          onOpenAuditLog={() => {
            setOpen(false);
            void actionService.dispatch(
              "app.settings.openTab",
              { tab: "mcp", sectionId: MCP_AUDIT_LOG_SECTION_ID },
              { source: "user" }
            );
          }}
        />
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
  compact,
}: {
  activity: McpToolActivityState;
  inFlight: boolean;
  compact: boolean;
}) {
  const coalesced = activity.callCount > 1;
  const label = coalesced ? `${activity.callCount} calls · ${activity.toolId}` : activity.toolId;
  // A call waiting on the user outranks its own tool id: the id moves to the
  // tooltip and the words stay, truncating rather than disappearing.
  const text = activity.danger && inFlight ? "Awaiting confirmation" : compact ? null : label;
  return (
    <span aria-hidden className="flex items-center gap-1.5 min-w-0">
      <ActivityGlyph activity={activity} inFlight={inFlight} />
      {text && <span className="font-medium truncate min-w-0">{text}</span>}
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
    return (
      <span aria-hidden className="inline-flex shrink-0 animate-spin">
        <Loader2 className="w-3 h-3" />
      </span>
    );
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
  // The footer can truncate this label to "Awaiting…", so the tooltip is where
  // it reads in full.
  if (activity.danger && activity.status === "in-flight") parts.unshift("Awaiting confirmation");
  if (activity.callCount > 1) parts.push(`${activity.callCount} calls this turn`);
  if (activity.argsSummary && activity.argsSummary !== "{}") parts.push(activity.argsSummary);
  if (activity.status === "settled" && activity.result) parts.push(activity.result);
  return parts.join(" — ");
}
