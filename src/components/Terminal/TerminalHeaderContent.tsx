import React, { useState, useEffect } from "react";
import { Pause, Lock } from "lucide-react";
import type { TerminalType, AgentState, PanelKind, AgentStateChangeTrigger } from "@/types";
import { cn } from "@/lib/utils";
import { Tooltip, TooltipContent, TooltipTrigger, TooltipProvider } from "@/components/ui/tooltip";
import { STATE_ICONS, STATE_COLORS } from "@/components/Worktree/terminalStateConfig";
import type { ActivityState } from "./TerminalPane";
import { useTerminalStore } from "@/store";
import { formatElapsedDuration } from "@/utils/formatElapsedDuration";
import { formatTimeAgo } from "@/utils/timeAgo";

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
  const { isInputLocked, startedAt, lastStateChange, stateChangeTrigger, stateChangeConfidence } =
    useTerminalStore((state) => {
      const t = state.terminals.find((t) => t.id === id);
      return {
        isInputLocked: t?.isInputLocked ?? false,
        startedAt: t?.startedAt,
        lastStateChange: t?.lastStateChange,
        stateChangeTrigger: t?.stateChangeTrigger,
        stateChangeConfidence: t?.stateChangeConfidence,
      };
    });

  // Show command pill only for plain terminals (not agent terminals)
  // Use kind to distinguish - agent panels have kind="agent"
  const isPlainTerminal = kind === "terminal" || (!kind && type === "terminal");
  const showCommandPill = isPlainTerminal && agentState === "running" && !!lastCommand;

  const renderAgentStateChip = () => {
    if (!agentState || agentState === "idle" || agentState === "completed") {
      return null;
    }

    const StateIcon = STATE_ICONS[agentState];
    if (!StateIcon) return null;

    const chipStyle =
      agentState === "working"
        ? "bg-[color-mix(in_oklab,var(--color-state-working)_15%,transparent)] border-state-working/40"
        : agentState === "waiting"
          ? "bg-[color-mix(in_oklab,var(--color-state-waiting)_15%,transparent)] border-state-waiting/40"
          : agentState === "directing"
            ? "bg-[color-mix(in_oklab,var(--color-category-blue)_15%,transparent)] border-category-blue/40"
            : agentState === "running"
              ? "bg-[color-mix(in_oklab,var(--color-status-info)_15%,transparent)] border-status-info/40"
              : "bg-[color-mix(in_oklab,var(--color-status-error)_15%,transparent)] border-status-error/40";

    const headline = activity?.headline?.trim() || `Agent ${agentState}`;
    const showConfidence = stateChangeConfidence != null && stateChangeConfidence < 1;

    return (
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger asChild>
            <div
              className={cn(
                "inline-flex items-center justify-center w-5 h-5 rounded-full border shrink-0",
                chipStyle,
                STATE_COLORS[agentState]
              )}
              role="status"
              aria-label={`Agent state: ${agentState}`}
            >
              <StateIcon
                className={cn(
                  "w-3 h-3",
                  agentState === "working" && "animate-spin-slow",
                  "motion-reduce:animate-none"
                )}
                aria-hidden="true"
              />
            </div>
          </TooltipTrigger>
          <TooltipContent side="bottom" className="max-w-xs">
            <div className="flex flex-col gap-0.5">
              <span className="font-medium">
                {headline}
                {startedAt != null && <ElapsedTime startedAt={startedAt} />}
              </span>
              {isExited && exitCode != null && (
                <span className="text-status-error">Exit code: {exitCode}</span>
              )}
              <span>
                State: {agentState}
                {stateChangeTrigger && <> · {TRIGGER_LABELS[stateChangeTrigger]}</>}
                {showConfidence && <> ({Math.round(stateChangeConfidence * 100)}%)</>}
              </span>
              {lastStateChange != null && lastStateChange > 0 && (
                <span className="text-canopy-text/60">Since: {formatTimeAgo(lastStateChange)}</span>
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

      {/* Agent state chip */}
      {renderAgentStateChip()}
    </>
  );
}

export const TerminalHeaderContent = React.memo(TerminalHeaderContentComponent);
