import { useMemo, useState } from "react";
import { Check, Clock, Copy, Download, RefreshCw } from "lucide-react";
import { cn } from "@/lib/utils";
import { SeverityMark, type StatusSeverity } from "@/lib/statusSeverity";
import { useGlobalMinuteTicker } from "@/hooks/useGlobalMinuteTicker";
import { Button } from "@/components/ui/button";
import { Skeleton, SkeletonBone } from "@/components/ui/Skeleton";
import { SettingsActions, SettingsEmptyRow, SettingsGroup } from "./SettingsGroup";
import {
  AUDIT_TIME_RANGE_MS,
  AuditFilterBar,
  AuditFilterInput,
  AuditFilterSelect,
  AuditRecordTime,
  AuditTimeRangeSelect,
  InlineErrorRow,
  type AuditTimeRange,
} from "./auditLogParts";
import type {
  ForgeAnomalyKind,
  ForgeAnomalySignal,
  ForgeAuditRecord,
  ForgeAuditResult,
} from "@shared/types/ipc/forge";

/**
 * "problems" is the default: rare errors and not-found results would otherwise
 * drown under the high-volume success flow. It is a named choice rather than a
 * hidden rule, so "All results" can mean all of them.
 */
type ResultFilter = "problems" | "all" | ForgeAuditResult;

const RESULT_FILTER_OPTIONS: { value: ResultFilter; label: string }[] = [
  { value: "problems", label: "Problems" },
  { value: "all", label: "All results" },
  { value: "success", label: "Success" },
  { value: "not-found", label: "Not found" },
  { value: "error", label: "Error" },
];

const DEFAULT_RESULT_FILTER: ResultFilter = "problems";

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

const HOUR_MS = 3_600_000;

export function matchesResultFilter(filter: ResultFilter, result: ForgeAuditResult): boolean {
  if (filter === "all") return true;
  if (filter === "problems") return result !== "success";
  return result === filter;
}

