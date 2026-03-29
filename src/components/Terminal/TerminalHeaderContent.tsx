import React, { useState, useEffect, useCallback } from "react";
import { Pause, Lock } from "lucide-react";
import type { TerminalType, AgentState, PanelKind, AgentStateChangeTrigger } from "@/types";
import { cn } from "@/lib/utils";
import { Tooltip, TooltipContent, TooltipTrigger, TooltipProvider } from "@/components/ui/tooltip";
import {
  getEffectiveStateIcon,
  getEffectiveStateColor,
  getEffectiveStateLabel,
} from "@/components/Worktree/terminalStateConfig";
import type { ActivityState } from "./TerminalPane";
import { useTerminalStore } from "@/store";
import { useShallow } from "zustand/react/shallow";
import { formatElapsedDuration } from "@/utils/formatElapsedDuration";
import { formatTokenCount } from "@/utils/formatTokenCount";
import { formatTimeAgo } from "@/utils/timeAgo";
import { useResourceMonitoringStore } from "@/store/resourceMonitoringStore";
import { useErrorStore } from "@/store/errorStore";
import { TerminalResourceSparkline } from "./TerminalResourceSparkline";
import { panelKindHasPty } from "@shared/config/panelKindRegistry";

function ElapsedTime({ startedAt }: { startedAt: number }) {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(id);
  }, []);

  return <> · {formatElapsedDuration(now - startedAt)}</>;
}

const TRIGGER_LABELS: Record<AgentStateChangeTrigger, string> = {
  input: "Input",
  output: "Output",
  heuristic: "Heuristic",
  "ai-classification": "AI classification",
  timeout: "Timeout",
  exit: "Exit",
  activity: "Activity",
  title: "Title",
};

export interface TerminalHeaderContentProps {
  id: string;
  kind?: PanelKind;
  type?: TerminalType;
  agentState?: AgentState;
  activity?: ActivityState | null;
  lastCommand?: string;
  isExited?: boolean;
  exitCode?: number | null;
  queueCount?: number;
  flowStatus?: "running" | "paused-backpressure" | "paused-user" | "suspended";
}

function formatMemory(kb: number): string {
  if (kb >= 1048576) return `${(kb / 1048576).toFixed(1)}G`;
  if (kb >= 1024) return `${Math.round(kb / 1024)}M`;
  return `${kb}K`;
}

function getResourceSeverity(cpuPercent: number, memoryKb: number): "muted" | "amber" | "red" {
  if (cpuPercent >= 80 || memoryKb >= 2097152) return "red";
  if (cpuPercent >= 50 || memoryKb >= 1048576) return "amber";
  return "muted";
}

