import { useMemo, useState } from "react";
import { Check, Copy, Download, Layers, RefreshCw, ShieldOff } from "lucide-react";
import { cn } from "@/lib/utils";
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
import {
  type HelpAssistantTier,
  type McpAuditRecord,
  type McpAuditResult,
  type McpGrantRecord,
  type McpLogRecord,
  type McpGrantRecordType,
  isAuditRecord,
  isGrantRecord,
  type AssistantTurnRecord,
  type McpAnomalySeverity,
  type McpAnomalySignal,
} from "@shared/types";

/** "problems" is every dispatch that didn't succeed. */
type AuditResultFilter = "all" | "problems" | McpAuditResult;

const RESULT_FILTER_OPTIONS: { value: AuditResultFilter; label: string }[] = [
  { value: "all", label: "All results" },
  { value: "problems", label: "Problems" },
  { value: "success", label: "Success" },
  { value: "error", label: "Error" },
  { value: "confirmation-pending", label: "Awaiting confirmation" },
  { value: "unauthorized", label: "Unauthorized" },
  { value: "dedup", label: "Deduplicated" },
  { value: "collision", label: "Key collision" },
  { value: "rate_limited", label: "Rate limited" },
];

const TIER_HINT_LABEL: Record<HelpAssistantTier, string> = {
  core: "Core",
  full: "Full",
};

// Records written before the core/full split carry the old ladder names. They
// describe a tier that no longer exists, so they read as history rather than
// being guessed onto the new pair.
function tierHintText(tier: string): string {
  const label = TIER_HINT_LABEL[tier as HelpAssistantTier];
  return label ? `Needs the ${label} tool set` : `Needed the former ${tier} tier`;
}

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

// Signals overlap (a record can back several), so the banner and each row
// marker take the highest severity among the signals they summarise.
const ANOMALY_SEVERITY_RANK: Record<McpAnomalySeverity, number> = {
  info: 0,
  warning: 1,
  danger: 2,
};

/**
 * The severity lives in the mark; the words stay in neutral text, since
 * severity-coloured text fails 4.5:1 on most themes.
 */
const ANOMALY_SEVERITY_VISUAL: Record<McpAnomalySeverity, { label: string; mark: string }> = {
  // Info is drawn hollow: forced-colors paints every `.status-mark` fill the
  // same CanvasText, but a border-only diamond stays distinct from a filled one.
  info: { label: "Anomaly (info)", mark: "border border-text-secondary" },
  warning: { label: "Anomaly (warning)", mark: "status-mark bg-status-warning" },
  danger: { label: "Anomaly (error)", mark: "status-mark bg-status-danger" },
};

function higherSeverity(a: McpAnomalySeverity, b: McpAnomalySeverity): McpAnomalySeverity {
  return ANOMALY_SEVERITY_RANK[b] > ANOMALY_SEVERITY_RANK[a] ? b : a;
}

function AnomalyMark({
  severity,
  decorative = false,
}: {
  severity: McpAnomalySeverity | undefined;
  decorative?: boolean;
}) {
  if (!severity) return null;
  const { label, mark } = ANOMALY_SEVERITY_VISUAL[severity];
  return (
    <span
      role={decorative ? undefined : "img"}
      aria-hidden={decorative || undefined}
      aria-label={decorative ? undefined : label}
      title={label}
      className={cn("h-2 w-2 rounded-sm rotate-45 shrink-0", mark)}
    />
  );
}

