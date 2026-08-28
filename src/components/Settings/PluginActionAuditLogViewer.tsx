import { useMemo, useState } from "react";
import { Check, Copy, Download, Eye, RefreshCw } from "lucide-react";
import { cn } from "@/lib/utils";
import { SeverityMark, type StatusSeverity } from "@/lib/statusSeverity";
import { useGlobalMinuteTicker } from "@/hooks/useGlobalMinuteTicker";
import { EmptyState } from "@/components/ui/EmptyState";
import { Skeleton, SkeletonBone } from "@/components/ui/Skeleton";
import type {
  PluginActionAuditRecord,
  PluginActionAuditRecordType,
  PluginActionAuditResult,
} from "@shared/types";

type ResultFilter = "all" | PluginActionAuditResult;

// Only the non-default record types get a tag — `action-dispatch` is the common
// case and is left unlabeled to keep ordinary dispatch rows uncluttered.
const RECORD_TYPE_LABEL: Partial<Record<PluginActionAuditRecordType, string>> = {
  "ipc-invoke": "IPC",
  "decoration-failure": "Decoration",
};

const RESULT_LABEL: Record<PluginActionAuditResult, string> = {
  success: "Success",
  error: "Error",
  disabled: "Disabled",
  restricted: "Restricted",
};

const RESULT_SEVERITY: Record<PluginActionAuditResult, StatusSeverity> = {
  success: "success",
  error: "error",
  disabled: "warning",
  restricted: "error",
};

type TimeRange = "5m" | "1h" | "24h" | "all";

const TIME_RANGE_MS: Record<Exclude<TimeRange, "all">, number> = {
  "5m": 300_000,
  "1h": 3_600_000,
  "24h": 86_400_000,
};

