import { useMemo, useState } from "react";
import { Check, Clock, Copy, Download, Layers, RefreshCw, ShieldOff } from "lucide-react";
import { cn } from "@/lib/utils";
import { SeverityMark, type StatusSeverity } from "@/lib/statusSeverity";
import { useGlobalMinuteTicker } from "@/hooks/useGlobalMinuteTicker";
import { EmptyState } from "@/components/ui/EmptyState";
import { Skeleton, SkeletonBone } from "@/components/ui/Skeleton";
import {
  type McpAuditResult,
  type McpGrantRecord,
  type McpLogRecord,
  type McpGrantRecordType,
  isAuditRecord,
  isGrantRecord,
  type AssistantTurnRecord,
  type McpAnomalySignal,
} from "@shared/types";

type AuditResultFilter = "all" | McpAuditResult;

const TIER_HINT_LABEL: Record<"workbench" | "action" | "system", string> = {
  workbench: "workbench",
  action: "action",
  system: "system",
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

const RESULT_SEVERITY: Record<McpAuditResult, StatusSeverity> = {
  success: "success",
  error: "error",
  "confirmation-pending": "warning",
  unauthorized: "error",
  dedup: "info",
  collision: "warning",
  rate_limited: "warning",
};

const GRANT_TYPE_LABEL: Record<McpGrantRecordType, string> = {
  "grant.issued": "Grant issued",
  "grant.expired": "Grant expired",
  "grant.revoked": "Grant revoked",
  "grant.used": "Grant used",
  "grant.exhausted": "Grant exhausted",
  "tier.elevated": "Tier elevated",
  "tier.decayed": "Tier decayed",
};

const GRANT_TYPE_SEVERITY: Record<McpGrantRecordType, StatusSeverity> = {
  "grant.issued": "info",
  "grant.expired": "warning",
  "grant.revoked": "error",
  "grant.used": "info",
  "grant.exhausted": "warning",
  "tier.elevated": "warning",
  "tier.decayed": "info",
};

type TimeRange = "5m" | "1h" | "24h" | "all";

const TIME_RANGE_MS: Record<Exclude<TimeRange, "all">, number> = {
  "5m": 300_000,
  "1h": 3_600_000,
  "24h": 86_400_000,
};

const OUTCOME_LABEL: Record<string, string> = {
  answered: "Answered",
  hedged: "Hedged",
  refused: "Refused",
  "docs-empty": "No docs found",
  "tier-rejected": "Tier rejected",
  "mcp-not-ready": "MCP not ready",
  "agent-stuck": "Agent stuck",
  "tool-error": "Tool error",
  "hibernate-resume-stale": "Resume stale",
  unknown: "Unknown",
};

export interface TurnGroup {
  turnId: string;
  turnRecord: AssistantTurnRecord;
  records: McpLogRecord[];
  callCount: number;
  unauthorizedCount: number;
  errorCount: number;
  totalDurationMs: number;
  /** Session-scoped grant lifecycle events that share this turn's `sessionId`. */
  lifecycle: McpGrantRecord[];
}

export function groupRecordsByTurn(
  records: McpLogRecord[],
  turnRecords: AssistantTurnRecord[]
): { groups: TurnGroup[]; unassociated: McpLogRecord[]; lifecycle: McpGrantRecord[] } {
  const turnById = new Map<string, AssistantTurnRecord>();
  for (const t of turnRecords) {
    if (t.turnId) turnById.set(t.turnId, t);
  }

  // Two passes: grant records bucket into a turn only when a dispatch in the
  // same turn shares `sessionId` — fabricating a turn correlation from
  // timestamp alone would be brittle (#10027). Records that don't match any
  // turn fall into `unassociated`; grants that don't match any turn go to
  // the dedicated `lifecycle` section.
  const grouped = new Map<string, McpLogRecord[]>();
  const sessionByTurn = new Map<string, Set<string>>();
  const unassociated: McpLogRecord[] = [];
  const unassociatedGrants: McpGrantRecord[] = [];
  // `unassociatedDispatchSessions` collects session ids of dispatches that
  // landed in the `unassociated` bucket, NOT all grant sessions — otherwise
  // the second-pass check would always be true and orphan grants would
  // never reach the trailing `lifecycle` section.
  const unassociatedDispatchSessions = new Set<string>();

  for (const r of records) {
    if (isGrantRecord(r)) {
      unassociatedGrants.push(r);
      continue;
    }
    if (r.turnId && turnById.has(r.turnId)) {
      const list = grouped.get(r.turnId);
      if (list) list.push(r);
      else grouped.set(r.turnId, [r]);
      let set = sessionByTurn.get(r.turnId);
      if (!set) {
        set = new Set();
        sessionByTurn.set(r.turnId, set);
      }
      set.add(r.sessionId);
    } else {
      unassociated.push(r);
      unassociatedDispatchSessions.add(r.sessionId);
    }
  }

  // Second pass: route grants that share a `sessionId` with a turn's
  // dispatches into that turn's `lifecycle`; the rest stay in the trailing
  // `lifecycle` array.
  const lifecycle: McpGrantRecord[] = [];
  const groupedLifecycle = new Map<string, McpGrantRecord[]>();
  for (const grant of unassociatedGrants) {
    let routed = false;
    for (const [turnId, sessions] of sessionByTurn) {
      if (sessions.has(grant.sessionId)) {
        const list = groupedLifecycle.get(turnId);
        if (list) list.push(grant);
        else groupedLifecycle.set(turnId, [grant]);
        routed = true;
        break;
      }
    }
    if (!routed) {
      // A grant whose session has at least one unassociated dispatch rides
      // along under that session's unassociated block. A pure orphan grant
      // (no associated dispatch at all) goes to standalone `lifecycle` so
      // the trailing "Lifecycle events" section actually surfaces them.
      if (unassociatedDispatchSessions.has(grant.sessionId)) {
        unassociated.push(grant);
      } else {
        lifecycle.push(grant);
      }
    }
  }

  const groups: TurnGroup[] = [];
  for (const [turnId, recs] of grouped) {
    const turnRecord = turnById.get(turnId)!;
    groups.push({
      turnId,
      turnRecord,
      records: recs,
      callCount: recs.length,
      unauthorizedCount: recs.filter((r) => isAuditRecord(r) && r.result === "unauthorized").length,
      errorCount: recs.filter((r) => isAuditRecord(r) && r.result === "error").length,
      totalDurationMs: recs.filter(isAuditRecord).reduce((sum, r) => sum + r.durationMs, 0),
      lifecycle: groupedLifecycle.get(turnId) ?? [],
    });
  }
  groups.sort((a, b) => b.turnRecord.timestamp - a.turnRecord.timestamp);

  // Newest-first within the standalone lifecycle section so it reads like a
  // chronological feed rather than a stale backlog.
  lifecycle.sort((a, b) => b.timestamp - a.timestamp);

  return { groups, unassociated, lifecycle };
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
  const day = Math.floor(hr / 24);
  return `${day}d ago`;
}

interface McpAuditLogViewerProps {
  records: McpLogRecord[];
  turnRecords?: AssistantTurnRecord[];
  loading: boolean;
  onRefresh: () => Promise<void> | void;
  onCopy: (records: McpLogRecord[]) => Promise<void> | void;
  onClear?: () => void;
  includeRecord?: (record: McpLogRecord) => boolean;
  maxRecords?: number;
  copyFlashActive?: boolean;
  /** Triggers the NDJSON export via OS save dialog with the filtered records. */
  onExport?: (records: McpLogRecord[]) => Promise<void> | void;
  /** Set when an export succeeded so the UI can flash a confirmation. */
  exportFlashActive?: boolean;
  anomalySignals?: McpAnomalySignal[];
  anomalySuppressed?: boolean;
}

/**
 * Single grant-lifecycle row. The flat and grouped views use slightly
 * different padding, controlled by `compact`. Reads no `result` or
 * `durationMs` — those are dispatch-only fields and absent on grant
 * records.
 */
function GrantRow({
  record,
  now,
  compact = false,
}: {
  record: McpGrantRecord;
  now: number;
  compact?: boolean;
}) {
  return (
    <li className="grid grid-cols-[auto_1fr_auto] gap-2 py-0.5">
      <SeverityMark
        severity={GRANT_TYPE_SEVERITY[record.type]}
        label={GRANT_TYPE_LABEL[record.type]}
        className="mt-0.5 h-3 w-3"
        decorative
      />
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <span className="text-text-primary">{GRANT_TYPE_LABEL[record.type]}</span>
          <span className="font-mono text-text-secondary truncate">{record.toolId}</span>
        </div>
        {record.type === "tier.elevated" && record.tier && record.previousTier && (
          <div className="mt-0.5 text-3xs text-text-secondary">
            {record.previousTier} → {record.tier}
          </div>
        )}
        {record.type === "tier.decayed" && record.tier && record.previousTier && (
          <div className="mt-0.5 text-3xs text-text-secondary">
            {record.previousTier} → {record.tier}
          </div>
        )}
        {record.type === "grant.revoked" && record.revokedReason && (
          <div className="mt-0.5 text-3xs text-text-secondary">Reason: {record.revokedReason}</div>
        )}
        {record.maxUses !== undefined &&
          (record.type === "grant.used" || record.type === "grant.exhausted") && (
            <div className="mt-0.5 text-3xs text-text-secondary">
              {record.remainingUses ?? 0} of {record.maxUses} uses left
            </div>
          )}
        {record.expiresAt !== undefined && record.type === "grant.issued" && (
          <div className="mt-0.5 text-3xs text-text-secondary">
            Expires{" "}
            {new Date(record.expiresAt).toLocaleTimeString([], {
              hour: "2-digit",
              minute: "2-digit",
            })}
          </div>
        )}
      </div>
      <div
        className={cn("text-right text-text-secondary whitespace-nowrap", !compact && "self-end")}
      >
        <div>{formatRelativeTimestamp(record.timestamp, now)}</div>
      </div>
    </li>
  );
}

export function McpAuditLogViewer({
  records,
  turnRecords,
  loading,
  onRefresh,
  onCopy,
  onClear,
  includeRecord,
  maxRecords,
  copyFlashActive,
  onExport,
  exportFlashActive,
  anomalySignals = [],
  anomalySuppressed = true,
}: McpAuditLogViewerProps) {
  const [toolFilter, setToolFilter] = useState("");
  const [resultFilter, setResultFilter] = useState<AuditResultFilter>("all");
  const [timeRange, setTimeRange] = useState<TimeRange>("all");
  const [searchQuery, setSearchQuery] = useState("");
  const [groupByTurn, setGroupByTurn] = useState(false);
  const [ignoreLastHour, setIgnoreLastHour] = useState(false);

  const tick = useGlobalMinuteTicker();
  const now = useMemo(() => {
    void tick;
    return Date.now();
  }, [tick]);

  const visibleRecords = useMemo(() => {
    if (!includeRecord) return records;
    return records.filter(includeRecord);
  }, [records, includeRecord]);

  const unauthorizedCount = useMemo(
    () =>
      visibleRecords.reduce(
        (n, r) => (isAuditRecord(r) && r.result === "unauthorized" ? n + 1 : n),
        0
      ),
    [visibleRecords]
  );

  const filteredRecords = useMemo(() => {
    const needle = toolFilter.trim().toLowerCase();
    const searchNeedle = searchQuery.trim().toLowerCase();
    const cutoffMs = timeRange !== "all" ? now - TIME_RANGE_MS[timeRange] : undefined;
    return visibleRecords.filter((record) => {
      if (cutoffMs !== undefined && record.timestamp < cutoffMs) return false;
      // The result filter is dispatch-taxonomy; grant records have no
      // `result` field, so they pass through the result filter unchanged.
      // The export must include them — forensic export of a tier-rejection
      // incident must still surface the grant.issued/grant.revoked events
      // for that session (#10027).
      if (resultFilter !== "all" && isAuditRecord(record) && record.result !== resultFilter) {
        return false;
      }
      // Tool filter and search work against the union's common fields.
      if (needle.length > 0 && !record.toolId.toLowerCase().includes(needle)) return false;
      if (searchNeedle.length > 0) {
        const haystack = isAuditRecord(record) ? (record.argsSummary ?? "") : "";
        if (!haystack.toLowerCase().includes(searchNeedle)) return false;
      }
      return true;
    });
  }, [visibleRecords, resultFilter, toolFilter, timeRange, searchQuery, now]);

  const turnGroups = useMemo(() => {
    if (!groupByTurn || !turnRecords || turnRecords.length === 0) return null;
    return groupRecordsByTurn(filteredRecords, turnRecords);
  }, [groupByTurn, turnRecords, filteredRecords]);

  const showCopyAll = filteredRecords.length === visibleRecords.length;

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
      for (const id of sig.recordIds) {
        set.add(id);
      }
    }
    return set;
  }, [visibleSignals]);

  const anomalyCountsByKind = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const sig of visibleSignals) {
      counts[sig.kind] = (counts[sig.kind] ?? 0) + 1;
    }
    return counts;
  }, [visibleSignals]);

  const showTierRejections = () => {
    setResultFilter("unauthorized");
  };

  return (
    <div className="contents">
      <div className="flex flex-wrap items-center gap-2">
        <input
          type="text"
          value={toolFilter}
          onChange={(e) => setToolFilter(e.target.value)}
          placeholder="Filter by tool ID"
          aria-label="Filter audit by tool name"
          className="flex-1 min-w-[160px] bg-surface-canvas border border-border-strong rounded-[var(--radius-md)] px-2 py-1 text-xs text-text-primary placeholder:text-text-placeholder font-mono focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-primary focus-visible:outline-offset-2"
        />
        <input
          type="text"
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          placeholder="Search arguments"
          aria-label="Search audit arguments"
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
              value === "confirmation-pending" ||
              value === "unauthorized" ||
              value === "dedup" ||
              value === "collision" ||
              value === "rate_limited"
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
          <option value="confirmation-pending">Awaiting confirmation</option>
          <option value="unauthorized">Unauthorized</option>
          <option value="dedup">Deduplicated</option>
          <option value="collision">Key collision</option>
          <option value="rate_limited">Rate limited</option>
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
        {unauthorizedCount > 0 && resultFilter !== "unauthorized" && (
          <button
            type="button"
            onClick={showTierRejections}
            className="flex items-center gap-1.5 px-2 py-1 text-xs font-medium rounded-[var(--radius-md)] border border-border-default text-text-secondary hover:text-text-primary hover:bg-overlay-soft transition-colors"
          >
            <ShieldOff className="w-3.5 h-3.5" />
            Show tier rejections ({unauthorizedCount})
          </button>
        )}
        {turnRecords && turnRecords.length > 0 && (
          <button
            type="button"
            onClick={() => setGroupByTurn((v) => !v)}
            className={cn(
              "flex items-center gap-1.5 px-2 py-1 text-xs font-medium rounded-[var(--radius-md)] border transition-colors",
              groupByTurn
                ? "bg-overlay-subtle border-border-default text-text-primary"
                : "border-border-default text-text-secondary hover:text-text-primary hover:bg-overlay-soft"
            )}
          >
            <Layers className="w-3.5 h-3.5" />
            Group by turn
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
                : "border-border-default text-text-secondary hover:text-text-primary hover:bg-overlay-soft"
            )}
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
            {Object.entries(anomalyCountsByKind).length > 0 &&
              ` (${Object.entries(anomalyCountsByKind)
                .map(([kind, count]) => `${count} ${kind}`)
                .join(", ")})`}
          </span>
        </div>
      )}

      <div className="max-h-64 overflow-y-auto rounded-[var(--radius-md)] border border-border-default bg-surface-canvas">
        {loading ? (
          <Skeleton label="Loading audit records" className="space-y-2 p-3">
            <SkeletonBone className="h-5 w-5/6" />
            <SkeletonBone className="h-5 w-4/6" />
            <SkeletonBone className="h-5 w-3/4" />
          </Skeleton>
        ) : filteredRecords.length === 0 ? (
          visibleRecords.length === 0 ? (
            <EmptyState
              variant="zero-data"
              scale="sidebar"
              title="No tool dispatches recorded yet"
            />
          ) : (
            <EmptyState
              variant="filtered-empty"
              scale="sidebar"
              title="No records match the current filters"
            />
          )
        ) : groupByTurn && turnGroups ? (
          <ul className="divide-y divide-border-default">
            {turnGroups.groups.map((group) => (
              <li key={group.turnId} className="p-2 text-xs">
                <div className="flex items-center gap-2 mb-1">
                  <span className="font-medium text-text-primary">
                    {OUTCOME_LABEL[group.turnRecord.outcome] ?? group.turnRecord.outcome}
                  </span>
                  <span className="text-text-secondary">
                    {formatRelativeTimestamp(group.turnRecord.timestamp, now)}
                  </span>
                  <span className="text-text-secondary">
                    {group.callCount} call{group.callCount !== 1 ? "s" : ""}
                  </span>
                  {group.unauthorizedCount > 0 && (
                    <span className="text-status-danger/70">
                      {group.unauthorizedCount} unauthorized
                    </span>
                  )}
                  {group.errorCount > 0 && (
                    <span className="text-status-danger/70">
                      {group.errorCount} error{group.errorCount !== 1 ? "s" : ""}
                    </span>
                  )}
                  <span className="text-text-secondary">{group.totalDurationMs}ms</span>
                </div>
                <ul className="ml-3 space-y-1 border-l-2 border-daintree-border/50 pl-3">
                  {group.records.map((record) =>
                    isAuditRecord(record) ? (
                      <li key={record.id} className="grid grid-cols-[auto_1fr_auto] gap-2 py-0.5">
                        <SeverityMark
                          severity={RESULT_SEVERITY[record.result]}
                          label={RESULT_LABEL[record.result]}
                          className="mt-0.5 h-3 w-3"
                        />
                        <div className="min-w-0">
                          <div className="flex items-center gap-2">
                            <span className="font-mono text-text-primary truncate">
                              {record.toolId}
                            </span>
                            {record.errorCode && (
                              <span className="text-3xs uppercase tracking-wide text-status-danger/80">
                                {record.errorCode}
                              </span>
                            )}
                          </div>
                          <div className="font-mono text-text-secondary truncate">
                            {record.argsSummary || "{}"}
                          </div>
                          {record.result === "unauthorized" && record.tierHint && (
                            <div className="mt-0.5 text-3xs text-text-secondary">
                              Raise capability tier to {TIER_HINT_LABEL[record.tierHint]} to allow.
                            </div>
                          )}
                          {record.result === "unauthorized" && record.tierHint === null && (
                            <div className="mt-0.5 text-3xs text-text-secondary">
                              Tool isn't permitted at any tier.
                            </div>
                          )}
                        </div>
                        <div className="text-right text-text-secondary whitespace-nowrap">
                          <div>{record.durationMs}ms</div>
                        </div>
                      </li>
                    ) : (
                      <GrantRow key={record.id} record={record} now={now} compact />
                    )
                  )}
                </ul>
                {group.lifecycle.length > 0 && (
                  <ul className="ml-3 mt-1 space-y-1 border-l-2 border-status-warning/30 pl-3">
                    {group.lifecycle.map((grant) => (
                      <GrantRow key={grant.id} record={grant} now={now} compact />
                    ))}
                  </ul>
                )}
              </li>
            ))}
            {turnGroups.unassociated.length > 0 && (
              <li className="p-2 text-xs">
                <div className="flex items-center gap-2 mb-1">
                  <span className="font-medium text-text-secondary">Unassociated</span>
                  <span className="text-text-secondary">
                    {turnGroups.unassociated.length} record
                    {turnGroups.unassociated.length !== 1 ? "s" : ""}
                  </span>
                </div>
                <ul className="ml-3 space-y-1 border-l-2 border-daintree-border/50 pl-3">
                  {turnGroups.unassociated.map((record) =>
                    isAuditRecord(record) ? (
                      <li key={record.id} className="grid grid-cols-[auto_1fr_auto] gap-2 py-0.5">
                        <SeverityMark
                          severity={RESULT_SEVERITY[record.result]}
                          label={RESULT_LABEL[record.result]}
                          className="mt-0.5 h-3 w-3"
                        />
                        <div className="min-w-0">
                          <div className="flex items-center gap-2">
                            <span className="font-mono text-text-primary truncate">
                              {record.toolId}
                            </span>
                            {record.errorCode && (
                              <span className="text-3xs uppercase tracking-wide text-status-danger/80">
                                {record.errorCode}
                              </span>
                            )}
                          </div>
                          <div className="font-mono text-text-secondary truncate">
                            {record.argsSummary || "{}"}
                          </div>
                        </div>
                        <div className="text-right text-text-secondary whitespace-nowrap">
                          <div>{record.durationMs}ms</div>
                        </div>
                      </li>
                    ) : (
                      <GrantRow key={record.id} record={record} now={now} compact />
                    )
                  )}
                </ul>
              </li>
            )}
            {turnGroups.lifecycle.length > 0 && (
              <li className="p-2 text-xs">
                <div className="flex items-center gap-2 mb-1">
                  <span className="font-medium text-text-secondary">Lifecycle events</span>
                  <span className="text-text-secondary">
                    {turnGroups.lifecycle.length} event
                    {turnGroups.lifecycle.length !== 1 ? "s" : ""}
                  </span>
                </div>
                <ul className="ml-3 space-y-1 border-l-2 border-status-warning/30 pl-3">
                  {turnGroups.lifecycle.map((grant) => (
                    <GrantRow key={grant.id} record={grant} now={now} compact />
                  ))}
                </ul>
              </li>
            )}
          </ul>
        ) : (
          <ul className="divide-y divide-border-default">
            {filteredRecords.map((record) =>
              isAuditRecord(record) ? (
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
                      <span className="font-mono text-text-primary truncate">{record.toolId}</span>
                      {record.errorCode && (
                        <span className="text-3xs uppercase tracking-wide text-status-danger/80">
                          {record.errorCode}
                        </span>
                      )}
                    </div>
                    <div className="mt-0.5 font-mono text-text-secondary truncate">
                      {record.argsSummary || "{}"}
                    </div>
                    {record.result === "unauthorized" && record.tierHint && (
                      <div className="mt-0.5 text-3xs text-text-secondary">
                        Raise capability tier to {TIER_HINT_LABEL[record.tierHint]} to allow.
                      </div>
                    )}
                    {record.result === "unauthorized" && record.tierHint === null && (
                      <div className="mt-0.5 text-3xs text-text-secondary">
                        Tool isn't permitted at any tier.
                      </div>
                    )}
                  </div>
                  <div className="text-right text-text-secondary whitespace-nowrap">
                    <div>{formatRelativeTimestamp(record.timestamp, now)}</div>
                    <div>{record.durationMs}ms</div>
                  </div>
                </li>
              ) : (
                <li key={record.id} className="grid grid-cols-[auto_1fr_auto] gap-2 p-2 text-xs">
                  <SeverityMark
                    severity={GRANT_TYPE_SEVERITY[record.type]}
                    label={GRANT_TYPE_LABEL[record.type]}
                    className="mt-0.5 h-3 w-3"
                    decorative
                  />
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-text-primary">{GRANT_TYPE_LABEL[record.type]}</span>
                      <span className="font-mono text-text-secondary truncate">
                        {record.toolId}
                      </span>
                    </div>
                    {record.type === "tier.elevated" && record.tier && record.previousTier && (
                      <div className="mt-0.5 text-3xs text-text-secondary">
                        {record.previousTier} → {record.tier}
                      </div>
                    )}
                    {record.type === "tier.decayed" && record.tier && record.previousTier && (
                      <div className="mt-0.5 text-3xs text-text-secondary">
                        {record.previousTier} → {record.tier}
                      </div>
                    )}
                    {record.type === "grant.revoked" && record.revokedReason && (
                      <div className="mt-0.5 text-3xs text-text-secondary">
                        Reason: {record.revokedReason}
                      </div>
                    )}
                    {record.expiresAt !== undefined && record.type === "grant.issued" && (
                      <div className="mt-0.5 text-3xs text-text-secondary">
                        Expires{" "}
                        {new Date(record.expiresAt).toLocaleTimeString([], {
                          hour: "2-digit",
                          minute: "2-digit",
                        })}
                      </div>
                    )}
                  </div>
                  <div className="text-right text-text-secondary whitespace-nowrap">
                    <div>{formatRelativeTimestamp(record.timestamp, now)}</div>
                  </div>
                </li>
              )
            )}
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
        {onExport && (
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
        )}
        {onClear && (
          <button
            type="button"
            onClick={onClear}
            disabled={visibleRecords.length === 0}
            className={cn(
              "px-3 py-1.5 text-xs font-medium rounded-[var(--radius-md)] border transition-colors",
              visibleRecords.length === 0
                ? "border-border-default text-daintree-text/30 cursor-not-allowed"
                : "border-border-default text-status-danger hover:text-status-danger hover:bg-status-danger/10 hover:border-status-danger/20"
            )}
          >
            Clear log
          </button>
        )}
        <span className="ml-auto text-xs text-text-secondary">
          {resultFilter !== "all" ||
          toolFilter.trim().length > 0 ||
          timeRange !== "all" ||
          searchQuery.trim().length > 0
            ? `${filteredRecords.length} of ${visibleRecords.length}`
            : maxRecords !== undefined
              ? `${visibleRecords.length} of ${maxRecords}`
              : `${visibleRecords.length}`}
        </span>
      </div>
    </div>
  );
}
