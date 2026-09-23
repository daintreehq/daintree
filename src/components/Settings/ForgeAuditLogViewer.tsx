import { useMemo, useState } from "react";
import { Check, Copy, Download, RefreshCw } from "lucide-react";
import { SeverityMark, type StatusSeverity } from "@/lib/statusSeverity";
import { useGlobalMinuteTicker } from "@/hooks/useGlobalMinuteTicker";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton, SkeletonBone } from "@/components/ui/Skeleton";
import { SettingsEmptyRow, SettingsGroup, SettingsRow } from "./SettingsGroup";
import type {
  ForgeAnomalyKind,
  ForgeAnomalySignal,
  ForgeAuditRecord,
  ForgeAuditResult,
} from "@shared/types/ipc/forge";

/**
 * `problems` is the landing view: successful calls are the bulk of the log, and the
 * rare error or not-found would drown in them. It is named for what it shows, so
 * "All results" can mean all of them.
 */
type ResultFilter = "problems" | "all" | ForgeAuditResult;

type TimeRange = "5m" | "1h" | "24h" | "all";

const RESULT_OPTIONS: ReadonlyArray<{ value: ResultFilter; label: string }> = [
  { value: "problems", label: "Problems" },
  { value: "all", label: "All results" },
  { value: "error", label: "Errors" },
  { value: "not-found", label: "Not found" },
  { value: "success", label: "Successful" },
];

const TIME_OPTIONS: ReadonlyArray<{ value: TimeRange; label: string }> = [
  { value: "all", label: "Any time" },
  { value: "5m", label: "Last 5 minutes" },
  { value: "1h", label: "Last hour" },
  { value: "24h", label: "Last 24 hours" },
];

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

export function matchesResultFilter(filter: ResultFilter, result: ForgeAuditResult): boolean {
  if (filter === "all") return true;
  if (filter === "problems") return result !== "success";
  return result === filter;
}

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
  /** The last read failed; `records` is whatever the previous read returned. */
  loadFailed?: boolean;
  /** The last copy, export, clear or recording change failed. */
  opError?: string | null;
  anomalySignals?: ForgeAnomalySignal[];
  anomalySuppressed?: boolean;
  onRefresh: () => Promise<void> | void;
  onCopy: (records: ForgeAuditRecord[]) => Promise<void> | void;
  onExport: (records: ForgeAuditRecord[]) => Promise<void> | void;
  onClear: () => void;
  copyFlashActive?: boolean;
  exportFlashActive?: boolean;
}

/**
 * The recorded calls as two groups: the log itself (filters, records, the actions that
 * read it) and, last and apart, the one action that destroys it.
 */
