import { useMemo, useState } from "react";
import { ChevronRight } from "lucide-react";
import { Skeleton, SkeletonBone } from "@/components/ui/Skeleton";
import { cn } from "@/lib/utils";
import { SeverityMark, type StatusSeverity } from "@/lib/statusSeverity";
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

interface RecentCallsPopoverProps {
  records: McpAuditRecord[];
  loading: boolean;
  error: boolean;
}

export function RecentCallsPopover({ records, loading, error }: RecentCallsPopoverProps) {
  const groups = useMemo(() => groupCallsByTurn(records), [records]);

  return (
    <div className="flex flex-col text-[11px] text-daintree-text">
      <div className="px-3 pt-2.5 pb-1.5 text-daintree-text/50 font-medium">Recent tool calls</div>

      <div className="max-h-[min(360px,var(--radix-popover-content-available-height,360px))] overflow-y-auto px-1 pb-1">
        {loading ? (
          <Skeleton label="Loading recent calls" className="space-y-1.5 px-2 py-1.5">
            <SkeletonBone className="h-3 w-5/6" />
            <SkeletonBone className="h-3 w-4/6" />
            <SkeletonBone className="h-3 w-3/4" />
          </Skeleton>
        ) : error ? (
          <p className="px-2 py-3 text-daintree-text/50">Couldn't load recent calls</p>
        ) : records.length === 0 ? (
          <p className="px-2 py-3 text-daintree-text/50">No calls yet this session</p>
        ) : (
          <ul className="divide-y divide-daintree-border/60">
            {groups.map((group, index) => (
              <li key={group.turnId ?? `unassociated-${index}`} className="py-1">
                {group.turnId === null && (
                  <div className="px-2 pb-0.5 text-[10px] text-daintree-text/40">
                    Not tied to a turn
                  </div>
                )}
                <ul className="space-y-0.5">
                  {group.records.map((record) => (
                    <RecentCallRow key={record.id} record={record} />
                  ))}
                </ul>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

/**
 * One call, expandable in place. The collapsed row stays scannable (status
 * dot, tool id, duration); expanding reveals the full redacted args, the
 * call's result output, and the outcome label — the detail an ambient footer
 * can't carry (#9763).
 */
function RecentCallRow({ record }: { record: McpAuditRecord }) {
  const [expanded, setExpanded] = useState(false);
  const hasArgs = record.argsSummary !== "" && record.argsSummary !== "{}";

  return (
    <li>
      <button
        type="button"
        aria-expanded={expanded}
        onClick={() => setExpanded((v) => !v)}
        className="grid w-full grid-cols-[auto_auto_1fr_auto] items-center gap-2 rounded-[var(--radius-md)] px-2 py-1 text-left hover:bg-overlay-soft transition-colors duration-150 ease-out focus-visible:outline focus-visible:outline-2 focus-visible:outline-daintree-accent focus-visible:-outline-offset-2"
      >
        <ChevronRight
          aria-hidden
          className={cn(
            "w-3 h-3 shrink-0 text-daintree-text/40 transition-transform duration-150 ease-out",
            expanded && "rotate-90"
          )}
        />
        <SeverityMark
          severity={RESULT_SEVERITY[record.result]}
          label={RESULT_LABEL[record.result]}
          className="h-3 w-3"
          decorative
        />
        <span className="min-w-0 font-mono text-daintree-text/80 truncate">{record.toolId}</span>
        {/* Recency, not duration — calls are almost always sub-100ms, so
            "when did this run" is the metric worth a column. */}
        <span className="text-daintree-text/40 whitespace-nowrap tabular-nums">
          {formatTimeAgo(record.timestamp)}
        </span>
      </button>
      {expanded && (
        <div className="mx-2 mb-1.5 flex flex-col gap-1.5 rounded-[var(--radius-md)] bg-overlay-subtle px-2 py-1.5 select-text">
          <div className="flex items-center gap-2 text-daintree-text/50">
            <span
              className={cn(
                record.result === "error" || record.result === "unauthorized"
                  ? "text-status-danger"
                  : undefined
              )}
            >
              {RESULT_LABEL[record.result]}
              {record.errorCode ? ` · ${record.errorCode}` : ""}
            </span>
          </div>
          {hasArgs && (
            <div>
              <div className="text-daintree-text/40">Arguments</div>
              <pre className="mt-0.5 max-h-32 overflow-y-auto whitespace-pre-wrap break-all font-mono text-daintree-text/70">
                {record.argsSummary}
              </pre>
            </div>
          )}
          <div>
            <div className="text-daintree-text/40">Result</div>
            {record.result === "rate_limited" && record.resultMeta?.retryAfter !== undefined ? (
              <p className="mt-0.5 text-daintree-text/45">
                Retry in {record.resultMeta.retryAfter}s
              </p>
            ) : record.resultSummary ? (
              <pre className="mt-0.5 max-h-48 overflow-y-auto whitespace-pre-wrap break-all font-mono text-daintree-text/70">
                {record.resultSummary}
              </pre>
            ) : (
              <p className="mt-0.5 text-daintree-text/45">No output recorded for this call</p>
            )}
          </div>
        </div>
      )}
    </li>
  );
}
