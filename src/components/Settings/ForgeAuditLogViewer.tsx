import { useMemo, useState } from "react";
import { Check, Clock, Copy, Download, Eye, RefreshCw } from "lucide-react";
import { cn } from "@/lib/utils";
import { SeverityMark, type StatusSeverity } from "@/lib/statusSeverity";
import { useGlobalMinuteTicker } from "@/hooks/useGlobalMinuteTicker";
import { EmptyState } from "@/components/ui/EmptyState";
import { Skeleton, SkeletonBone } from "@/components/ui/Skeleton";
import type { ForgeAnomalyKind, ForgeAuditRecord, ForgeAuditResult } from "@shared/types/ipc/forge";

type ResultFilter = "all" | ForgeAuditResult;

type TimeRange = "5m" | "1h" | "24h" | "all";

const TIME_RANGE_MS: Record<Exclude<TimeRange, "all">, number> = {
  "5m": 300_000,
  "1h": 3_600_000,
  "24h": 86_400_000,
};

const RESULT_LABEL: Record<ForgeAuditResult, string> = {
  success: "Success",
  "not-found": "Not found",
  error: "Error",
};

const RESULT_SEVERITY: Record<ForgeAuditResult, StatusSeverity> = {
  success: "success",
  "not-found": "info",
  error: "error",
};

