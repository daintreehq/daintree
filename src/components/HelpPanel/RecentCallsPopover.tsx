import { useEffect, useId, useMemo, useRef, useState } from "react";
import { Check, ChevronRight, Copy } from "lucide-react";
import { Skeleton, SkeletonBone, SkeletonHint } from "@/components/ui/Skeleton";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { SeverityMark, type StatusSeverity } from "@/lib/statusSeverity";
import { useGlobalMinuteTicker } from "@/hooks/useGlobalMinuteTicker";
import { useCopyWithFeedback } from "@/hooks/useCopyWithFeedback";
import { formatTimeAgo } from "@/utils/timeAgo";
import type { McpAuditRecord, McpAuditResult } from "@shared/types";

// Local mirror of the Settings audit viewer's outcome→severity mapping. The
// popover is a simpler read-only view; cross-importing from Settings would
// create a HelpPanel → Settings layer dependency for two stable constants. The
// glyphs themselves are shared, so the two views still agree on shape and tone.
const RESULT_SEVERITY: Record<McpAuditResult, StatusSeverity> = {
  success: "success",
  error: "error",
  "confirmation-pending": "warning",
  unauthorized: "error",
  dedup: "info",
  collision: "warning",
  rate_limited: "warning",
};

const RESULT_LABEL: Record<McpAuditResult, string> = {
  success: "Success",
  error: "Error",
  "confirmation-pending": "Awaiting confirmation",
  unauthorized: "Unauthorized",
  dedup: "Deduplicated",
  collision: "Key collision",
  rate_limited: "Rate limited",
};

// Payloads wrap at their own spaces first and only split a token that is wider
// than the line; `break-all` split every token at the edge, paths included.
const PAYLOAD_CLASS =
  "mt-0.5 whitespace-pre-wrap [overflow-wrap:anywhere] font-mono text-text-secondary";

export interface RecentCallGroup {
  /** `turnId` for associated calls, or `null` for the unassociated bucket. */
  turnId: string | null;
  records: McpAuditRecord[];
}

/**
 * Group records by `turnId`, preserving the input order (callers pass the
 * newest-first ring-buffer slice). Records without a `turnId` collapse into a
 * single trailing `turnId: null` group so they still surface in the list.
 */
export function groupCallsByTurn(records: McpAuditRecord[]): RecentCallGroup[] {
  const byTurn = new Map<string, McpAuditRecord[]>();
  const unassociated: McpAuditRecord[] = [];

  for (const record of records) {
    if (record.turnId) {
      const list = byTurn.get(record.turnId);
      if (list) list.push(record);
      else byTurn.set(record.turnId, [record]);
    } else {
      unassociated.push(record);
    }
  }

  const groups: RecentCallGroup[] = [];
  for (const [turnId, recs] of byTurn) {
    groups.push({ turnId, records: recs });
  }
  if (unassociated.length > 0) {
    groups.push({ turnId: null, records: unassociated });
  }
  return groups;
}

/**
 * What a group is called. The slice is newest-first, so the first turn group
 * holds the newest call — but it is only the latest turn *that made calls*,
 * and the slice says nothing about how many turns sit between the others, so
 * they are "earlier" rather than numbered.
 */
function groupHeading(group: RecentCallGroup, index: number): string {
  if (group.turnId === null) return "Outside any turn";
  return index === 0 ? "Latest turn" : "Earlier turn";
}

interface RecentCallsPopoverProps {
  records: McpAuditRecord[];
  loading: boolean;
  error: boolean;
  /** A read is in flight, including a background refresh that shows no skeleton. */
  busy: boolean;
  onRetry: () => void;
  onOpenAuditLog: () => void;
}

