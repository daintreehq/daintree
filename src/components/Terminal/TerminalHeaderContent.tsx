import React from "react";
import { Pause, Lock } from "lucide-react";
import type { TerminalType, AgentState, PanelKind } from "@/types";
import { cn } from "@/lib/utils";
import { Tooltip, TooltipContent, TooltipTrigger, TooltipProvider } from "@/components/ui/tooltip";
import { STATE_ICONS, STATE_COLORS } from "@/components/Worktree/terminalStateConfig";
import type { ActivityState } from "./TerminalPane";
import { useTerminalStore } from "@/store";

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
  const isInputLocked = useTerminalStore(
    (state) => state.terminals.find((t) => t.id === id)?.isInputLocked ?? false
  );

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
        ? "bg-[color-mix(in_oklab,var(--color-state-working)_15%,transparent)] border-[var(--color-state-working)]/40"
        : agentState === "waiting"
          ? "bg-[color-mix(in_oklab,var(--color-state-waiting)_15%,transparent)] border-[var(--color-state-waiting)]/40"
          : agentState === "running"
            ? "bg-[color-mix(in_oklab,var(--color-status-info)_15%,transparent)] border-[var(--color-status-info)]/40"
            : "bg-[color-mix(in_oklab,var(--color-status-error)_15%,transparent)] border-[var(--color-status-error)]/40";

    // Build tooltip - show activity headline or just the agent state
    const tooltip = activity?.headline?.trim() || `Agent ${agentState}`;

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
                  agentState === "working" && "animate-spin",
                  agentState === "waiting" && "animate-breathe",
                  "motion-reduce:animate-none"
                )}
                aria-hidden="true"
              />
            </div>
          </TooltipTrigger>
          <TooltipContent side="bottom">{tooltip}</TooltipContent>
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
              <span className="px-3 py-1 rounded-full text-[11px] font-mono bg-white/[0.03] text-canopy-text/60 border border-divider truncate max-w-[20rem]">
                {lastCommand}
              </span>
            </TooltipTrigger>
            <TooltipContent side="bottom">{lastCommand}</TooltipContent>
          </Tooltip>
        </TooltipProvider>
      )}

      {/* Exit code badge */}
      {isExited && (
        <span
          className="text-xs font-mono text-[var(--color-status-error)] ml-1"
          role="status"
          aria-live="polite"
        >
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
                className="flex items-center gap-1 text-xs font-sans bg-[var(--color-status-warning)]/15 text-[var(--color-status-warning)] px-1.5 py-0.5 rounded ml-1"
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
                className="flex items-center gap-1 text-xs font-sans bg-[var(--color-status-warning)]/15 text-[var(--color-status-warning)] px-1.5 py-0.5 rounded ml-1"
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
