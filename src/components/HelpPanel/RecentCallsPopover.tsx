import { useMemo } from "react";
import { ExternalLink } from "lucide-react";
import { cn } from "@/lib/utils";
import type { McpAuditRecord, McpAuditResult } from "@shared/types";

// Local, deliberately-minimal mirror of the Settings audit viewer's styling.
// The popover is a simpler read-only view; cross-importing from Settings would
// create a HelpPanel → Settings layer dependency for two stable constants.
const RESULT_DOT_CLASS: Record<McpAuditResult, string> = {
  success: "bg-status-success",
  error: "bg-status-danger",
  "confirmation-pending": "bg-status-warning",
  unauthorized: "bg-status-danger",
  dedup: "bg-status-info",
  collision: "bg-status-warning",
  rate_limited: "bg-status-warning",
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

export function formatCallDuration(durationMs: number): string {
  if (durationMs <= 0) return "0ms";
  if (durationMs < 100) return "<100ms";
  if (durationMs < 1000) return `${Math.round(durationMs)}ms`;
  return `${(durationMs / 1000).toFixed(1)}s`;
}

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
  onViewFullAuditLog: () => void;
}

export function RecentCallsPopover({
  records,
  loading,
  error,
  onViewFullAuditLog,
}: RecentCallsPopoverProps) {
  const groups = useMemo(() => groupCallsByTurn(records), [records]);

  return (
    <div className="flex flex-col text-[11px] text-daintree-text">
      <div className="px-3 pt-2.5 pb-1.5 text-daintree-text/50 font-medium">Recent tool calls</div>

      <div className="max-h-[min(320px,var(--radix-popover-content-available-height,320px))] overflow-y-auto px-1 pb-1">
        {loading ? (
          <div className="space-y-1.5 px-2 py-1.5" aria-hidden>
            <div className="h-3 w-5/6 rounded bg-daintree-text/10 animate-pulse" />
            <div className="h-3 w-4/6 rounded bg-daintree-text/10 animate-pulse" />
            <div className="h-3 w-3/4 rounded bg-daintree-text/10 animate-pulse" />
          </div>
        ) : error ? (
          <p className="px-2 py-3 text-daintree-text/50">Couldn't load recent calls</p>
        ) : records.length === 0 ? (
          <p className="px-2 py-3 text-daintree-text/50">No calls yet this session</p>
        ) : (
          <ul className="divide-y divide-daintree-border/60">
            {groups.map((group, index) => (
              <li key={group.turnId ?? `unassociated-${index}`} className="py-1">
                <ul className="space-y-0.5">
                  {group.records.map((record) => (
                    <li
                      key={record.id}
                      className="grid grid-cols-[auto_1fr_auto] items-start gap-2 px-2 py-0.5"
                    >
                      <span
                        aria-hidden
                        className={cn(
                          "mt-1 h-1.5 w-1.5 rounded-full shrink-0",
                          RESULT_DOT_CLASS[record.result]
                        )}
                        title={RESULT_LABEL[record.result]}
                      />
                      <div className="min-w-0">
                        <div className="font-mono text-daintree-text/80 truncate">
                          {record.toolId}
                        </div>
                        <div className="font-mono text-daintree-text/45 truncate">
                          {record.argsSummary || "{}"}
                        </div>
                      </div>
                      <span className="text-daintree-text/40 whitespace-nowrap tabular-nums">
                        {formatCallDuration(record.durationMs)}
                      </span>
                    </li>
                  ))}
                </ul>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="border-t border-daintree-border px-1 py-1">
        <button
          type="button"
          onClick={onViewFullAuditLog}
          className="flex w-full items-center gap-1.5 rounded-[var(--radius-md)] px-2 py-1.5 text-daintree-text/70 hover:text-daintree-text hover:bg-overlay-soft transition-colors duration-150 ease-out focus-visible:outline focus-visible:outline-2 focus-visible:outline-daintree-accent focus-visible:outline-offset-2"
        >
          <ExternalLink className="w-3.5 h-3.5 shrink-0" />
          View full audit log
        </button>
      </div>
    </div>
  );
}