export function RecentCallsPopover({
  records,
  loading,
  error,
  busy,
  onRetry,
  onOpenAuditLog,
}: RecentCallsPopoverProps) {
  const groups = useMemo(() => groupCallsByTurn(records), [records]);
  // Ages stay honest while the popover sits open; the ticker only runs while
  // something is subscribed.
  const tick = useGlobalMinuteTicker();
  const now = useMemo(() => {
    void tick;
    return Date.now();
  }, [tick]);
  const baseId = useId();

  // Recovery unmounts Retry. If it still held focus at that moment — the user
  // didn't move on while the read was in flight — hand focus to the first call
  // rather than dropping it on the document.
  const containerRef = useRef<HTMLDivElement>(null);
  const retryHasFocus = useRef(false);
  useEffect(() => {
    if (error || !retryHasFocus.current) return;
    retryHasFocus.current = false;
    containerRef.current?.querySelector<HTMLButtonElement>("button")?.focus();
  }, [error]);

  // `Button` owns its own `aria-busy` (through `loading`, which paints an
  // undelayed spinner a sub-second read would only flash), so the in-flight
  // state sits on the row the Retry belongs to.
  const retry = (
    <Button
      variant="outline"
      size="xs"
      onClick={onRetry}
      onFocus={() => {
        retryHasFocus.current = true;
      }}
      // A blur with somewhere to go is the user moving on; one without is the
      // button being removed, which is the case the handoff exists for.
      onBlur={(event) => {
        if (event.relatedTarget) retryHasFocus.current = false;
      }}
    >
      Retry
    </Button>
  );

  return (
    // The whole surface fits the space Radix measured, header and footer
    // included; only the list between them gives way.
    <div
      ref={containerRef}
      className="flex max-h-[min(440px,var(--radix-popover-content-available-height,440px))] flex-col text-2xs text-text-primary"
    >
      <div className="shrink-0 px-3 pt-2.5 pb-1.5 text-text-secondary font-medium">
        Recent tool calls
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-1 pb-1">
        {error && records.length === 0 ? (
          // Checked before `loading` so a retry in flight keeps its button.
          <div
            role="alert"
            aria-busy={busy || undefined}
            className="flex items-center justify-between gap-2 px-2 py-1.5"
          >
            <span className="text-text-secondary">Couldn't load recent calls</span>
            {retry}
          </div>
        ) : loading ? (
          <>
            <Skeleton label="Loading recent calls" className="space-y-1.5 px-2 py-1.5">
              <SkeletonBone className="h-3 w-5/6" />
              <SkeletonBone className="h-3 w-4/6" />
              <SkeletonBone className="h-3 w-3/4" />
            </Skeleton>
            <SkeletonHint firstThreshold={5000} className="px-2" />
          </>
        ) : records.length === 0 ? (
          <p className="px-2 py-1.5 text-text-secondary">
            Ask the assistant to work on your project to see its tool calls here
          </p>
        ) : (
          <>
            {/* A failed refresh keeps what was already read on screen. */}
            {error && (
              <div
                role="alert"
                aria-busy={busy || undefined}
                className="flex items-center justify-between gap-2 px-2 py-1"
              >
                <span className="text-text-secondary">Couldn't refresh recent calls</span>
                {retry}
              </div>
            )}
            <ul className="divide-y divide-border-subtle">
              {groups.map((group, index) => {
                const headingId = `${baseId}-group-${index}`;
                return (
                  <li key={group.turnId ?? "unassociated"} className="py-1">
                    <div id={headingId} className="px-2 pt-0.5 pb-0.5 text-3xs text-text-secondary">
                      {groupHeading(group, index)}
                    </div>
                    <ul aria-labelledby={headingId} className="space-y-0.5">
                      {group.records.map((record) => (
                        <RecentCallRow key={record.id} record={record} now={now} />
                      ))}
                    </ul>
                  </li>
                );
              })}
            </ul>
          </>
        )}
      </div>

      {/* The popover is five calls by design; the rest of the history is one
          step away rather than something the user has to know to look for. */}
      <div className="shrink-0 border-t border-border-subtle px-1 py-1">
        <button
          type="button"
          onClick={onOpenAuditLog}
          className="w-full rounded-[var(--radius-md)] px-2 py-1 text-left text-text-secondary hover:bg-overlay-soft hover:text-text-primary transition-colors duration-150 ease-out focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-primary focus-visible:-outline-offset-2"
        >
          Open full audit log
        </button>
      </div>
    </div>
  );
}

const TIER_HINT_LABEL: Record<"workbench" | "action" | "system", string> = {
  workbench: "workbench",
  action: "action",
  system: "system",
};

/** The outcome in words, with what a blocked call needs to go through. */
function outcomeDetail(record: McpAuditRecord): string | null {
  if (record.result === "unauthorized") {
    if (record.tierHint === null) return "Not permitted at any tier";
    if (record.tierHint)
      return `Raise capability tier to ${TIER_HINT_LABEL[record.tierHint]} to allow`;
    return null;
  }
  // Worded as what the server asked for at the time, not a live countdown —
  // the row may be minutes old by the time anyone expands it.
  if (record.result === "rate_limited" && record.resultMeta?.retryAfter !== undefined) {
    return `Asked to retry after ${record.resultMeta.retryAfter}s`;
  }
  return null;
}