const OUTCOME_LABEL: Record<string, string> = {
  answered: "Answered",
  hedged: "Hedged",
  refused: "Refused",
  "docs-empty": "No docs found",
  "tier-rejected": "Tier rejected",
  "mcp-not-ready": "MCP not ready",
  "agent-stuck": "Went quiet",
  "tool-error": "Tool error",
  "reasoning-loop": "Repeated tool call",
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

function plural(count: number, one: string, many: string = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`;
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
  /** Shown in place of the list when the records couldn't be read. */
  loadError?: React.ReactNode;
  /** A copy or export that failed, shown beside the actions. */
  actionError?: string | null;
  /**
   * What an empty log says. The default is the first-use line; a parent that
   * just cleared the log passes its own, so a deliberate clear doesn't read as
   * "nothing has ever happened".
   */
  emptyLabel?: string;
  /** DOM id for the log's group, so a settings deep link can land on it. */
  id?: string;
}

function DispatchRow({
  record,
  now,
  anomaly,
}: {
  record: McpAuditRecord;
  now: number;
  anomaly?: McpAnomalySeverity;
}) {
  const args = record.argsSummary || "{}";
  return (
    <li className="grid grid-cols-[auto_1fr_auto] gap-2 px-4 py-2 text-xs">
      <div className="flex self-start items-center gap-1 mt-0.5">
        <SeverityMark
          severity={RESULT_SEVERITY[record.result]}
          label={RESULT_LABEL[record.result]}
          className="h-3 w-3"
        />
        <AnomalyMark severity={anomaly} />
      </div>
      <div className="min-w-0 select-text">
        <div className="flex items-center gap-2">
          <span className="min-w-0 font-mono text-text-primary break-all">{record.toolId}</span>
          {record.result !== "success" && (
            <span className="shrink-0 text-text-secondary">
              {RESULT_LABEL[record.result]}
              {record.errorCode ? ` · ${record.errorCode}` : ""}
              {record.result === "rate_limited" && record.resultMeta?.retryAfter
                ? ` · retry in ${record.resultMeta.retryAfter}s`
                : ""}
            </span>
          )}
        </div>
        <div className="mt-0.5 font-mono text-text-secondary break-all line-clamp-3" title={args}>
          {args}
        </div>
        {record.result === "unauthorized" && record.tierHint && (
          <div className="mt-0.5 text-text-secondary">{tierHintText(record.tierHint)}</div>
        )}
        {record.result === "unauthorized" && record.tierHint === null && (
          <div className="mt-0.5 text-text-secondary">Not permitted at any tier</div>
        )}
      </div>
      <div className="text-right text-text-secondary whitespace-nowrap tabular-nums">
        <div>
          <AuditRecordTime ts={record.timestamp} now={now} />
        </div>
        <div>{record.durationMs}ms</div>
      </div>
    </li>
  );
}

/** A grant-lifecycle event. Grants carry no `result` or `durationMs`. */
function GrantRow({ record, now }: { record: McpGrantRecord; now: number }) {
  const tierMove =
    (record.type === "tier.elevated" || record.type === "tier.decayed") &&
    record.tier &&
    record.previousTier
      ? `${record.previousTier} → ${record.tier}`
      : null;
  return (
    <li className="grid grid-cols-[auto_1fr_auto] gap-2 px-4 py-2 text-xs">
      <SeverityMark
        severity={GRANT_TYPE_SEVERITY[record.type]}
        label={GRANT_TYPE_LABEL[record.type]}
        className="mt-0.5 h-3 w-3"
        decorative
      />
      <div className="min-w-0 select-text">
        <div className="flex items-center gap-2">
          <span className="text-text-primary">{GRANT_TYPE_LABEL[record.type]}</span>
          <span className="min-w-0 font-mono text-text-secondary break-all">{record.toolId}</span>
        </div>
        {tierMove && <div className="mt-0.5 text-text-secondary">{tierMove}</div>}
        {record.type === "grant.revoked" && record.revokedReason && (
          <div className="mt-0.5 text-text-secondary">Reason: {record.revokedReason}</div>
        )}
        {record.maxUses !== undefined &&
          (record.type === "grant.used" || record.type === "grant.exhausted") && (
            <div className="mt-0.5 text-text-secondary">
              {record.remainingUses ?? 0} of {record.maxUses} uses left
            </div>
          )}
        {record.expiresAt !== undefined && record.type === "grant.issued" && (
          <div className="mt-0.5 text-text-secondary">
            Expires{" "}
            {new Date(record.expiresAt).toLocaleTimeString([], {
              hour: "2-digit",
              minute: "2-digit",
            })}
          </div>
        )}
      </div>
      <div className="text-right text-text-secondary whitespace-nowrap tabular-nums">
        <AuditRecordTime ts={record.timestamp} now={now} />
      </div>
    </li>
  );
}

function LogRow({
  record,
  now,
  anomaly,
}: {
  record: McpLogRecord;
  now: number;
  anomaly?: McpAnomalySeverity;
}) {
  return isAuditRecord(record) ? (
    <DispatchRow record={record} now={now} anomaly={anomaly} />
  ) : (
    <GrantRow record={record} now={now} />
  );
}

/** A turn's (or the leftover) records, under a one-line summary. */
function RecordBlock({
  heading,
  summary,
  children,
}: {
  heading: string;
  summary: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <li className="py-1">
      <div className="flex flex-wrap items-center gap-x-2 px-4 pt-1.5 text-xs">
        <span className="font-medium text-text-primary">{heading}</span>
        <span className="text-text-secondary">{summary}</span>
      </div>
      <ul className="ml-4 border-l-2 border-border-default">{children}</ul>
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
  emptyLabel = "Tool calls show up here once an agent uses the MCP server",
  loadError,
  actionError,
  id,
}: McpAuditLogViewerProps) {
  const [toolFilter, setToolFilter] = useState("");
  const [resultFilter, setResultFilter] = useState<AuditResultFilter>("all");
  const [timeRange, setTimeRange] = useState<AuditTimeRange>("all");
  const [searchQuery, setSearchQuery] = useState("");
  const [groupByTurn, setGroupByTurn] = useState(false);

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
    // Grants carry no result or arguments of their own. With no narrowing they
    // all show; once the view is narrowed, a grant stays only as context for a
    // session that has a matching call (#10027 keeps them in forensic exports),
    // so an unrelated session's grant never props up an otherwise empty result.
    const needle = toolFilter.trim().toLowerCase();
    const searchNeedle = searchQuery.trim().toLowerCase();
    const cutoffMs = timeRange !== "all" ? now - AUDIT_TIME_RANGE_MS[timeRange] : undefined;
    const narrowed = needle.length > 0 || searchNeedle.length > 0 || resultFilter !== "all";
    const matchesDispatch = (record: McpAuditRecord) => {
      if (resultFilter === "problems" && record.result === "success") return false;
      if (resultFilter !== "all" && resultFilter !== "problems" && record.result !== resultFilter) {
        return false;
      }
      if (needle.length > 0 && !record.toolId.toLowerCase().includes(needle)) return false;
      if (
        searchNeedle.length > 0 &&
        !(record.argsSummary ?? "").toLowerCase().includes(searchNeedle)
      ) {
        return false;
      }
      return true;
    };
    const inRange = visibleRecords.filter(
      (record) => cutoffMs === undefined || record.timestamp >= cutoffMs
    );
    const matchingSessions = new Set<string>();
    for (const record of inRange) {
      if (isAuditRecord(record) && matchesDispatch(record)) matchingSessions.add(record.sessionId);
    }
    return inRange.filter((record) =>
      isAuditRecord(record)
        ? matchesDispatch(record)
        : !narrowed || matchingSessions.has(record.sessionId)
    );
  }, [visibleRecords, resultFilter, toolFilter, timeRange, searchQuery, now]);

  const canGroup = !!turnRecords && turnRecords.length > 0;
  const turnGroups = useMemo(() => {
    if (!groupByTurn || !turnRecords || turnRecords.length === 0) return null;
    return groupRecordsByTurn(filteredRecords, turnRecords);
  }, [groupByTurn, turnRecords, filteredRecords]);

  const isFiltering =
    resultFilter !== "all" ||
    toolFilter.trim().length > 0 ||
    timeRange !== "all" ||
    searchQuery.trim().length > 0;
  const showCopyAll = filteredRecords.length === visibleRecords.length;

  const clearFilters = () => {
    setToolFilter("");
    setSearchQuery("");
    setResultFilter("all");
    setTimeRange("all");
  };

  // Stats are a snapshot fetched on mount/refresh; `expiresAt` lets a view left
  // open drop signals the detector has since stopped emitting.
  const visibleSignals = useMemo(() => {
    if (anomalySuppressed) return [];
    return anomalySignals.filter((s) => s.expiresAt === undefined || s.expiresAt > now);
  }, [anomalySignals, anomalySuppressed, now]);

  const signalSeverityByRecordId = useMemo(() => {
    const map = new Map<string, McpAnomalySeverity>();
    for (const sig of visibleSignals) {
      for (const id of sig.recordIds) {
        const prev = map.get(id);
        map.set(id, prev ? higherSeverity(prev, sig.severity) : sig.severity);
      }
    }
    return map;
  }, [visibleSignals]);

  const bannerSeverity = useMemo(() => {
    let highest: McpAnomalySeverity | null = null;
    for (const sig of visibleSignals) {
      highest = highest ? higherSeverity(highest, sig.severity) : sig.severity;
    }
    return highest;
  }, [visibleSignals]);

  const anomalyCountsByKind = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const sig of visibleSignals) {
      counts[sig.kind] = (counts[sig.kind] ?? 0) + 1;
    }
    return counts;
  }, [visibleSignals]);

  const relatedEventCount = isFiltering ? filteredRecords.filter(isGrantRecord).length : 0;

  const status = copyFlashActive
    ? "Copied!"
    : exportFlashActive
      ? "Exported!"
      : isFiltering
        ? relatedEventCount > 0
          ? `Showing ${filteredRecords.length - relatedEventCount} of ${visibleRecords.length} · ${plural(relatedEventCount, "related event")}`
          : `Showing ${filteredRecords.length} of ${visibleRecords.length}`
        : maxRecords !== undefined
          ? `${visibleRecords.length} of ${maxRecords}`
          : plural(visibleRecords.length, "record");

  const hasQuickViews = (unauthorizedCount > 0 && resultFilter !== "unauthorized") || canGroup;

  return (
    <SettingsGroup id={id}>
      <div>
        <AuditFilterBar label="Filter MCP audit log">
          <AuditFilterInput
            value={toolFilter}
            onChange={setToolFilter}
            placeholder="Filter by tool ID"
            ariaLabel="Filter audit by tool name"
          />
          <AuditFilterInput
            value={searchQuery}
            onChange={setSearchQuery}
            placeholder="Search arguments"
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
        {hasQuickViews && (
          <div className="flex flex-wrap items-center gap-2 px-4 pb-3 -mt-1">
            {unauthorizedCount > 0 && resultFilter !== "unauthorized" && (
              <Button variant="outline" size="sm" onClick={() => setResultFilter("unauthorized")}>
                <ShieldOff aria-hidden="true" />
                Show unauthorized ({unauthorizedCount})
              </Button>
            )}
            {canGroup && (
              <Button
                variant="outline"
                size="sm"
                aria-pressed={groupByTurn}
                onClick={() => setGroupByTurn((v) => !v)}
                className={cn(groupByTurn && "bg-overlay-selected text-text-primary")}
              >
                <Layers aria-hidden="true" />
                Group by turn
              </Button>
            )}
          </div>
        )}
      </div>

      {bannerSeverity && (
        <div
          data-anomaly-severity={bannerSeverity}
          className="flex items-center gap-2 px-4 py-2.5 text-xs text-text-primary"
        >
          <AnomalyMark severity={bannerSeverity} decorative />
          <span>
            {visibleSignals.length} anomaly signal{visibleSignals.length !== 1 ? "s" : ""}
            {Object.entries(anomalyCountsByKind).length > 0 &&
              ` (${Object.entries(anomalyCountsByKind)
                .map(([kind, count]) => `${count} ${kind}`)
                .join(", ")})`}
          </span>
        </div>
      )}

      {!loading && loadError && visibleRecords.length > 0 && loadError}

      {loading ? (
        <Skeleton label="Loading audit records" className="space-y-2 px-4 py-3">
          <SkeletonBone className="h-5 w-5/6" />
          <SkeletonBone className="h-5 w-4/6" />
          <SkeletonBone className="h-5 w-3/4" />
        </Skeleton>
      ) : loadError && visibleRecords.length === 0 ? (
        loadError
      ) : filteredRecords.length === 0 ? (
        visibleRecords.length === 0 ? (
          <SettingsEmptyRow>{emptyLabel}</SettingsEmptyRow>
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
      ) : groupByTurn && turnGroups ? (
        <ul className="max-h-80 overflow-y-auto divide-y divide-border-subtle">
          {turnGroups.groups.map((group) => (
            <RecordBlock
              key={group.turnId}
              heading={OUTCOME_LABEL[group.turnRecord.outcome] ?? group.turnRecord.outcome}
              summary={
                <>
                  <AuditRecordTime ts={group.turnRecord.timestamp} now={now} />
                  {` · ${plural(group.callCount, "call")}`}
                  {group.unauthorizedCount > 0 && ` · ${group.unauthorizedCount} unauthorized`}
                  {group.errorCount > 0 && ` · ${plural(group.errorCount, "error")}`}
                  {` · ${group.totalDurationMs}ms`}
                </>
              }
            >
              {group.records.map((record) => (
                <LogRow key={record.id} record={record} now={now} />
              ))}
              {group.lifecycle.map((grant) => (
                <GrantRow key={grant.id} record={grant} now={now} />
              ))}
            </RecordBlock>
          ))}
          {turnGroups.unassociated.length > 0 && (
            <RecordBlock
              heading="Outside any turn"
              summary={plural(turnGroups.unassociated.length, "record")}
            >
              {turnGroups.unassociated.map((record) => (
                <LogRow key={record.id} record={record} now={now} />
              ))}
            </RecordBlock>
          )}
          {turnGroups.lifecycle.length > 0 && (
            <RecordBlock
              heading="Lifecycle events"
              summary={plural(turnGroups.lifecycle.length, "event")}
            >
              {turnGroups.lifecycle.map((grant) => (
                <GrantRow key={grant.id} record={grant} now={now} />
              ))}
            </RecordBlock>
          )}
        </ul>
      ) : (
        <ul className="max-h-80 overflow-y-auto divide-y divide-border-subtle">
          {filteredRecords.map((record) => (
            <LogRow
              key={record.id}
              record={record}
              now={now}
              anomaly={signalSeverityByRecordId.get(record.id)}
            />
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
        {onExport && (
          <Button
            variant="outline"
            size="sm"
            onClick={() => void onExport(filteredRecords)}
            disabled={filteredRecords.length === 0}
          >
            {exportFlashActive ? <Check aria-hidden="true" /> : <Download aria-hidden="true" />}
            Export as NDJSON
          </Button>
        )}
        {onClear && (
          <Button
            variant="ghost-danger"
            size="sm"
            onClick={onClear}
            disabled={visibleRecords.length === 0}
          >
            Clear audit log…
          </Button>
        )}
      </SettingsActions>
    </SettingsGroup>
  );
}
