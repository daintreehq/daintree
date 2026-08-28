import { useEffect, useMemo, useState } from "react";
import { ChevronRight, RefreshCw } from "lucide-react";
import { cn } from "@/lib/utils";
import { Skeleton, SkeletonBone } from "@/components/ui/Skeleton";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
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
  "agent-stuck": "Agent stuck",
  "tool-error": "Tool error",
  "reasoning-loop": "Reasoning loop",
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

const RATE_THRESHOLD = { low: 5, medium: 20 } as const;

function rateColor(rate: number): string {
  if (rate <= RATE_THRESHOLD.low) return "text-text-secondary";
  if (rate <= RATE_THRESHOLD.medium) return "text-status-warning";
  return "text-status-danger";
}

interface PerToolRollup {
  toolId: string;
  total: number;
  count: number;
  rate: number;
}

interface TurnOutcomeDiagnosticsProps {
  auditRecords?: McpLogRecord[];
  /**
   * When provided, the component renders these records instead of self-fetching.
   * Lets a parent that already holds turn-outcome data (the assistant settings
   * tab) drive the panel without a redundant IPC round-trip.
   */
  records?: AssistantTurnRecord[];
  /** Refresh handler used in controlled mode; falls back to the internal fetch. */
  onRefresh?: () => Promise<void> | void;
}