interface ForgeAuditLogViewerProps {
  records: ForgeAuditRecord[];
  loading: boolean;
  maxRecords: number;
  anomalySignals?: ForgeAnomalySignal[];
  anomalySuppressed?: boolean;
  onRefresh: () => Promise<void> | void;
  onCopy: (records: ForgeAuditRecord[]) => Promise<void> | void;
  onExport: (records: ForgeAuditRecord[]) => Promise<void> | void;
  onClear: () => void;
  copyFlashActive?: boolean;
  exportFlashActive?: boolean;
  /** Shown in place of the list when the records couldn't be read. */
  loadError?: React.ReactNode;
  /** A copy, export or clear that failed, shown beside the actions. */
  actionError?: string | null;
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
  loadError,
  actionError,
}: ForgeAuditLogViewerProps) {
  const [methodFilter, setMethodFilter] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const [resultFilter, setResultFilter] = useState<ResultFilter>(DEFAULT_RESULT_FILTER);
  const [timeRange, setTimeRange] = useState<AuditTimeRange>("all");
  const [ignoreLastHour, setIgnoreLastHour] = useState(false);

  const tick = useGlobalMinuteTicker();
  const now = useMemo(() => {
    void tick;
    return Date.now();
  }, [tick]);

  const filteredRecords = useMemo(() => {
    const needle = methodFilter.trim().toLowerCase();
    const search = searchQuery.trim().toLowerCase();
    const cutoffMs = timeRange !== "all" ? now - AUDIT_TIME_RANGE_MS[timeRange] : undefined;
    return records.filter((record) => {
      if (cutoffMs !== undefined && record.timestamp < cutoffMs) return false;
      if (!matchesResultFilter(resultFilter, record.result)) return false;
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
  }, [records, methodFilter, searchQuery, resultFilter, timeRange, now]);

  const visibleSignals = useMemo(() => {
    if (anomalySuppressed) return [];
    return ignoreLastHour
      ? anomalySignals.filter((s) => s.timestamp <= now - HOUR_MS)
      : anomalySignals;
  }, [anomalySignals, anomalySuppressed, ignoreLastHour, now]);

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

  const hasNarrowingFilter =
    methodFilter.trim().length > 0 ||
    searchQuery.trim().length > 0 ||
    (resultFilter !== "all" && resultFilter !== DEFAULT_RESULT_FILTER) ||
    timeRange !== "all";
  const showCopyAll = filteredRecords.length === records.length;

  const clearFilters = () => {
    setMethodFilter("");
    setSearchQuery("");
    setResultFilter(DEFAULT_RESULT_FILTER);
    setTimeRange("all");
  };

  const status = copyFlashActive
    ? "Copied!"
    : exportFlashActive
      ? "Exported!"
      : filteredRecords.length === records.length
        ? `${records.length} of ${maxRecords}`
        : `Showing ${filteredRecords.length} of ${records.length}`;

  const canIgnoreLastHour = !anomalySuppressed && anomalySignals.length > 0;

  return (
    <SettingsGroup>
      <div>
        <AuditFilterBar label="Filter forge calls">
          <AuditFilterInput
            value={methodFilter}
            onChange={setMethodFilter}
            placeholder="Filter by method or provider"
            ariaLabel="Filter audit by method or provider"
          />
          <AuditFilterInput
            value={searchQuery}
            onChange={setSearchQuery}
            placeholder="Search args or errors"
            ariaLabel="Search audit arguments"
          />
          <AuditFilterSelect
            value={resultFilter}
            onChange={setResultFilter}
            options={RESULT_FILTER_OPTIONS}
            ariaLabel="Filter audit by result"
          />
          <AuditTimeRangeSelect value={timeRange} onChange={setTimeRange} />
        </AuditFilterBar>
        {canIgnoreLastHour && (
          <div className="flex flex-wrap items-center gap-2 px-4 pb-3 -mt-1">
            <Button
              variant="outline"
              size="sm"
              aria-pressed={ignoreLastHour}
              onClick={() => setIgnoreLastHour((v) => !v)}
              className={cn(ignoreLastHour && "bg-overlay-selected text-text-primary")}
            >
              <Clock aria-hidden="true" />
              Ignore last hour
            </Button>
          </div>
        )}
      </div>

      {visibleSignals.length > 0 && (
        <div className="flex items-center gap-2 px-4 py-2.5 text-xs text-text-primary">
          <span
            aria-hidden="true"
            className="status-mark h-2 w-2 rounded-sm rotate-45 shrink-0 bg-status-danger"
          />
          <span>
            {visibleSignals.length} anomaly signal{visibleSignals.length !== 1 ? "s" : ""}
            {anomalyCountsByKind.size > 0 &&
              ` (${Array.from(anomalyCountsByKind.entries())
                .map(([kind, count]) => `${count} ${ANOMALY_KIND_LABEL[kind]}`)
                .join(", ")})`}
          </span>
        </div>
      )}

      {/* A failed refresh keeps the rows already read, under the error, so the
          actions below never act on evidence the user can't see. */}
      {!loading && loadError && records.length > 0 && loadError}

      {loading ? (
        <Skeleton label="Loading audit records" className="space-y-2 px-4 py-3">
          <SkeletonBone className="h-5 w-5/6" />
          <SkeletonBone className="h-5 w-4/6" />
          <SkeletonBone className="h-5 w-3/4" />
        </Skeleton>
      ) : loadError && records.length === 0 ? (
        loadError
      ) : filteredRecords.length === 0 ? (
        records.length === 0 ? (
          <SettingsEmptyRow>Forge calls show up here once a provider is used</SettingsEmptyRow>
        ) : hasNarrowingFilter ? (
          <SettingsEmptyRow
            action={
              <Button variant="outline" size="sm" onClick={clearFilters}>
                Clear filters
              </Button>
            }
          >
            No records match these filters
          </SettingsEmptyRow>
        ) : (
          <SettingsEmptyRow
            action={
              <Button variant="outline" size="sm" onClick={() => setResultFilter("all")}>
                Show all results
              </Button>
            }
          >
            No errors or not-found results
          </SettingsEmptyRow>
        )
      ) : (
        <ul className="max-h-80 overflow-y-auto divide-y divide-border-subtle">
          {filteredRecords.map((record) => (
            <li key={record.id} className="grid grid-cols-[auto_1fr_auto] gap-2 px-4 py-2 text-xs">
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
              <div className="min-w-0 select-text">
                <div className="flex flex-wrap items-center gap-x-2">
                  <span className="min-w-0 font-mono text-text-primary break-all">
                    {record.methodName}
                  </span>
                  {record.result !== "success" && (
                    <span className="shrink-0 text-text-secondary">
                      {RESULT_LABEL[record.result]}
                    </span>
                  )}
                  {(record.repoOwner || record.repoName) && (
                    <span className="min-w-0 font-mono text-text-secondary break-all">
                      {record.repoOwner ? `${record.repoOwner}/` : ""}
                      {record.repoName ?? ""}
                    </span>
                  )}
                </div>
                <div className="mt-0.5 font-mono text-text-secondary break-all">
                  {record.providerId}
                </div>
                {record.argsSummary && record.argsSummary !== "{}" && (
                  <div
                    className="mt-0.5 font-mono text-text-secondary break-all line-clamp-3"
                    title={record.argsSummary}
                  >
                    {record.argsSummary}
                  </div>
                )}
                {record.errorMessage && (
                  <div className="mt-0.5 text-text-primary break-words">{record.errorMessage}</div>
                )}
              </div>
              <div className="text-right text-text-secondary whitespace-nowrap tabular-nums">
                <div>
                  <AuditRecordTime ts={record.timestamp} now={now} />
                </div>
                <div>{record.durationMs}ms</div>
              </div>
            </li>
          ))}
        </ul>
      )}

      {actionError && <InlineErrorRow>{actionError}</InlineErrorRow>}

      <SettingsActions status={loading ? null : status}>
        <Button
          variant="outline"
          size="sm"
          onClick={() => void onRefresh()}
          aria-label="Refresh audit log"
        >
          <RefreshCw aria-hidden="true" />
          Refresh
        </Button>
        <Button
          variant="outline"
          size="sm"
          onClick={() => void onCopy(filteredRecords)}
          disabled={filteredRecords.length === 0}
        >
          {copyFlashActive ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
          {`Copy ${showCopyAll ? "all" : "shown"} as JSON`}
        </Button>
        <Button
          variant="outline"
          size="sm"
          onClick={() => void onExport(filteredRecords)}
          disabled={filteredRecords.length === 0}
        >
          {exportFlashActive ? <Check aria-hidden="true" /> : <Download aria-hidden="true" />}
          Export as NDJSON
        </Button>
        <Button variant="ghost-danger" size="sm" onClick={onClear} disabled={records.length === 0}>
          Clear audit log…
        </Button>
      </SettingsActions>
    </SettingsGroup>
  );
}