export function ForgeAuditLogViewer({
  records,
  loading,
  loadFailed = false,
  opError = null,
  anomalySignals = [],
  anomalySuppressed = true,
  onRefresh,
  onCopy,
  onExport,
  onClear,
  copyFlashActive,
  exportFlashActive,
}: ForgeAuditLogViewerProps) {
  const [methodFilter, setMethodFilter] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const [resultFilter, setResultFilter] = useState<ResultFilter>("problems");
  const [timeRange, setTimeRange] = useState<TimeRange>("all");
  const [ignoreLastHour, setIgnoreLastHour] = useState(false);

  const tick = useGlobalMinuteTicker();
  const now = useMemo(() => {
    void tick;
    return Date.now();
  }, [tick]);

  const filteredRecords = useMemo(() => {
    const needle = methodFilter.trim().toLowerCase();
    const search = searchQuery.trim().toLowerCase();
    const cutoffMs = timeRange !== "all" ? now - TIME_RANGE_MS[timeRange] : undefined;
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

  const anomalySummary = useMemo(() => {
    if (visibleSignals.length === 0) return "No anomaly signals outside the last hour";
    const counts = new Map<ForgeAnomalyKind, number>();
    for (const sig of visibleSignals) {
      counts.set(sig.kind, (counts.get(sig.kind) ?? 0) + 1);
    }
    const kinds = Array.from(counts.entries())
      .map(([kind, count]) => `${count} ${ANOMALY_KIND_LABEL[kind]}`)
      .join(", ");
    const plural = visibleSignals.length !== 1 ? "s" : "";
    return `${visibleSignals.length} anomaly signal${plural} (${kinds})`;
  }, [visibleSignals]);

  const onlyDefaultFilter =
    methodFilter.trim().length === 0 &&
    searchQuery.trim().length === 0 &&
    resultFilter === "problems" &&
    timeRange === "all";
  const showCopyAll = filteredRecords.length === records.length;
  const clearFilters = () => {
    setMethodFilter("");
    setSearchQuery("");
    setResultFilter("all");
    setTimeRange("all");
  };
  const nothingShown = filteredRecords.length === 0;

  return (
    <>
      <SettingsGroup>
        <div className="flex flex-wrap items-center gap-2 px-4 py-3">
          <Input
            density="compact"
            type="text"
            value={methodFilter}
            onChange={(e) => setMethodFilter(e.target.value)}
            placeholder="Filter by method or provider"
            aria-label="Filter audit by method or provider"
            className="w-auto min-w-36 flex-1 basis-0"
          />
          <Input
            density="compact"
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search arguments and errors"
            aria-label="Search audit arguments and errors"
            className="w-auto min-w-36 flex-1 basis-0"
          />
          <Select
            value={resultFilter}
            onValueChange={(v) => {
              const match = RESULT_OPTIONS.find((o) => o.value === v);
              if (match) setResultFilter(match.value);
            }}
          >
            <SelectTrigger
              aria-label="Filter audit by result"
              className="h-7 w-32 shrink-0 text-xs"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {RESULT_OPTIONS.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select
            value={timeRange}
            onValueChange={(v) => {
              const match = TIME_OPTIONS.find((o) => o.value === v);
              if (match) setTimeRange(match.value);
            }}
          >
            <SelectTrigger aria-label="Filter audit by time" className="h-7 w-32 shrink-0 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {TIME_OPTIONS.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {!anomalySuppressed && anomalySignals.length > 0 && (
          <div className="flex flex-wrap items-center gap-3 px-4 py-2.5">
            <p className="min-w-0 flex-1 text-xs text-status-error" role="status">
              {anomalySummary}
            </p>
            <Button
              variant="outline"
              size="sm"
              aria-pressed={ignoreLastHour}
              onClick={() => setIgnoreLastHour((v) => !v)}
            >
              Ignore last hour
            </Button>
          </div>
        )}

        <div className="max-h-72 overflow-y-auto">
          {loading ? (
            <Skeleton label="Loading audit records" className="space-y-2 p-4">
              <SkeletonBone className="h-5 w-5/6" />
              <SkeletonBone className="h-5 w-4/6" />
              <SkeletonBone className="h-5 w-3/4" />
            </Skeleton>
          ) : loadFailed && records.length === 0 ? (
            <SettingsEmptyRow
              action={
                <Button variant="outline" size="sm" onClick={() => void onRefresh()}>
                  Retry
                </Button>
              }
            >
              <span className="text-status-error">Couldn&apos;t read the audit log</span>
            </SettingsEmptyRow>
          ) : nothingShown ? (
            records.length === 0 ? (
              <SettingsEmptyRow>No forge calls recorded yet</SettingsEmptyRow>
            ) : onlyDefaultFilter ? (
              <SettingsEmptyRow
                action={
                  <Button variant="outline" size="sm" onClick={() => setResultFilter("all")}>
                    Show all results
                  </Button>
                }
              >
                No problems recorded
              </SettingsEmptyRow>
            ) : (
              <SettingsEmptyRow
                action={
                  <Button variant="outline" size="sm" onClick={clearFilters}>
                    Clear filters
                  </Button>
                }
              >
                No records match these filters
              </SettingsEmptyRow>
            )
          ) : (
            <ul className="divide-y divide-border-subtle" aria-label="Forge audit records">
              {filteredRecords.map((record) => (
                <li
                  key={record.id}
                  className="grid grid-cols-[auto_minmax(0,1fr)_auto] gap-3 px-4 py-2.5 text-xs"
                >
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
                    <div className="flex items-baseline gap-2 min-w-0">
                      <span className="font-mono text-text-primary truncate">
                        {record.methodName}
                      </span>
                      {(record.repoOwner || record.repoName) && (
                        <span className="font-mono text-text-secondary truncate">
                          {record.repoOwner ? `${record.repoOwner}/` : ""}
                          {record.repoName ?? ""}
                        </span>
                      )}
                    </div>
                    <div className="mt-0.5 font-mono text-text-secondary truncate">
                      {record.providerId}
                      {record.argsSummary && record.argsSummary !== "{}" && (
                        <span title={record.argsSummary}> · {record.argsSummary}</span>
                      )}
                    </div>
                    {record.errorMessage && (
                      // Wrapped, never truncated: the end of an error is usually the fix.
                      <div className="mt-1 text-status-error break-words select-text">
                        {record.errorMessage}
                      </div>
                    )}
                  </div>
                  <div className="text-right text-text-secondary whitespace-nowrap tabular-nums">
                    <div>{formatRelativeTimestamp(record.timestamp, now)}</div>
                    <div>{record.durationMs}ms</div>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-2 px-4 py-2.5">
          <span className="mr-auto text-xs text-text-secondary tabular-nums" aria-live="polite">
            {opError ? (
              <span className="text-status-error">{opError}</span>
            ) : loadFailed ? (
              <span className="text-status-error">
                Couldn&apos;t refresh — showing the last read
              </span>
            ) : copyFlashActive ? (
              "Copied to the clipboard"
            ) : exportFlashActive ? (
              "Exported"
            ) : (
              `${filteredRecords.length} of ${records.length} calls`
            )}
          </span>
          <Button variant="outline" size="sm" onClick={() => void onRefresh()}>
            <RefreshCw aria-hidden="true" />
            Refresh
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={nothingShown}
            onClick={() => void onCopy(filteredRecords)}
          >
            {copyFlashActive ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
            {copyFlashActive ? "Copied" : `Copy ${showCopyAll ? "all" : "shown"} as JSON`}
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={nothingShown}
            onClick={() => void onExport(filteredRecords)}
          >
            {exportFlashActive ? <Check aria-hidden="true" /> : <Download aria-hidden="true" />}
            {exportFlashActive ? "Exported" : "Export as NDJSON"}
          </Button>
        </div>
      </SettingsGroup>

      <SettingsGroup>
        <SettingsRow
          label="Clear log"
          description="Deletes every recorded call on this machine. Recording carries on."
          control={
            <Button
              variant="ghost-danger"
              size="sm"
              onClick={onClear}
              disabled={records.length === 0}
            >
              Clear log
            </Button>
          }
        />
      </SettingsGroup>
    </>
  );
}
