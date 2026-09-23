import { useEffect, useId, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { ChevronRight, RefreshCw } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Skeleton, SkeletonBone } from "@/components/ui/Skeleton";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { SettingsActions, SettingsEmptyRow, SettingsGroup } from "./SettingsGroup";
import { ErrorRetryRow } from "./auditLogParts";
import { logError } from "@/utils/logger";
import {
  type AssistantTurnRecord,
  type McpLogRecord,
  type TurnOutcomeClass,
  isAuditRecord,
} from "@shared/types";

const OUTCOME_LABEL: Record<TurnOutcomeClass, string> = {
  answered: "Answered",
  hedged: "Hedged",
  refused: "Refused",
  "docs-empty": "Docs empty",
  "tier-rejected": "Tier rejected",
  "mcp-not-ready": "MCP not ready",
  "agent-stuck": "Went quiet",
  "tool-error": "Tool error",
  "reasoning-loop": "Repeated tool call",
  "hibernate-resume-stale": "Resume stale",
  unknown: "Unknown",
};

const OUTCOME_ORDER: TurnOutcomeClass[] = [
  "answered",
  "hedged",
  "refused",
  "docs-empty",
  "tier-rejected",
  "mcp-not-ready",
  "agent-stuck",
  "tool-error",
  "reasoning-loop",
  "hibernate-resume-stale",
  "unknown",
];

interface PerToolRollup {
  toolId: string;
  total: number;
  count: number;
  rate: number;
}

function formatRate(rate: number): string {
  return `${rate.toFixed(1)}%`;
}

