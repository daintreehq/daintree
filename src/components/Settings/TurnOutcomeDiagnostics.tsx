import { useEffect, useMemo, useState } from "react";
import { ChevronRight, RefreshCw } from "lucide-react";
import { cn } from "@/lib/utils";
import { Skeleton, SkeletonBone } from "@/components/ui/Skeleton";
import { logError } from "@/utils/logger";
import type { AssistantTurnRecord, McpAuditRecord, TurnOutcomeClass } from "@shared/types";

const OUTCOME_LABEL: Record<TurnOutcomeClass, string> = {
  answered: "Answered",
  hedged: "Hedged",
  refused: "Refused",
  "docs-empty": "Docs empty",
  "tier-rejected": "Tier rejected",
  "mcp-not-ready": "MCP not ready",
  "agent-stuck": "Agent stuck",
  "tool-error": "Tool error",
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
  "hibernate-resume-stale",
  "unknown",
];

const RATE_THRESHOLD = { low: 5, medium: 20 } as const;

function rateColor(rate: number): string {
  if (rate <= RATE_THRESHOLD.low) return "text-status-success";
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
  auditRecords?: McpAuditRecord[];
}

export function TurnOutcomeDiagnostics({ auditRecords }: TurnOutcomeDiagnosticsProps) {
  const [records, setRecords] = useState<AssistantTurnRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [outcomeSectionOpen, setOutcomeSectionOpen] = useState(true);
  const [toolErrorOpen, setToolErrorOpen] = useState(true);
  const [tierRejectedOpen, setTierRejectedOpen] = useState(true);
  const [agentStuckOpen, setAgentStuckOpen] = useState(false);

  const fetchRecords = async () => {
    setLoading(true);
    try {
      const result = await window.electron.mcpServer.getTurnOutcomeRecords();
      setRecords(result);
    } catch (err) {
      logError("Failed to load turn outcome records", err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    let settled = false;
    const timer = setTimeout(() => {
      settled = true;
      setLoading(false);
      logError("Turn outcome records load timed out");
    }, 10_000);

    window.electron.mcpServer
      .getTurnOutcomeRecords()
      .then((result) => {
        if (settled) return;
        setRecords(result);
      })
      .catch((err) => {
        if (settled) return;
        logError("Failed to load turn outcome records", err);
      })
      .finally(() => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          setLoading(false);
        }
      });

    return () => {
      clearTimeout(timer);
    };
  }, []);

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
      if (!r.sessionId) continue;
      let tools = map.get(r.sessionId);
      if (!tools) {
        tools = new Set();
        map.set(r.sessionId, tools);
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
          <div className="rounded-[var(--radius-md)] border border-daintree-border bg-overlay-subtle/40">
            <button
              type="button"
              onClick={() => setOutcomeSectionOpen((v) => !v)}
              aria-expanded={outcomeSectionOpen}
              className={cn(
                "w-full flex items-center justify-between gap-3 px-3 py-2 text-xs",
                "text-daintree-text/80 hover:text-daintree-text transition-colors"
              )}
            >
              <span className="flex items-center gap-2">
                <ChevronRight
                  className={cn(
                    "w-3.5 h-3.5 transition-transform duration-150",
                    outcomeSectionOpen ? "rotate-90" : "rotate-0"
                  )}
                />
                Turn outcomes by class
                {totalRecords > 0 && (
                  <span className="text-daintree-text/50">({totalRecords} turns)</span>
                )}
              </span>
            </button>
            {outcomeSectionOpen && (
              <div className="px-3 pb-3 pt-1">
                {totalRecords === 0 ? (
                  <p className="text-xs text-daintree-text/50">
                    No turn outcome records yet. Turn outcomes are recorded when an agent completes
                    a turn in a help session.
                  </p>
                ) : (
                  <table className="w-full table-fixed text-xs font-mono tabular-nums">
                    <thead>
                      <tr className="text-daintree-text/50">
                        <th className="text-left font-medium py-1 pr-2">Outcome</th>
                        <th className="text-right font-medium py-1 pl-2 w-16">Count</th>
                        <th className="text-right font-medium py-1 pl-2 w-16">Rate</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-daintree-border">
                      {OUTCOME_ORDER.map((cls) => {
                        const count = outcomeCounts.get(cls) ?? 0;
                        const rate = totalRecords > 0 ? (count / totalRecords) * 100 : 0;
                        return (
                          <tr key={cls} className="text-daintree-text/80">
                            <td className="py-1 pr-2 truncate">{OUTCOME_LABEL[cls]}</td>
                            <td className="py-1 pl-2 text-right text-daintree-text/60">{count}</td>
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
          <div className="rounded-[var(--radius-md)] border border-daintree-border bg-overlay-subtle/40">
            <button
              type="button"
              onClick={() => setToolErrorOpen((v) => !v)}
              aria-expanded={toolErrorOpen}
              className={cn(
                "w-full flex items-center justify-between gap-3 px-3 py-2 text-xs",
                "text-daintree-text/80 hover:text-daintree-text transition-colors"
              )}
            >
              <span className="flex items-center gap-2">
                <ChevronRight
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
                  <p className="text-xs text-daintree-text/50">
                    No audit data available. Enable MCP audit logging to populate per-tool
                    diagnostics.
                  </p>
                ) : toolErrorRollups.length === 0 ? (
                  <p className="text-xs text-daintree-text/50">No tool-error outcomes recorded.</p>
                ) : (
                  <table className="w-full table-fixed text-xs font-mono tabular-nums">
                    <thead>
                      <tr className="text-daintree-text/50">
                        <th className="text-left font-medium py-1 pr-2">Tool</th>
                        <th className="text-right font-medium py-1 px-2 w-16">Errors</th>
                        <th className="text-right font-medium py-1 px-2 w-16">Turns</th>
                        <th className="text-right font-medium py-1 px-2 w-16">Rate</th>
                        <th className="text-right font-medium py-1 pl-2 w-40">Action</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-daintree-border">
                      {toolErrorRollups.map((row) => (
                        <tr key={row.toolId} className="text-daintree-text/80">
                          <td className="py-1 pr-2 truncate">{row.toolId}</td>
                          <td className="py-1 px-2 text-right text-daintree-text/60">
                            {row.count}
                          </td>
                          <td className="py-1 px-2 text-right text-daintree-text/60">
                            {row.total}
                          </td>
                          <td className={cn("py-1 px-2 text-right", rateColor(row.rate))}>
                            {row.rate.toFixed(1)}%
                          </td>
                          <td className="py-1 pl-2 text-right text-daintree-text/50">
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
          <div className="rounded-[var(--radius-md)] border border-daintree-border bg-overlay-subtle/40">
            <button
              type="button"
              onClick={() => setTierRejectedOpen((v) => !v)}
              aria-expanded={tierRejectedOpen}
              className={cn(
                "w-full flex items-center justify-between gap-3 px-3 py-2 text-xs",
                "text-daintree-text/80 hover:text-daintree-text transition-colors"
              )}
            >
              <span className="flex items-center gap-2">
                <ChevronRight
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
                  <p className="text-xs text-daintree-text/50">
                    No audit data available. Enable MCP audit logging to populate per-tool
                    diagnostics.
                  </p>
                ) : tierRejectedRollups.length === 0 ? (
                  <p className="text-xs text-daintree-text/50">
                    No tier-rejected outcomes recorded.
                  </p>
                ) : (
                  <table className="w-full table-fixed text-xs font-mono tabular-nums">
                    <thead>
                      <tr className="text-daintree-text/50">
                        <th className="text-left font-medium py-1 pr-2">Tool</th>
                        <th className="text-right font-medium py-1 px-2 w-16">Rejected</th>
                        <th className="text-right font-medium py-1 px-2 w-16">Turns</th>
                        <th className="text-right font-medium py-1 px-2 w-16">Rate</th>
                        <th className="text-right font-medium py-1 pl-2 w-40">Action</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-daintree-border">
                      {tierRejectedRollups.map((row) => (
                        <tr key={row.toolId} className="text-daintree-text/80">
                          <td className="py-1 pr-2 truncate">{row.toolId}</td>
                          <td className="py-1 px-2 text-right text-daintree-text/60">
                            {row.count}
                          </td>
                          <td className="py-1 px-2 text-right text-daintree-text/60">
                            {row.total}
                          </td>
                          <td className={cn("py-1 px-2 text-right", rateColor(row.rate))}>
                            {row.rate.toFixed(1)}%
                          </td>
                          <td className="py-1 pl-2 text-right text-daintree-text/50">
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
          <div className="rounded-[var(--radius-md)] border border-daintree-border bg-overlay-subtle/40">
            <button
              type="button"
              onClick={() => setAgentStuckOpen((v) => !v)}
              aria-expanded={agentStuckOpen}
              className={cn(
                "w-full flex items-center justify-between gap-3 px-3 py-2 text-xs",
                "text-daintree-text/80 hover:text-daintree-text transition-colors"
              )}
            >
              <span className="flex items-center gap-2">
                <ChevronRight
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
                  <p className="text-xs text-daintree-text/50">
                    No audit data available. Enable MCP audit logging to populate per-tool
                    diagnostics.
                  </p>
                ) : agentStuckRollups.length === 0 ? (
                  <p className="text-xs text-daintree-text/50">No agent-stuck outcomes recorded.</p>
                ) : (
                  <table className="w-full table-fixed text-xs font-mono tabular-nums">
                    <thead>
                      <tr className="text-daintree-text/50">
                        <th className="text-left font-medium py-1 pr-2">Tool</th>
                        <th className="text-right font-medium py-1 px-2 w-16">Stuck</th>
                        <th className="text-right font-medium py-1 px-2 w-16">Turns</th>
                        <th className="text-right font-medium py-1 px-2 w-16">Rate</th>
                        <th className="text-right font-medium py-1 pl-2 w-40">Action</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-daintree-border">
                      {agentStuckRollups.map((row) => (
                        <tr key={row.toolId} className="text-daintree-text/80">
                          <td className="py-1 pr-2 truncate">{row.toolId}</td>
                          <td className="py-1 px-2 text-right text-daintree-text/60">
                            {row.count}
                          </td>
                          <td className="py-1 px-2 text-right text-daintree-text/60">
                            {row.total}
                          </td>
                          <td className={cn("py-1 px-2 text-right", rateColor(row.rate))}>
                            {row.rate.toFixed(1)}%
                          </td>
                          <td className="py-1 pl-2 text-right text-daintree-text/50">
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
              onClick={() => void fetchRecords()}
              disabled={loading}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-[var(--radius-md)] border border-daintree-border text-daintree-text/70 hover:text-daintree-text hover:bg-overlay-soft transition-colors"
            >
              <RefreshCw className="w-3.5 h-3.5" />
              Refresh
            </button>
            <button
              type="button"
              onClick={async () => {
                try {
                  await window.electron.mcpServer.clearTurnOutcomeLog();
                  setRecords([]);
                } catch (err) {
                  logError("Failed to clear turn outcome log", err);
                }
              }}
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
            <span className="ml-auto text-xs text-daintree-text/40">
              {totalRecords} turn{totalRecords !== 1 ? "s" : ""}
            </span>
          </div>
        </>
      )}
    </div>
  );
}
