import { useMemo, useState } from "react";
import { Check, Copy, Download, RefreshCw } from "lucide-react";
import { SeverityMark, type StatusSeverity } from "@/lib/statusSeverity";
import { useGlobalMinuteTicker } from "@/hooks/useGlobalMinuteTicker";
import { Button } from "@/components/ui/button";
import { Skeleton, SkeletonBone } from "@/components/ui/Skeleton";
import { SettingsActions, SettingsEmptyRow, SettingsGroup } from "./SettingsGroup";
import {
  AUDIT_TIME_RANGE_MS,
  InlineErrorRow,
  AuditFilterBar,
  AuditFilterInput,
  AuditFilterSelect,
  AuditRecordTime,
  AuditTimeRangeSelect,
  type AuditTimeRange,
} from "./auditLogParts";
import type {
  PluginActionAuditRecord,
  PluginActionAuditRecordType,
  PluginActionAuditResult,
} from "@shared/types";

/**
 * "problems" is the default: the rare error, disabled and restricted rows would
 * otherwise drown under routine successes. It is a named choice rather than a
 * hidden rule, so "All results" can mean all of them.
 */
type ResultFilter = "problems" | "all" | PluginActionAuditResult;

const RESULT_FILTER_OPTIONS: { value: ResultFilter; label: string }[] = [
  { value: "problems", label: "Problems" },
  { value: "all", label: "All results" },
  { value: "success", label: "Success" },
  { value: "error", label: "Error" },
  { value: "disabled", label: "Disabled" },
  { value: "restricted", label: "Restricted" },
];

const DEFAULT_RESULT_FILTER: ResultFilter = "problems";

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
  /** Shown in place of the list when the records couldn't be read. */
  loadError?: React.ReactNode;
  /** A copy, export or clear that failed, shown beside the actions. */
  actionError?: string | null;
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
  loadError,
  actionError,
}: PluginActionAuditLogViewerProps) {
  const [pluginFilter, setPluginFilter] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const [resultFilter, setResultFilter] = useState<ResultFilter>(DEFAULT_RESULT_FILTER);
  const [timeRange, setTimeRange] = useState<AuditTimeRange>("all");

  const tick = useGlobalMinuteTicker();
  const now = useMemo(() => {
    void tick;
    return Date.now();
  }, [tick]);

  const filteredRecords = useMemo(() => {
    const needle = pluginFilter.trim().toLowerCase();
    const search = searchQuery.trim().toLowerCase();
    const cutoffMs = timeRange !== "all" ? now - AUDIT_TIME_RANGE_MS[timeRange] : undefined;
    return records.filter((record) => {
      if (cutoffMs !== undefined && record.ts < cutoffMs) return false;
      if (resultFilter === "problems" && record.result === "success") return false;
      if (resultFilter !== "problems" && resultFilter !== "all" && record.result !== resultFilter) {
        return false;
      }
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
  }, [records, pluginFilter, searchQuery, resultFilter, timeRange, now]);

  const hasNarrowingFilter =
    pluginFilter.trim().length > 0 ||
    searchQuery.trim().length > 0 ||
    (resultFilter !== "all" && resultFilter !== DEFAULT_RESULT_FILTER) ||
    timeRange !== "all";
  const showCopyAll = filteredRecords.length === records.length;

  const clearFilters = () => {
    setPluginFilter("");
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

  return (
    <SettingsGroup>
      <AuditFilterBar label="Filter plugin actions">
        <AuditFilterInput
          value={pluginFilter}
          onChange={setPluginFilter}
          placeholder="Filter by plugin or action ID"
          ariaLabel="Filter audit by plugin or action ID"
        />
        <AuditFilterInput
          value={searchQuery}
          onChange={setSearchQuery}
          placeholder="Search args or errors"
          ariaLabel="Search audit arguments or error messages"
        />
        <AuditFilterSelect
          value={resultFilter}
          onChange={setResultFilter}
          options={RESULT_FILTER_OPTIONS}
          ariaLabel="Filter audit by result"
        />
        <AuditTimeRangeSelect value={timeRange} onChange={setTimeRange} />
      </AuditFilterBar>

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
          <SettingsEmptyRow>
            Plugin actions show up here once an installed plugin dispatches one
          </SettingsEmptyRow>
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
            No errors, disabled or restricted dispatches
          </SettingsEmptyRow>
        )
      ) : (
        <ul className="max-h-80 overflow-y-auto divide-y divide-border-subtle">
          {filteredRecords.map((record) => (
            <li key={record.id} className="grid grid-cols-[auto_1fr_auto] gap-2 px-4 py-2 text-xs">
              <SeverityMark
                severity={RESULT_SEVERITY[record.result]}
                label={RESULT_LABEL[record.result]}
                className="mt-0.5 h-3 w-3"
              />
              <div className="min-w-0 select-text">
                <div className="flex items-center gap-2">
                  <span className="min-w-0 font-mono text-text-primary break-all">
                    {record.actionId}
                  </span>
                  {record.result !== "success" && (
                    <span className="shrink-0 text-text-secondary">
                      {RESULT_LABEL[record.result]}
                    </span>
                  )}
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
                <div className="mt-0.5 font-mono text-text-secondary break-all">
                  {record.pluginId}
                </div>
                {record.errorMessage ? (
                  <div className="mt-0.5 text-text-primary break-words">{record.errorMessage}</div>
                ) : null}
                {record.argsPlaintext ? (
                  <div className="mt-0.5 font-mono text-text-secondary break-all">
                    {record.argsPlaintext}
                  </div>
                ) : record.argsHash ? (
                  <div
                    className="mt-0.5 font-mono text-text-secondary truncate"
                    title={`sha256:${record.argsHash}`}
                  >
                    sha256:{record.argsHash.slice(0, 16)}…
                  </div>
                ) : null}
              </div>
              <div className="text-right text-text-secondary whitespace-nowrap tabular-nums">
                <div>
                  <AuditRecordTime ts={record.ts} now={now} />
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
          <RefreshCw className="w-3.5 h-3.5" aria-hidden="true" />
          Refresh
        </Button>
        <Button
          variant="outline"
          size="sm"
          onClick={() => void onCopy(filteredRecords)}
          disabled={filteredRecords.length === 0}
        >
          {copyFlashActive ? (
            <Check className="w-3.5 h-3.5" aria-hidden="true" />
          ) : (
            <Copy className="w-3.5 h-3.5" aria-hidden="true" />
          )}
          {`Copy ${showCopyAll ? "all" : "shown"} as JSON`}
        </Button>
        <Button
          variant="outline"
          size="sm"
          onClick={() => void onExport(filteredRecords)}
          disabled={filteredRecords.length === 0}
        >
          {exportFlashActive ? (
            <Check className="w-3.5 h-3.5" aria-hidden="true" />
          ) : (
            <Download className="w-3.5 h-3.5" aria-hidden="true" />
          )}
          Export as NDJSON
        </Button>
        <Button variant="ghost-danger" size="sm" onClick={onClear} disabled={records.length === 0}>
          Clear audit log…
        </Button>
      </SettingsActions>
    </SettingsGroup>
  );
}