const ANOMALY_KIND_LABEL: Record<ForgeAnomalyKind, string> = {
  "latency-drift": "latency drift",
  "first-seen-method": "first-seen method",
  "failure-cluster": "failure cluster",
  "p95-z-score": "p95 outlier",
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

interface ForgeAuditLogViewerProps {
  records: ForgeAuditRecord[];
  loading: boolean;
  maxRecords: number;
  anomalySignals?: import("@shared/types/ipc/forge").ForgeAnomalySignal[];
  anomalySuppressed?: boolean;
  onRefresh: () => Promise<void> | void;
  onCopy: (records: ForgeAuditRecord[]) => Promise<void> | void;
  onExport: (records: ForgeAuditRecord[]) => Promise<void> | void;
  onClear: () => void;
  copyFlashActive?: boolean;
  exportFlashActive?: boolean;
  /**
   * When true, successful calls are included in the default view. Off by
   * default so rare error and not-found rows aren't drowned out by the
   * high-volume `success` flow. Opt-in via the developer-mode toggle on the
   * parent tab.
   */
  developerMode?: boolean;
}

export function ForgeAuditLogViewer({
  records,
  loading,
  maxRecords,
  anomalySignals = [],
  anomalySuppressed = true,
  onRefresh,
  onCopy,
  onExport,
  onClear,
  copyFlashActive,
  exportFlashActive,
  developerMode = false,
}: ForgeAuditLogViewerProps) {
  const [methodFilter, setMethodFilter] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const [resultFilter, setResultFilter] = useState<ResultFilter>("all");
  const [timeRange, setTimeRange] = useState<TimeRange>("all");
  const [showSuccessful, setShowSuccessful] = useState(false);
  const [ignoreLastHour, setIgnoreLastHour] = useState(false);

  const tick = useGlobalMinuteTicker();
  const now = useMemo(() => {
    void tick;
    return Date.now();
  }, [tick]);

  // The toggle is the user's expressed intent, but `resultFilter === "success"`
  // means the user explicitly asked for that bucket — don't filter them back out.
  const suppressSuccess = !showSuccessful && resultFilter !== "success";

  const filteredRecords = useMemo(() => {
    const needle = methodFilter.trim().toLowerCase();
    const search = searchQuery.trim().toLowerCase();
    const cutoffMs = timeRange !== "all" ? now - TIME_RANGE_MS[timeRange] : undefined;
    return records.filter((record) => {
      if (cutoffMs !== undefined && record.timestamp < cutoffMs) return false;
      if (suppressSuccess && record.result === "success") return false;
      if (resultFilter !== "all" && record.result !== resultFilter) return false;
      if (
        needle.length > 0 &&
        !record.methodName.toLowerCase().includes(needle) &&
        !record.providerId.toLowerCase().includes(needle)
      ) {
        return false;
      }
      if (search.length > 0) {
        const args = record.argsSummary ?? "";
        const err = record.errorMessage ?? "";
        if (!args.toLowerCase().includes(search) && !err.toLowerCase().includes(search)) {
          return false;
        }
      }
      return true;
    });
  }, [records, methodFilter, searchQuery, resultFilter, suppressSuccess, timeRange, now]);

  const oneHourAgo = now - 3_600_000;
  const visibleSignals = useMemo(() => {
    if (anomalySuppressed) return [];
    return ignoreLastHour
      ? anomalySignals.filter((s) => s.timestamp <= oneHourAgo)
      : anomalySignals;
  }, [anomalySignals, anomalySuppressed, ignoreLastHour, oneHourAgo]);

  const signalRecordIds = useMemo(() => {
    const set = new Set<string>();
    for (const sig of visibleSignals) {
      for (const id of sig.recordIds) set.add(id);
    }
    return set;
  }, [visibleSignals]);

  const anomalyCountsByKind = useMemo(() => {
    const counts = new Map<ForgeAnomalyKind, number>();
    for (const sig of visibleSignals) {
      counts.set(sig.kind, (counts.get(sig.kind) ?? 0) + 1);
    }
    return counts;
  }, [visibleSignals]);

  const isFiltering =
    methodFilter.trim().length > 0 ||
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
          value={methodFilter}
          onChange={(e) => setMethodFilter(e.target.value)}
          placeholder="Filter by method or provider"
          aria-label="Filter audit by method or provider"
          className="flex-1 min-w-[180px] bg-daintree-bg border border-border-strong rounded-[var(--radius-md)] px-2 py-1 text-xs text-daintree-text placeholder:text-text-placeholder font-mono focus-visible:outline focus-visible:outline-2 focus-visible:outline-daintree-accent focus-visible:outline-offset-2"
        />
        <input
          type="text"
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          placeholder="Search arguments"
          aria-label="Search audit arguments"
          className="w-40 bg-daintree-bg border border-border-strong rounded-[var(--radius-md)] px-2 py-1 text-xs text-daintree-text placeholder:text-text-placeholder font-mono focus-visible:outline focus-visible:outline-2 focus-visible:outline-daintree-accent focus-visible:outline-offset-2"
        />
        <select
          value={resultFilter}
          onChange={(e) => {
            const value = e.target.value;
            if (
              value === "all" ||
              value === "success" ||
              value === "not-found" ||
              value === "error"
            ) {
              setResultFilter(value);
            }
          }}
          aria-label="Filter audit by result"
          className="bg-daintree-bg border border-border-strong rounded-[var(--radius-md)] px-2 py-1 text-xs text-daintree-text focus-visible:outline focus-visible:outline-2 focus-visible:outline-daintree-accent focus-visible:outline-offset-2"
        >
          <option value="all">All results</option>
          <option value="success">Success</option>
          <option value="not-found">Not found</option>
          <option value="error">Error</option>
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
          className="bg-daintree-bg border border-border-strong rounded-[var(--radius-md)] px-2 py-1 text-xs text-daintree-text focus-visible:outline focus-visible:outline-2 focus-visible:outline-daintree-accent focus-visible:outline-offset-2"
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
                ? "bg-overlay-subtle border-daintree-border text-daintree-text"
                : "border-daintree-border text-daintree-text/70 hover:text-daintree-text hover:bg-overlay-soft"
            )}
            aria-pressed={showSuccessful}
          >
            <Eye className="w-3.5 h-3.5" />
            Show successful calls
          </button>
        )}
        {!anomalySuppressed && anomalySignals.length > 0 && (
          <button
            type="button"
            onClick={() => setIgnoreLastHour((v) => !v)}
            className={cn(
              "flex items-center gap-1.5 px-2 py-1 text-xs font-medium rounded-[var(--radius-md)] border transition-colors",
              ignoreLastHour
                ? "border-status-warning/20 text-status-warning bg-status-warning/10"
                : "border-daintree-border text-daintree-text/70 hover:text-daintree-text hover:bg-overlay-soft"
            )}
            aria-pressed={ignoreLastHour}
          >
            <Clock className="w-3.5 h-3.5" />
            Ignore last hour
          </button>
        )}
      </div>

      {!anomalySuppressed && visibleSignals.length > 0 && (
        <div className="flex items-start gap-2 p-2.5 rounded-[var(--radius-md)] bg-status-danger/10 border border-status-danger/20">
          <span className="text-xs text-status-danger">
            {visibleSignals.length} anomaly signal{visibleSignals.length !== 1 ? "s" : ""}
            {anomalyCountsByKind.size > 0 &&
              ` (${Array.from(anomalyCountsByKind.entries())
                .map(([kind, count]) => `${count} ${ANOMALY_KIND_LABEL[kind]}`)
                .join(", ")})`}
          </span>
        </div>
      )}

      <div className="max-h-64 overflow-y-auto rounded-[var(--radius-md)] border border-daintree-border bg-daintree-bg">
        {loading ? (
          <Skeleton label="Loading audit records" className="space-y-2 p-3">
            <SkeletonBone className="h-5 w-5/6" />
            <SkeletonBone className="h-5 w-4/6" />
            <SkeletonBone className="h-5 w-3/4" />
          </Skeleton>
        ) : filteredRecords.length === 0 ? (
          records.length === 0 ? (
            <EmptyState variant="zero-data" scale="sidebar" title="No forge calls recorded yet" />
          ) : suppressSuccess &&
            methodFilter.trim().length === 0 &&
            searchQuery.trim().length === 0 &&
            resultFilter === "all" &&
            timeRange === "all" ? (
            <EmptyState
              variant="user-cleared"
              scale="sidebar"
              title="No errors or not-found results"
            />
          ) : (
            <EmptyState
              variant="filtered-empty"
              scale="sidebar"
              title="No records match the current filters"
            />
          )
        ) : (
          <ul className="divide-y divide-daintree-border">
            {filteredRecords.map((record) => (
              <li key={record.id} className="grid grid-cols-[auto_1fr_auto] gap-2 p-2 text-xs">
                <div className="flex self-start items-center gap-1 mt-0.5">
                  <SeverityMark
                    severity={RESULT_SEVERITY[record.result]}
                    label={RESULT_LABEL[record.result]}
                    className="h-3 w-3"
                  />
                  {signalRecordIds.has(record.id) && (
                    <span
                      role="img"
                      aria-label="Anomaly"
                      className="status-mark h-2 w-2 rounded-sm rotate-45 shrink-0 bg-status-danger"
                      title="Anomaly"
                    />
                  )}
                </div>
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-daintree-text/90 truncate">
                      {record.methodName}
                    </span>
                    {(record.repoOwner || record.repoName) && (
                      <span className="font-mono text-[10px] text-daintree-text/50 truncate">
                        {record.repoOwner ? `${record.repoOwner}/` : ""}
                        {record.repoName ?? ""}
                      </span>
                    )}
                  </div>
                  <div className="mt-0.5 font-mono text-daintree-text/50 truncate">
                    {record.providerId}
                  </div>
                  {record.argsSummary && record.argsSummary !== "{}" && (
                    <div className="mt-0.5 font-mono text-text-secondary truncate">
                      {record.argsSummary}
                    </div>
                  )}
                  {record.errorMessage && (
                    <div className="mt-0.5 text-[10px] text-status-danger/80 truncate">
                      {record.errorMessage}
                    </div>
                  )}
                </div>
                <div className="text-right text-text-secondary whitespace-nowrap">
                  <div>{formatRelativeTimestamp(record.timestamp, now)}</div>
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
          className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-[var(--radius-md)] border border-daintree-border text-daintree-text/70 hover:text-daintree-text hover:bg-overlay-soft transition-colors"
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
              ? "border-daintree-border text-daintree-text/30 cursor-not-allowed"
              : copyFlashActive
                ? "text-status-success border-status-success/30"
                : "border-daintree-border text-daintree-text/70 hover:text-daintree-text hover:bg-overlay-soft"
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
              ? "border-daintree-border text-daintree-text/30 cursor-not-allowed"
              : exportFlashActive
                ? "text-status-success border-status-success/30"
                : "border-daintree-border text-daintree-text/70 hover:text-daintree-text hover:bg-overlay-soft"
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
              ? "border-daintree-border text-daintree-text/30 cursor-not-allowed"
              : "border-daintree-border text-status-danger hover:text-status-danger hover:bg-status-danger/10 hover:border-status-danger/20"
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