function formatRelativeTimestamp(ts: number, now: number): string {
  const diffMs = now - ts;
  if (diffMs < 0) return "just now";
  const sec = Math.floor(diffMs / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  return `${Math.floor(hr / 24)}d ago`;
}

interface PluginActionAuditLogViewerProps {
  records: PluginActionAuditRecord[];
  loading: boolean;
  maxRecords: number;
  onRefresh: () => Promise<void> | void;
  onCopy: (records: PluginActionAuditRecord[]) => Promise<void> | void;
  onExport: (records: PluginActionAuditRecord[]) => Promise<void> | void;
  onClear: () => void;
  copyFlashActive?: boolean;
  exportFlashActive?: boolean;
  /**
   * When true, successful dispatches are included in the default view. Off by
   * default so the rare error/restricted rows aren't drowned out by a flood of
   * `success` records. Opt-in via the developer-mode toggle on the parent tab.
   */
  developerMode?: boolean;
}

export function PluginActionAuditLogViewer({
  records,
  loading,
  maxRecords,
  onRefresh,
  onCopy,
  onExport,
  onClear,
  copyFlashActive,
  exportFlashActive,
  developerMode = false,
}: PluginActionAuditLogViewerProps) {
  const [pluginFilter, setPluginFilter] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const [resultFilter, setResultFilter] = useState<ResultFilter>("all");
  const [timeRange, setTimeRange] = useState<TimeRange>("all");
  const [showSuccessful, setShowSuccessful] = useState(false);

  const tick = useGlobalMinuteTicker();
  const now = useMemo(() => {
    void tick;
    return Date.now();
  }, [tick]);

  // Whether the rendered list will visibly hide successful records. The toggle
  // is the user's expressed intent, but `resultFilter === "success"` means the
  // user explicitly asked for that bucket — don't filter them back out.
  const suppressSuccess = !showSuccessful && resultFilter !== "success";

  const filteredRecords = useMemo(() => {
    const needle = pluginFilter.trim().toLowerCase();
    const search = searchQuery.trim().toLowerCase();
    const cutoffMs = timeRange !== "all" ? now - TIME_RANGE_MS[timeRange] : undefined;
    return records.filter((record) => {
      if (cutoffMs !== undefined && record.ts < cutoffMs) return false;
      if (suppressSuccess && record.result === "success") return false;
      if (resultFilter !== "all" && record.result !== resultFilter) return false;
      if (
        needle.length > 0 &&
        !record.pluginId.toLowerCase().includes(needle) &&
        !record.actionId.toLowerCase().includes(needle)
      ) {
        return false;
      }
      if (search.length > 0) {
        const args = record.argsPlaintext ?? "";
        const hash = record.argsHash ?? "";
        const error = record.errorMessage ?? "";
        if (
          !args.toLowerCase().includes(search) &&
          !hash.toLowerCase().includes(search) &&
          !error.toLowerCase().includes(search)
        ) {
          return false;
        }
      }
      return true;
    });
  }, [records, pluginFilter, searchQuery, resultFilter, suppressSuccess, timeRange, now]);

  const isFiltering =
    pluginFilter.trim().length > 0 ||
    searchQuery.trim().length > 0 ||
    resultFilter !== "all" ||
    timeRange !== "all" ||
    suppressSuccess;
  const showCopyAll = filteredRecords.length === records.length;

  return (
    <div className="contents">
      <div className="flex flex-wrap items-center gap-2">
        <input
          type="text"
          value={pluginFilter}
          onChange={(e) => setPluginFilter(e.target.value)}
          placeholder="Filter by plugin or action ID"
          aria-label="Filter audit by plugin or action ID"
          className="flex-1 min-w-[180px] bg-surface-canvas border border-border-strong rounded-[var(--radius-md)] px-2 py-1 text-xs text-text-primary placeholder:text-text-placeholder font-mono focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-primary focus-visible:outline-offset-2"
        />
        <input
          type="text"
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          placeholder="Search arguments or errors"
          aria-label="Search audit arguments or error messages"
          className="w-40 bg-surface-canvas border border-border-strong rounded-[var(--radius-md)] px-2 py-1 text-xs text-text-primary placeholder:text-text-placeholder font-mono focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-primary focus-visible:outline-offset-2"
        />
        <select
          value={resultFilter}
          onChange={(e) => {
            const value = e.target.value;
            if (
              value === "all" ||
              value === "success" ||
              value === "error" ||
              value === "disabled" ||
              value === "restricted"
            ) {
              setResultFilter(value);
            }
          }}
          aria-label="Filter audit by result"
          className="bg-surface-canvas border border-border-strong rounded-[var(--radius-md)] px-2 py-1 text-xs text-text-primary focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-primary focus-visible:outline-offset-2"
        >
          <option value="all">All results</option>
          <option value="success">Success</option>
          <option value="error">Error</option>
          <option value="disabled">Disabled</option>
          <option value="restricted">Restricted</option>
        </select>
        <select
          value={timeRange}
          onChange={(e) => {
            const value = e.target.value;
            if (value === "5m" || value === "1h" || value === "24h" || value === "all") {
              setTimeRange(value);
            }
          }}
          aria-label="Filter audit by time range"
          className="bg-surface-canvas border border-border-strong rounded-[var(--radius-md)] px-2 py-1 text-xs text-text-primary focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-primary focus-visible:outline-offset-2"
        >
          <option value="all">All</option>
          <option value="5m">Last 5 minutes</option>
          <option value="1h">Last hour</option>
          <option value="24h">Last 24 hours</option>
        </select>
        {developerMode && (
          <button
            type="button"
            onClick={() => setShowSuccessful((v) => !v)}
            className={cn(
              "flex items-center gap-1.5 px-2 py-1 text-xs font-medium rounded-[var(--radius-md)] border transition-colors",
              showSuccessful
                ? "bg-overlay-subtle border-border-default text-text-primary"
                : "border-border-default text-text-secondary hover:text-text-primary hover:bg-overlay-soft"
            )}
            aria-pressed={showSuccessful}
          >
            <Eye className="w-3.5 h-3.5" />
            Show successful dispatches
          </button>
        )}
      </div>

      <div className="max-h-64 overflow-y-auto rounded-[var(--radius-md)] border border-border-default bg-surface-canvas">
        {loading ? (
          <Skeleton label="Loading audit records" className="space-y-2 p-3">
            <SkeletonBone className="h-5 w-5/6" />
            <SkeletonBone className="h-5 w-4/6" />
            <SkeletonBone className="h-5 w-3/4" />
          </Skeleton>
        ) : filteredRecords.length === 0 ? (
          records.length === 0 ? (
            <EmptyState
              variant="zero-data"
              scale="sidebar"
              title="No plugin actions recorded yet"
            />
          ) : suppressSuccess &&
            pluginFilter.trim().length === 0 &&
            searchQuery.trim().length === 0 &&
            resultFilter === "all" &&
            timeRange === "all" ? (
            <EmptyState
              variant="user-cleared"
              scale="sidebar"
              title="No errors or restricted dispatches"
            />
          ) : (
            <EmptyState
              variant="filtered-empty"
              scale="sidebar"
              title="No records match the current filters"
            />
          )
        ) : (
          <ul className="divide-y divide-border-default">
            {filteredRecords.map((record) => (
              <li key={record.id} className="grid grid-cols-[auto_1fr_auto] gap-2 p-2 text-xs">
                <SeverityMark
                  severity={RESULT_SEVERITY[record.result]}
                  label={RESULT_LABEL[record.result]}
                  className="mt-0.5 h-3 w-3"
                />
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-text-primary truncate">{record.actionId}</span>
                    {record.source ? (
                      <span className="text-3xs uppercase tracking-wide text-text-secondary">
                        {record.source}
                      </span>
                    ) : record.recordType && RECORD_TYPE_LABEL[record.recordType] ? (
                      <span className="text-3xs uppercase tracking-wide text-text-secondary">
                        {RECORD_TYPE_LABEL[record.recordType]}
                      </span>
                    ) : null}
                  </div>
                  <div className="mt-0.5 font-mono text-text-secondary truncate">
                    {record.pluginId}
                  </div>
                  {record.errorMessage ? (
                    <div
                      className="mt-0.5 text-status-danger/80 truncate"
                      title={record.errorMessage}
                    >
                      {record.errorMessage}
                    </div>
                  ) : null}
                  {record.argsPlaintext ? (
                    <div className="mt-0.5 font-mono text-text-secondary truncate">
                      {record.argsPlaintext}
                    </div>
                  ) : record.argsHash ? (
                    <div className="mt-0.5 font-mono text-text-secondary truncate">
                      sha256:{record.argsHash.slice(0, 16)}…
                    </div>
                  ) : null}
                </div>
                <div className="text-right text-text-secondary whitespace-nowrap">
                  <div>{formatRelativeTimestamp(record.ts, now)}</div>
                  <div>{record.durationMs}ms</div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => void onRefresh()}
          className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-[var(--radius-md)] border border-border-default text-text-secondary hover:text-text-primary hover:bg-overlay-soft transition-colors"
          aria-label="Refresh audit log"
        >
          <RefreshCw className="w-3.5 h-3.5" />
          Refresh
        </button>
        <button
          type="button"
          onClick={() => void onCopy(filteredRecords)}
          disabled={filteredRecords.length === 0}
          className={cn(
            "flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-[var(--radius-md)] border transition-colors",
            filteredRecords.length === 0
              ? "border-border-default text-daintree-text/30 cursor-not-allowed"
              : copyFlashActive
                ? "text-status-success border-status-success/30"
                : "border-border-default text-text-secondary hover:text-text-primary hover:bg-overlay-soft"
          )}
        >
          {copyFlashActive ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
          {copyFlashActive ? "Copied!" : `Copy ${showCopyAll ? "all" : "filtered"} as JSON`}
        </button>
        <button
          type="button"
          onClick={() => void onExport(filteredRecords)}
          disabled={filteredRecords.length === 0}
          className={cn(
            "flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-[var(--radius-md)] border transition-colors",
            filteredRecords.length === 0
              ? "border-border-default text-daintree-text/30 cursor-not-allowed"
              : exportFlashActive
                ? "text-status-success border-status-success/30"
                : "border-border-default text-text-secondary hover:text-text-primary hover:bg-overlay-soft"
          )}
        >
          {exportFlashActive ? (
            <Check className="w-3.5 h-3.5" />
          ) : (
            <Download className="w-3.5 h-3.5" />
          )}
          {exportFlashActive ? "Exported!" : "Export as NDJSON"}
        </button>
        <button
          type="button"
          onClick={onClear}
          disabled={records.length === 0}
          className={cn(
            "px-3 py-1.5 text-xs font-medium rounded-[var(--radius-md)] border transition-colors",
            records.length === 0
              ? "border-border-default text-daintree-text/30 cursor-not-allowed"
              : "border-border-default text-status-danger hover:text-status-danger hover:bg-status-danger/10 hover:border-status-danger/20"
          )}
        >
          Clear log
        </button>
        <span className="ml-auto text-xs text-text-secondary">
          {isFiltering
            ? `${filteredRecords.length} of ${records.length}`
            : `${records.length} of ${maxRecords}`}
        </span>
      </div>
    </div>
  );
}