function TerminalHeaderContentComponent({
  id,
  kind,
  type,
  agentState,
  activity,
  lastCommand,
  isExited = false,
  exitCode = null,
  queueCount = 0,
  flowStatus,
}: TerminalHeaderContentProps) {
  const resourceEnabled = useResourceMonitoringStore((s) => s.enabled);
  const resourceState = useResourceMonitoringStore((s) => s.metrics.get(id));
  const isPtyPanel = kind == null || panelKindHasPty(kind);
  const showResource = resourceEnabled && isPtyPanel && resourceState != null;

  const {
    isInputLocked,
    startedAt,
    lastStateChange,
    stateChangeTrigger,
    stateChangeConfidence,
    waitingReason,
    sessionCost,
    sessionTokens,
  } = useTerminalStore(
    useShallow((state) => {
      const t = state.terminals.find((t) => t.id === id);
      return {
        isInputLocked: t?.isInputLocked ?? false,
        startedAt: t?.startedAt,
        lastStateChange: t?.lastStateChange,
        stateChangeTrigger: t?.stateChangeTrigger,
        stateChangeConfidence: t?.stateChangeConfidence,
        waitingReason: t?.waitingReason,
        sessionCost: t?.sessionCost,
        sessionTokens: t?.sessionTokens,
      };
    })
  );

  const errorCount = useErrorStore(
    useCallback(
      (s) => s.errors.filter((e) => e.context?.terminalId === id && !e.dismissed).length,
      [id]
    )
  );

  const [tick, setTick] = useState(() => Date.now());
  useEffect(() => {
    const interval = setInterval(() => setTick(Date.now()), 30_000);
    return () => clearInterval(interval);
  }, []);

  const STALL_THRESHOLD_MS = 60_000;
  const isStalled =
    agentState === "working" &&
    lastStateChange != null &&
    lastStateChange > 0 &&
    tick - lastStateChange > STALL_THRESHOLD_MS;

  const showStateDuration =
    (agentState === "working" || agentState === "waiting" || agentState === "directing") &&
    lastStateChange != null &&
    lastStateChange > 0 &&
    tick - lastStateChange > 10_000;

  // Show command pill only for plain terminals (not agent terminals)
  // Use kind to distinguish - agent panels have kind="agent"
  const isPlainTerminal = kind === "terminal" || (!kind && type === "terminal");
  const showCommandPill = isPlainTerminal && agentState === "running" && !!lastCommand;

  const renderAgentStateChip = () => {
    if (!agentState || agentState === "idle") {
      return null;
    }

    // Show completed chip only when there's a cost to display
    if (agentState === "completed" && sessionCost == null) {
      return null;
    }

    const StateIcon = getEffectiveStateIcon(agentState, waitingReason);
    if (!StateIcon) return null;

    const effectiveColor = getEffectiveStateColor(agentState, waitingReason);

    const chipStyle = isStalled
      ? "bg-[color-mix(in_oklab,var(--color-status-warning)_15%,transparent)] border-status-warning/40"
      : agentState === "working"
        ? "bg-[color-mix(in_oklab,var(--color-state-working)_15%,transparent)] border-state-working/40"
        : agentState === "directing"
          ? "bg-[color-mix(in_oklab,var(--color-category-blue)_15%,transparent)] border-category-blue/40"
          : agentState === "running"
            ? "bg-[color-mix(in_oklab,var(--color-status-info)_15%,transparent)] border-status-info/40"
            : agentState === "completed"
              ? "bg-[color-mix(in_oklab,var(--color-status-success)_15%,transparent)] border-status-success/40"
              : agentState === "waiting" && waitingReason === "prompt"
                ? "bg-[color-mix(in_oklab,var(--color-status-warning)_15%,transparent)] border-status-warning/40"
                : "bg-[color-mix(in_oklab,var(--color-state-waiting)_15%,transparent)] border-state-waiting/40";

    const headline = activity?.headline?.trim() || `Agent ${agentState}`;
    const showConfidence = stateChangeConfidence != null && stateChangeConfidence < 1;
    const stateLabel = getEffectiveStateLabel(agentState, waitingReason);

    return (
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger asChild>
            <div className="inline-flex items-center gap-1.5 shrink-0">
              <div className="relative inline-flex items-center shrink-0">
                <div
                  className={cn(
                    "inline-flex items-center justify-center w-5 h-5 rounded-full border shrink-0",
                    chipStyle,
                    isStalled
                      ? "text-status-warning animate-pulse motion-reduce:animate-none"
                      : effectiveColor
                  )}
                  role="status"
                  aria-label={`Agent state: ${isStalled ? "stalled" : stateLabel}`}
                >
                  <StateIcon
                    className={cn(
                      "w-3 h-3",
                      agentState === "working" && !isStalled && "animate-spin-slow",
                      "motion-reduce:animate-none"
                    )}
                    aria-hidden="true"
                  />
                </div>
                {errorCount > 0 && (
                  <span
                    className="absolute -top-0.5 -right-0.5 w-2 h-2 rounded-full bg-status-error"
                    aria-label={`${errorCount} error${errorCount > 1 ? "s" : ""}`}
                  />
                )}
              </div>
              {agentState === "completed" && sessionCost != null && (
                <span
                  className="text-[11px] text-canopy-text/50 font-mono shrink-0"
                  style={{ fontVariantNumeric: "tabular-nums" }}
                >
                  ${sessionCost.toFixed(2)}
                  {sessionTokens != null && ` · ${formatTokenCount(sessionTokens)}`}
                </span>
              )}
            </div>
          </TooltipTrigger>
          <TooltipContent side="bottom" className="max-w-xs">
            <div className="flex flex-col gap-0.5">
              <span className="font-medium">
                {headline}
                {startedAt != null && <ElapsedTime startedAt={startedAt} />}
              </span>
              {isExited && exitCode != null && (
                <span className="text-status-error tabular-nums">Exit code: {exitCode}</span>
              )}
              <span>
                State: {isStalled ? "stalled" : stateLabel}
                {showStateDuration && <> · {formatElapsedDuration(tick - lastStateChange!)}</>}
                {stateChangeTrigger && <> · {TRIGGER_LABELS[stateChangeTrigger]}</>}
                {showConfidence && <> ({Math.round(stateChangeConfidence * 100)}%)</>}
              </span>
              {lastStateChange != null && lastStateChange > 0 && (
                <span className="text-canopy-text/60">Since: {formatTimeAgo(lastStateChange)}</span>
              )}
              {sessionCost != null && (
                <span className="text-canopy-text/60 tabular-nums">
                  Cost: ${sessionCost.toFixed(2)}
                </span>
              )}
              {errorCount > 0 && (
                <span className="text-status-error">
                  {errorCount} error{errorCount > 1 ? "s" : ""}
                </span>
              )}
            </div>
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
    );
  };

  return (
    <>
      {/* Command Pill - shows currently running command (inline with title) */}
      {showCommandPill && (
        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="px-3 py-1 rounded-full text-[11px] font-mono bg-overlay-soft text-canopy-text/60 border border-divider truncate max-w-[20rem]">
                {lastCommand}
              </span>
            </TooltipTrigger>
            <TooltipContent side="bottom">{lastCommand}</TooltipContent>
          </Tooltip>
        </TooltipProvider>
      )}

      {/* Exit code badge */}
      {isExited && (
        <span className="text-xs font-mono text-status-error ml-1" role="status" aria-live="polite">
          [exit {exitCode}]
        </span>
      )}

      {/* Queue count badge */}
      {queueCount > 0 && (
        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger asChild>
              <div
                className="inline-flex items-center gap-1 text-xs font-sans bg-canopy-accent/15 text-canopy-text px-1.5 py-0.5 rounded ml-1"
                role="status"
                aria-live="polite"
              >
                <span className="font-mono tabular-nums">{queueCount}</span>
                <span>queued</span>
              </div>
            </TooltipTrigger>
            <TooltipContent side="bottom">
              {`${queueCount} command${queueCount > 1 ? "s" : ""} queued`}
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
      )}

      {/* Paused badge */}
      {flowStatus === "paused-backpressure" && (
        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger asChild>
              <div
                className="flex items-center gap-1 text-xs font-sans bg-status-warning/15 text-status-warning px-1.5 py-0.5 rounded ml-1"
                role="status"
                aria-live="polite"
              >
                <Pause className="w-3 h-3" aria-hidden="true" />
                Paused
              </div>
            </TooltipTrigger>
            <TooltipContent side="bottom">
              Terminal paused due to buffer overflow (right-click for Force Resume)
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
      )}

      {/* Suspended badge */}
      {flowStatus === "suspended" && (
        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger asChild>
              <div
                className="flex items-center gap-1 text-xs font-sans bg-status-warning/15 text-status-warning px-1.5 py-0.5 rounded ml-1"
                role="status"
                aria-live="polite"
              >
                <Pause className="w-3 h-3" aria-hidden="true" />
                Suspended
              </div>
            </TooltipTrigger>
            <TooltipContent side="bottom">
              Terminal output streaming suspended due to a stall (auto-recovers on focus)
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
      )}

      {/* Input locked indicator */}
      {isInputLocked && (
        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger asChild>
              <div className="flex items-center text-canopy-text/50 shrink-0" role="status">
                <Lock className="w-3.5 h-3.5" aria-hidden="true" />
              </div>
            </TooltipTrigger>
            <TooltipContent side="bottom">Input locked (read-only monitor mode)</TooltipContent>
          </Tooltip>
        </TooltipProvider>
      )}

      {/* Resource monitoring badge */}
      {showResource && (
        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger asChild>
              <div
                className={cn(
                  "inline-flex items-center gap-1 text-[11px] font-mono shrink-0 ml-1",
                  {
                    "text-canopy-text/40":
                      getResourceSeverity(resourceState.cpuPercent, resourceState.memoryKb) ===
                      "muted",
                    "text-status-warning":
                      getResourceSeverity(resourceState.cpuPercent, resourceState.memoryKb) ===
                      "amber",
                    "text-status-error":
                      getResourceSeverity(resourceState.cpuPercent, resourceState.memoryKb) ===
                      "red",
                  }
                )}
                style={{ fontVariantNumeric: "tabular-nums" }}
                role="status"
              >
                <TerminalResourceSparkline history={resourceState.cpuHistory} />
                <span>
                  {Math.round(resourceState.cpuPercent)}% · {formatMemory(resourceState.memoryKb)}
                </span>
              </div>
            </TooltipTrigger>
            <TooltipContent side="bottom" className="max-w-xs">
              <div className="flex flex-col gap-1">
                <div className="font-medium" style={{ fontVariantNumeric: "tabular-nums" }}>
                  CPU: {resourceState.cpuPercent.toFixed(1)}% · Memory:{" "}
                  {formatMemory(resourceState.memoryKb)}
                </div>
                {resourceState.breakdown.length > 0 && (
                  <table className="text-xs" style={{ fontVariantNumeric: "tabular-nums" }}>
                    <thead>
                      <tr className="text-canopy-text/60">
                        <th className="text-left pr-2">PID</th>
                        <th className="text-left pr-2">Name</th>
                        <th className="text-right pr-2">CPU</th>
                        <th className="text-right">Mem</th>
                      </tr>
                    </thead>
                    <tbody>
                      {resourceState.breakdown.map((p) => (
                        <tr key={p.pid}>
                          <td className="pr-2 text-canopy-text/60">{p.pid}</td>
                          <td className="pr-2 truncate max-w-[8rem]">{p.comm}</td>
                          <td className="text-right pr-2">{p.cpuPercent.toFixed(1)}%</td>
                          <td className="text-right">{formatMemory(p.memoryKb)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
      )}

      {/* Agent state chip */}
      {renderAgentStateChip()}
    </>
  );
}

export const TerminalHeaderContent = React.memo(TerminalHeaderContentComponent);