function plural(count: number, one: string, many: string = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`;
}

/**
 * One collapsible row of the diagnostics group. The summary sits on the rail so a
 * closed row still says whether it is worth opening.
 */
function DisclosureRow({
  title,
  summary,
  defaultOpen = false,
  children,
}: {
  title: string;
  summary?: ReactNode;
  defaultOpen?: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const panelId = useId();
  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-controls={panelId}
        className="flex w-full items-center gap-2 px-4 py-3 text-left text-sm font-medium text-text-primary hover:bg-overlay-soft transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent-primary"
      >
        <ChevronRight
          data-animated-chevron
          aria-hidden="true"
          className={cn(
            "w-3.5 h-3.5 shrink-0 text-text-secondary transition-transform duration-150",
            open && "rotate-90"
          )}
        />
        <span className="flex-1">{title}</span>
        {summary && <span className="text-xs font-normal text-text-secondary">{summary}</span>}
      </button>
      {open && (
        <div id={panelId} className="px-4 pb-3 pl-9">
          {children}
        </div>
      )}
    </div>
  );
}

const TH = "py-1.5 font-medium text-text-secondary";
const TD_NUM = "py-1.5 text-right tabular-nums";

function RollupTable({
  rows,
  countLabel,
  caption,
}: {
  rows: PerToolRollup[];
  countLabel: string;
  caption: string;
}) {
  return (
    <table className="w-full table-fixed text-xs">
      <caption className="sr-only">{caption}</caption>
      <thead>
        <tr className="border-b border-border-subtle">
          <th scope="col" className={cn(TH, "text-left pr-2")}>
            Tool
          </th>
          <th scope="col" className={cn(TH, "text-right px-2 w-28")}>
            {countLabel}
          </th>
          <th scope="col" className={cn(TH, "text-right px-2 w-28")}>
            Session turns
          </th>
          <th scope="col" className={cn(TH, "text-right pl-2 w-20")}>
            Share
          </th>
        </tr>
      </thead>
      <tbody className="divide-y divide-border-subtle">
        {rows.map((row) => (
          <tr key={row.toolId}>
            <th
              scope="row"
              className="py-1.5 pr-2 text-left font-mono font-normal text-text-primary truncate"
            >
              {row.toolId}
            </th>
            <td className={cn(TD_NUM, "px-2 text-text-primary")}>{row.count}</td>
            <td className={cn(TD_NUM, "px-2 text-text-secondary")}>{row.total}</td>
            <td className={cn(TD_NUM, "pl-2 text-text-primary")}>{formatRate(row.rate)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

interface TurnOutcomeDiagnosticsProps {
  auditRecords?: McpLogRecord[];
  /**
   * When provided, the component renders these records instead of self-fetching.
   * Lets a parent that already holds turn-outcome data drive the panel without a
   * redundant IPC round-trip.
   */
  records?: AssistantTurnRecord[];
  /** Refresh handler used in controlled mode; falls back to the internal fetch. */
  onRefresh?: () => Promise<void> | void;
  /** Controlled mode: the parent's read of the turn records failed. */
  loadFailed?: boolean;
  /** Controlled mode: the parent is still reading, so no empty state is claimed yet. */
  loading?: boolean;
}

export function TurnOutcomeDiagnostics({
  auditRecords,
  records: controlledRecords,
  onRefresh,
  loadFailed = false,
  loading: controlledLoading = false,
}: TurnOutcomeDiagnosticsProps) {
  const isControlled = controlledRecords !== undefined;
  const [internalRecords, setInternalRecords] = useState<AssistantTurnRecord[]>([]);
  const [internalLoading, setInternalLoading] = useState(true);
  const [internalFailed, setInternalFailed] = useState(false);
  const records = isControlled ? controlledRecords : internalRecords;
  const loading = isControlled ? controlledLoading : internalLoading;
  const failed = isControlled ? loadFailed : internalFailed;
  const [showClearConfirm, setShowClearConfirm] = useState(false);
  const [isClearing, setIsClearing] = useState(false);
  const [clearFailed, setClearFailed] = useState(false);

  const fetchRecords = async () => {
    setInternalLoading(true);
    try {
      const result = await window.electron.mcpServer.getTurnOutcomeRecords();
      setInternalRecords(result);
      setInternalFailed(false);
    } catch (err) {
      setInternalFailed(true);
      logError("Failed to load turn outcome records", err);
    } finally {
      setInternalLoading(false);
    }
  };

  const handleRefresh = () => {
    if (isControlled) {
      void onRefresh?.();
    } else {
      void fetchRecords();
    }
  };

  const confirmClearTurnOutcomeLog = async () => {
    if (isClearing) return;
    setIsClearing(true);
    setClearFailed(false);
    let cleared = false;
    try {
      await window.electron.mcpServer.clearTurnOutcomeLog();
      cleared = true;
      if (!isControlled) setInternalRecords([]);
      setShowClearConfirm(false);
    } catch (err) {
      setClearFailed(true);
      logError("Failed to clear turn outcome log", err);
    } finally {
      setIsClearing(false);
    }
    // The post-clear refresh is best-effort: the clear already committed, so a
    // refresh failure must not reopen the dialog or re-surface the destructive
    // action — log it separately and leave the closed, cleared state intact.
    if (cleared && isControlled) {
      try {
        await onRefresh?.();
      } catch (err) {
        logError("Failed to refresh turn outcomes after clearing log", err);
      }
    }
  };

  const handleCancelClear = () => {
    if (isClearing) return;
    setShowClearConfirm(false);
    setClearFailed(false);
  };

  useEffect(() => {
    // Controlled mode: the parent owns the records and loading lifecycle.
    if (isControlled) return;

    let settled = false;
    const timer = setTimeout(() => {
      settled = true;
      setInternalLoading(false);
      setInternalFailed(true);
      logError("Turn outcome records load timed out");
    }, 10_000);

    window.electron.mcpServer
      .getTurnOutcomeRecords()
      .then((result) => {
        if (settled) return;
        setInternalRecords(result);
      })
      .catch((err) => {
        if (settled) return;
        setInternalFailed(true);
        logError("Failed to load turn outcome records", err);
      })
      .finally(() => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          setInternalLoading(false);
        }
      });

    return () => {
      // Mark settled so a late-resolving fetch can't write state after unmount
      // or after a switch into controlled mode.
      settled = true;
      clearTimeout(timer);
    };
  }, [isControlled]);

  const outcomeCounts = useMemo(() => {
    const counts = new Map<TurnOutcomeClass, number>();
    for (const cls of OUTCOME_ORDER) counts.set(cls, 0);
    for (const r of records) {
      counts.set(r.outcome, (counts.get(r.outcome) ?? 0) + 1);
    }
    return counts;
  }, [records]);

  const sessionToTools = useMemo(() => {
    const map = new Map<string, Set<string>>();
    if (!auditRecords) return map;
    for (const r of auditRecords) {
      // Grant lifecycle records (#8442) carry no `helpSessionId` or
      // `toolId` join key relevant to the per-tool rollup; skip them.
      if (!isAuditRecord(r)) continue;
      // Turn records carry the HELP session id; audit records carry the MCP
      // transport id in `sessionId` and the help id in `helpSessionId` —
      // key on the latter or the rollup join below never matches.
      if (!r.helpSessionId) continue;
      let tools = map.get(r.helpSessionId);
      if (!tools) {
        tools = new Set();
        map.set(r.helpSessionId, tools);
      }
      tools.add(r.toolId);
    }
    return map;
  }, [auditRecords]);

  // Every tool a session used is counted against each of that session's turns:
  // the join is by session, so these are associations, not a finding that the
  // tool caused the outcome. The labels say "sessions that used", never "caused by".
  const { toolErrorRollups, tierRejectedRollups, agentStuckRollups } = useMemo(() => {
    const toolTurns = new Map<string, number>();
    const toolErrors = new Map<string, number>();
    const tierRejected = new Map<string, number>();
    const agentStuck = new Map<string, number>();

    for (const r of records) {
      if (!r.sessionId) continue;
      const tools = sessionToTools.get(r.sessionId);
      if (!tools || tools.size === 0) continue;
      for (const toolId of tools) {
        toolTurns.set(toolId, (toolTurns.get(toolId) ?? 0) + 1);
        if (r.outcome === "tool-error") {
          toolErrors.set(toolId, (toolErrors.get(toolId) ?? 0) + 1);
        }
        if (r.outcome === "tier-rejected") {
          tierRejected.set(toolId, (tierRejected.get(toolId) ?? 0) + 1);
        }
        if (r.outcome === "agent-stuck") {
          agentStuck.set(toolId, (agentStuck.get(toolId) ?? 0) + 1);
        }
      }
    }

    const buildRollup = (counts: Map<string, number>): PerToolRollup[] => {
      const results: PerToolRollup[] = [];
      for (const [toolId, total] of toolTurns) {
        const count = counts.get(toolId) ?? 0;
        results.push({
          toolId,
          total,
          count,
          rate: total > 0 ? (count / total) * 100 : 0,
        });
      }
      results.sort((a, b) => b.rate - a.rate || b.total - a.total);
      return results;
    };

    return {
      toolErrorRollups: buildRollup(toolErrors),
      tierRejectedRollups: buildRollup(tierRejected),
      agentStuckRollups: buildRollup(agentStuck),
    };
  }, [records, sessionToTools]);

  const totalRecords = records.length;
  const hasAuditData = !!auditRecords && auditRecords.length > 0;

  const rollupBody = (rows: PerToolRollup[], countLabel: string, what: string) =>
    !hasAuditData ? (
      <p className="text-xs text-text-secondary">
        Needs the audit log: per-tool figures come from the tool calls recorded there
      </p>
    ) : rows.length === 0 ? (
      <p className="text-xs text-text-secondary">No turn in the log used a recorded tool</p>
    ) : (
      <>
        <RollupTable rows={rows} countLabel={countLabel} caption={what} />
        <p className="mt-2 text-xs text-text-secondary">
          Session turns counts every turn in the sessions that used the tool, so a turn appears
          under each tool its session used.
        </p>
      </>
    );

  const summaryFor = (outcome: TurnOutcomeClass) => plural(outcomeCounts.get(outcome) ?? 0, "turn");

  return (
    <>
      <SettingsGroup>
        {loading ? (
          <Skeleton label="Loading turn outcome diagnostics" className="space-y-3 px-4 py-3">
            <SkeletonBone className="h-5 w-2/3" />
            <SkeletonBone className="h-5 w-1/2" />
          </Skeleton>
        ) : failed ? (
          <ErrorRetryRow message="Turn outcomes couldn't be read" onRetry={handleRefresh} />
        ) : totalRecords === 0 ? (
          <SettingsEmptyRow>
            Outcomes show up here once an assistant session finishes a turn
          </SettingsEmptyRow>
        ) : (
          <>
            <DisclosureRow title="Outcomes by class" summary={plural(totalRecords, "turn")}>
              <table className="w-full table-fixed text-xs">
                <caption className="sr-only">Turn outcomes by class</caption>
                <thead>
                  <tr className="border-b border-border-subtle">
                    <th scope="col" className={cn(TH, "text-left pr-2")}>
                      Outcome
                    </th>
                    <th scope="col" className={cn(TH, "text-right pl-2 w-20")}>
                      Turns
                    </th>
                    <th scope="col" className={cn(TH, "text-right pl-2 w-20")}>
                      Share
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border-subtle">
                  {OUTCOME_ORDER.map((cls) => {
                    const count = outcomeCounts.get(cls) ?? 0;
                    const rate = totalRecords > 0 ? (count / totalRecords) * 100 : 0;
                    return (
                      <tr key={cls} className={cn(count === 0 && "text-text-secondary")}>
                        <th
                          scope="row"
                          className={cn(
                            "py-1.5 pr-2 text-left font-normal",
                            count > 0 ? "text-text-primary" : "text-text-secondary"
                          )}
                        >
                          {OUTCOME_LABEL[cls]}
                        </th>
                        <td className={cn(TD_NUM, "pl-2")}>{count}</td>
                        <td className={cn(TD_NUM, "pl-2")}>{formatRate(rate)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </DisclosureRow>
            <DisclosureRow
              title="Tool errors, by tool the session used"
              summary={summaryFor("tool-error")}
            >
              {rollupBody(
                toolErrorRollups,
                "Error turns",
                "Tool-error turns by tool the session used"
              )}
            </DisclosureRow>
            <DisclosureRow
              title="Tier rejections, by tool the session used"
              summary={summaryFor("tier-rejected")}
            >
              {rollupBody(
                tierRejectedRollups,
                "Rejected turns",
                "Tier-rejected turns by tool the session used"
              )}
            </DisclosureRow>
            <DisclosureRow
              title="Stuck agents, by tool the session used"
              summary={summaryFor("agent-stuck")}
            >
              {rollupBody(
                agentStuckRollups,
                "Stuck turns",
                "Agent-stuck turns by tool the session used"
              )}
            </DisclosureRow>
          </>
        )}

        <SettingsActions status={loading ? null : plural(totalRecords, "turn")}>
          <Button variant="outline" size="sm" onClick={handleRefresh} disabled={loading}>
            <RefreshCw aria-hidden="true" />
            Refresh
          </Button>
          <Button
            variant="ghost-danger"
            size="sm"
            onClick={() => setShowClearConfirm(true)}
            disabled={records.length === 0}
          >
            Clear turn outcomes…
          </Button>
        </SettingsActions>
      </SettingsGroup>

      <ConfirmDialog
        isOpen={showClearConfirm}
        onClose={isClearing ? undefined : handleCancelClear}
        title="Clear turn outcomes?"
        description={`This permanently deletes ${plural(totalRecords, "recorded turn outcome")}. The MCP audit log isn't affected.`}
        confirmLabel="Clear turn outcomes"
        cancelLabel="Cancel"
        onConfirm={confirmClearTurnOutcomeLog}
        isConfirmLoading={isClearing}
        hint={clearFailed ? "Turn outcomes couldn't be cleared. Try again." : undefined}
        variant="destructive"
        zIndex="nested"
      />
    </>
  );
}