/**
 * One call, expandable in place. The collapsed row stays scannable (status
 * glyph, tool id, age); expanding reveals the full tool id, the outcome, the
 * redacted args and the call's result output — the detail an ambient footer
 * can't carry (#9763).
 */
function RecentCallRow({ record, now }: { record: McpAuditRecord; now: number }) {
  const [expanded, setExpanded] = useState(false);
  const panelId = useId();
  const hasArgs = record.argsSummary !== "" && record.argsSummary !== "{}";
  const detail = outcomeDetail(record);
  const date = new Date(record.timestamp);

  return (
    <li>
      <button
        type="button"
        aria-expanded={expanded}
        aria-controls={panelId}
        onClick={() => setExpanded((v) => !v)}
        className="grid w-full grid-cols-[auto_auto_1fr_auto] items-start gap-2 rounded-[var(--radius-md)] px-2 py-1 text-left hover:bg-overlay-soft transition-colors duration-150 ease-out focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-primary focus-visible:-outline-offset-2"
      >
        <ChevronRight
          aria-hidden
          className={cn(
            "mt-px w-3 h-3 shrink-0 text-daintree-text/40 transition-transform duration-150 ease-out",
            expanded && "rotate-90"
          )}
        />
        <SeverityMark
          severity={RESULT_SEVERITY[record.result]}
          label={RESULT_LABEL[record.result]}
          className="mt-px h-3 w-3"
        />
        {/* Truncated at rest to keep the row one line; expanded, the full id
            wraps so the call can be told apart from its near-namesakes. */}
        <span
          title={expanded ? undefined : record.toolId}
          className={cn(
            "min-w-0 font-mono text-text-primary",
            expanded ? "whitespace-normal [overflow-wrap:anywhere]" : "truncate"
          )}
        >
          {record.toolId}
        </span>
        {/* Recency, not duration — calls are almost always sub-100ms, so
            "when did this run" is the metric worth a column. */}
        <time
          dateTime={date.toISOString()}
          title={date.toLocaleString()}
          className="text-text-secondary whitespace-nowrap tabular-nums"
        >
          {formatTimeAgo(record.timestamp, now)}
        </time>
      </button>
      <div id={panelId} hidden={!expanded}>
        {expanded && (
          <div className="mx-2 mb-1.5 flex flex-col gap-1.5 rounded-[var(--radius-md)] bg-overlay-subtle px-2 py-1.5 select-text">
            <div className="flex flex-col gap-0.5">
              <span
                className={cn(
                  record.result === "error" || record.result === "unauthorized"
                    ? "text-status-danger"
                    : "text-text-secondary"
                )}
              >
                {RESULT_LABEL[record.result]}
                {record.errorCode ? ` · ${record.errorCode}` : ""}
              </span>
              {detail && <span className="text-text-secondary">{detail}</span>}
            </div>
            {hasArgs && <Payload label="Arguments" text={record.argsSummary} />}
            {record.resultSummary ? (
              <Payload label="Result" text={record.resultSummary} />
            ) : (
              !detail && <p className="text-text-secondary">No output recorded for this call</p>
            )}
          </div>
        )}
      </div>
    </li>
  );
}

/** A labelled, copyable block of redacted JSON or output. */
function Payload({ label, text }: { label: string; text: string }) {
  const { copied, copy } = useCopyWithFeedback();
  return (
    <div>
      <div className="flex items-center justify-between gap-2">
        <span className="text-text-secondary">{label}</span>
        <button
          type="button"
          onClick={() => void copy(text)}
          aria-label={`Copy ${label.toLowerCase()}`}
          title={`Copy ${label.toLowerCase()}`}
          className="-my-0.5 inline-flex h-5 w-5 items-center justify-center rounded-[var(--radius-sm)] text-text-secondary hover:bg-overlay-soft hover:text-text-primary transition-colors duration-150 ease-out focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-primary focus-visible:-outline-offset-2"
        >
          {copied ? (
            <Check aria-hidden className="h-3 w-3" />
          ) : (
            <Copy aria-hidden className="h-3 w-3" />
          )}
        </button>
      </div>
      <pre className={PAYLOAD_CLASS}>{text}</pre>
    </div>
  );
}