export function TurnOutcomeDiagnostics({
  auditRecords,
  records: controlledRecords,
  onRefresh,
}: TurnOutcomeDiagnosticsProps) {
  const isControlled = controlledRecords !== undefined;
  const [internalRecords, setInternalRecords] = useState<AssistantTurnRecord[]>([]);
  const [internalLoading, setInternalLoading] = useState(true);
  const records = isControlled ? controlledRecords : internalRecords;
  const loading = isControlled ? false : internalLoading;
  const [outcomeSectionOpen, setOutcomeSectionOpen] = useState(false);
  const [toolErrorOpen, setToolErrorOpen] = useState(false);
  const [tierRejectedOpen, setTierRejectedOpen] = useState(false);
  const [agentStuckOpen, setAgentStuckOpen] = useState(false);
  const [showClearConfirm, setShowClearConfirm] = useState(false);
  const [isClearing, setIsClearing] = useState(false);

  const fetchRecords = async () => {
    setInternalLoading(true);
    try {
      const result = await window.electron.mcpServer.getTurnOutcomeRecords();
      setInternalRecords(result);
    } catch (err) {
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
    let cleared = false;
    try {
      await window.electron.mcpServer.clearTurnOutcomeLog();
      cleared = true;
      if (!isControlled) setInternalRecords([]);
      setShowClearConfirm(false);
    } catch (err) {
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
  };

  useEffect(() => {
    // Controlled mode: the parent owns the records and loading lifecycle.
    if (isControlled) return;

    let settled = false;
    const timer = setTimeout(() => {
      settled = true;
      setInternalLoading(false);
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

  return (
    <div className="contents">
      {loading ? (
        <Skeleton label="Loading turn outcome diagnostics" className="space-y-3">
          <SkeletonBone className="h-5 w-2/3" />
          <SkeletonBone className="h-5 w-1/2" />
          <SkeletonBone className="h-20 w-full" />
        </Skeleton>
      ) : (
        <>
          {/* Outcome counts */}
          <div className="rounded-[var(--radius-md)] border border-border-default bg-overlay-subtle/40">
            <button
              type="button"
              onClick={() => setOutcomeSectionOpen((v) => !v)}
              aria-expanded={outcomeSectionOpen}
              className={cn(
                "w-full flex items-center justify-between gap-3 px-3 py-2 text-xs",
                "text-daintree-text/80 hover:text-text-primary transition-colors"
              )}
            >
              <span className="flex items-center gap-2">
                <ChevronRight
                  data-animated-chevron
                  className={cn(
                    "w-3.5 h-3.5 transition-transform duration-150",
                    outcomeSectionOpen ? "rotate-90" : "rotate-0"
                  )}
                />
                Turn outcomes by class
                {totalRecords > 0 && (
                  <span className="text-text-secondary">({totalRecords} turns)</span>
                )}
              </span>
            </button>
            {outcomeSectionOpen && (
              <div className="px-3 pb-3 pt-1">
                {totalRecords === 0 ? (
                  <p className="text-xs text-text-secondary">
                    No turn outcome records yet. Turn outcomes are recorded when an agent completes
                    a turn in a help session.
                  </p>
                ) : (
                  <table className="w-full table-fixed text-xs font-mono tabular-nums">
                    <thead>
                      <tr className="text-text-secondary">
                        <th className="text-left font-medium py-1 pr-2">Outcome</th>
                        <th className="text-right font-medium py-1 pl-2 w-16">Count</th>
                        <th className="text-right font-medium py-1 pl-2 w-16">Rate</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-border-default">
                      {OUTCOME_ORDER.map((cls) => {
                        const count = outcomeCounts.get(cls) ?? 0;
                        const rate = totalRecords > 0 ? (count / totalRecords) * 100 : 0;
                        return (
                          <tr key={cls} className="text-text-primary">
                            <td className="py-1 pr-2 truncate">{OUTCOME_LABEL[cls]}</td>
                            <td className="py-1 pl-2 text-right text-text-secondary">{count}</td>
                            <td className={cn("py-1 pl-2 text-right", rateColor(rate))}>
                              {rate.toFixed(1)}%
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                )}
              </div>
            )}
          </div>

          {/* Per-tool rollups: tool-error rate */}
          <div className="rounded-[var(--radius-md)] border border-border-default bg-overlay-subtle/40">
            <button
              type="button"
              onClick={() => setToolErrorOpen((v) => !v)}
              aria-expanded={toolErrorOpen}
              className={cn(
                "w-full flex items-center justify-between gap-3 px-3 py-2 text-xs",
                "text-daintree-text/80 hover:text-text-primary transition-colors"
              )}
            >
              <span className="flex items-center gap-2">
                <ChevronRight
                  data-animated-chevron
                  className={cn(
                    "w-3.5 h-3.5 transition-transform duration-150",
                    toolErrorOpen ? "rotate-90" : "rotate-0"
                  )}
                />
                Tool-error rate by tool
              </span>
            </button>
            {toolErrorOpen && (
              <div className="px-3 pb-3 pt-1">
                {!auditRecords || auditRecords.length === 0 ? (
                  <p className="text-xs text-text-secondary">
                    No audit data available. Enable MCP audit logging to populate per-tool
                    diagnostics.
                  </p>
                ) : toolErrorRollups.length === 0 ? (
                  <p className="text-xs text-text-secondary">No tool-error outcomes recorded.</p>
                ) : (
                  <table className="w-full table-fixed text-xs font-mono tabular-nums">
                    <thead>
                      <tr className="text-text-secondary">
                        <th className="text-left font-medium py-1 pr-2">Tool</th>
                        <th className="text-right font-medium py-1 px-2 w-16">Errors</th>
                        <th className="text-right font-medium py-1 px-2 w-16">Turns</th>
                        <th className="text-right font-medium py-1 px-2 w-16">Rate</th>
                        <th className="text-right font-medium py-1 pl-2 w-40">Recommendation</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-border-default">
                      {toolErrorRollups.map((row) => (
                        <tr key={row.toolId} className="text-text-primary">
                          <td className="py-1 pr-2 truncate">{row.toolId}</td>
                          <td className="py-1 px-2 text-right text-text-secondary">{row.count}</td>
                          <td className="py-1 px-2 text-right text-text-secondary">{row.total}</td>
                          <td className={cn("py-1 px-2 text-right", rateColor(row.rate))}>
                            {row.rate.toFixed(1)}%
                          </td>
                          <td className="py-1 pl-2 text-right text-text-secondary">
                            Review tool configuration
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            )}
          </div>

          {/* Per-tool rollups: tier-rejected rate */}
          <div className="rounded-[var(--radius-md)] border border-border-default bg-overlay-subtle/40">
            <button
              type="button"
              onClick={() => setTierRejectedOpen((v) => !v)}
              aria-expanded={tierRejectedOpen}
              className={cn(
                "w-full flex items-center justify-between gap-3 px-3 py-2 text-xs",
                "text-daintree-text/80 hover:text-text-primary transition-colors"
              )}
            >
              <span className="flex items-center gap-2">
                <ChevronRight
                  data-animated-chevron
                  className={cn(
                    "w-3.5 h-3.5 transition-transform duration-150",
                    tierRejectedOpen ? "rotate-90" : "rotate-0"
                  )}
                />
                Tier-rejected rate by tool
              </span>
            </button>
            {tierRejectedOpen && (
              <div className="px-3 pb-3 pt-1">
                {!auditRecords || auditRecords.length === 0 ? (
                  <p className="text-xs text-text-secondary">
                    No audit data available. Enable MCP audit logging to populate per-tool
                    diagnostics.
                  </p>
                ) : tierRejectedRollups.length === 0 ? (
                  <p className="text-xs text-text-secondary">No tier-rejected outcomes recorded.</p>
                ) : (
                  <table className="w-full table-fixed text-xs font-mono tabular-nums">
                    <thead>
                      <tr className="text-text-secondary">
                        <th className="text-left font-medium py-1 pr-2">Tool</th>
                        <th className="text-right font-medium py-1 px-2 w-16">Rejected</th>
                        <th className="text-right font-medium py-1 px-2 w-16">Turns</th>
                        <th className="text-right font-medium py-1 px-2 w-16">Rate</th>
                        <th className="text-right font-medium py-1 pl-2 w-40">Recommendation</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-border-default">
                      {tierRejectedRollups.map((row) => (
                        <tr key={row.toolId} className="text-text-primary">
                          <td className="py-1 pr-2 truncate">{row.toolId}</td>
                          <td className="py-1 px-2 text-right text-text-secondary">{row.count}</td>
                          <td className="py-1 px-2 text-right text-text-secondary">{row.total}</td>
                          <td className={cn("py-1 px-2 text-right", rateColor(row.rate))}>
                            {row.rate.toFixed(1)}%
                          </td>
                          <td className="py-1 pl-2 text-right text-text-secondary">
                            Audit tier policy
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            )}
          </div>

          {/* Per-tool rollups: agent-stuck rate */}
          <div className="rounded-[var(--radius-md)] border border-border-default bg-overlay-subtle/40">
            <button
              type="button"
              onClick={() => setAgentStuckOpen((v) => !v)}
              aria-expanded={agentStuckOpen}
              className={cn(
                "w-full flex items-center justify-between gap-3 px-3 py-2 text-xs",
                "text-daintree-text/80 hover:text-text-primary transition-colors"
              )}
            >
              <span className="flex items-center gap-2">
                <ChevronRight
                  data-animated-chevron
                  className={cn(
                    "w-3.5 h-3.5 transition-transform duration-150",
                    agentStuckOpen ? "rotate-90" : "rotate-0"
                  )}
                />
                Agent-stuck rate by tool
              </span>
            </button>
            {agentStuckOpen && (
              <div className="px-3 pb-3 pt-1">
                {!auditRecords || auditRecords.length === 0 ? (
                  <p className="text-xs text-text-secondary">
                    No audit data available. Enable MCP audit logging to populate per-tool
                    diagnostics.
                  </p>
                ) : agentStuckRollups.length === 0 ? (
                  <p className="text-xs text-text-secondary">No agent-stuck outcomes recorded.</p>
                ) : (
                  <table className="w-full table-fixed text-xs font-mono tabular-nums">
                    <thead>
                      <tr className="text-text-secondary">
                        <th className="text-left font-medium py-1 pr-2">Tool</th>
                        <th className="text-right font-medium py-1 px-2 w-16">Stuck</th>
                        <th className="text-right font-medium py-1 px-2 w-16">Turns</th>
                        <th className="text-right font-medium py-1 px-2 w-16">Rate</th>
                        <th className="text-right font-medium py-1 pl-2 w-40">Recommendation</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-border-default">
                      {agentStuckRollups.map((row) => (
                        <tr key={row.toolId} className="text-text-primary">
                          <td className="py-1 pr-2 truncate">{row.toolId}</td>
                          <td className="py-1 px-2 text-right text-text-secondary">{row.count}</td>
                          <td className="py-1 px-2 text-right text-text-secondary">{row.total}</td>
                          <td className={cn("py-1 px-2 text-right", rateColor(row.rate))}>
                            {row.rate.toFixed(1)}%
                          </td>
                          <td className="py-1 pl-2 text-right text-text-secondary">
                            Investigate agent loop detection
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            )}
          </div>

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={handleRefresh}
              disabled={loading}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-[var(--radius-md)] border border-border-default text-text-secondary hover:text-text-primary hover:bg-overlay-soft transition-colors"
            >
              <RefreshCw className="w-3.5 h-3.5" />
              Refresh
            </button>
            <button
              type="button"
              onClick={() => setShowClearConfirm(true)}
              disabled={records.length === 0}
              className={cn(
                "px-3 py-1.5 text-xs font-medium rounded-[var(--radius-md)] border transition-colors",
                records.length === 0
                  ? "border-border-default text-text-placeholder cursor-not-allowed"
                  : "border-border-default text-status-danger hover:text-status-danger hover:bg-status-danger/10 hover:border-status-danger/20"
              )}
            >
              Clear log
            </button>
            <span className="ml-auto text-xs text-text-secondary">
              {totalRecords} turn{totalRecords !== 1 ? "s" : ""}
            </span>
          </div>
        </>
      )}

      <ConfirmDialog
        isOpen={showClearConfirm}
        onClose={isClearing ? undefined : handleCancelClear}
        title="Clear turn-outcome log?"
        description="All recorded turn outcomes will be permanently deleted. This can't be undone."
        confirmLabel="Clear log"
        cancelLabel="Cancel"
        onConfirm={confirmClearTurnOutcomeLog}
        isConfirmLoading={isClearing}
        variant="destructive"
        zIndex="nested"
      />
    </div>
  );
}
