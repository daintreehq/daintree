import React from "react";
import { Pause, Lock } from "lucide-react";
import type { TerminalType, AgentState, PanelKind, AgentStateChangeTrigger } from "@/types";
import { cn } from "@/lib/utils";
import { STATE_ICONS, STATE_COLORS } from "@/components/Worktree/terminalStateConfig";
import type { ActivityState } from "./TerminalPane";
import { useTerminalStore } from "@/store";

/**
 * Format agent state change trigger into user-friendly text.
 * Uses semantic, non-technical language.
 */
function formatStateTransitionReason(trigger: AgentStateChangeTrigger): string {
  switch (trigger) {
    case "input":
      return "user input submitted";
    case "output":
      return "new output appeared";
    case "heuristic":
      return "recognized a known pattern";
    case "ai-classification":
      return "AI inferred the state";
    case "timeout":
      return "no activity for a while";
    case "exit":
      return "process exited";
    case "activity":
      return "activity detected";
    default:
      return "state change";
  }
}

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
  stateChangeTrigger?: AgentStateChangeTrigger;
  stateChangeConfidence?: number;
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
  stateChangeTrigger,
  stateChangeConfidence,
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

    // Build detailed tooltip - use single line with separators for browser compatibility
    const tooltipParts: string[] = [];

    // Primary content: activity headline or fallback to agent state
    if (activity?.headline) {
      tooltipParts.push(activity.headline);
    } else {
      tooltipParts.push(`Agent ${agentState}`);
    }

    // Add transition reason if available
    if (stateChangeTrigger) {
      const reason = formatStateTransitionReason(stateChangeTrigger);
      tooltipParts.push(`Transitioned to ${agentState}: ${reason}`);
    }

    // Show confidence warning for low-confidence detections (independent of trigger)
    if (stateChangeConfidence !== undefined && stateChangeConfidence < 0.7) {
      const confidencePct = Math.floor(stateChangeConfidence * 100);
      tooltipParts.push(`(confidence: ${confidencePct}%)`);
    }

    const tooltip = tooltipParts.join(" • ");

    return (
      <div
        className={cn(
          "inline-flex items-center justify-center w-5 h-5 rounded-full border shrink-0",
          chipStyle,
          STATE_COLORS[agentState]
        )}
        title={tooltip}
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
    );
  };

  return (
    <>
      {/* Command Pill - shows currently running command (inline with title) */}
      {showCommandPill && (
        <span
          className="px-3 py-1 rounded-full text-[11px] font-mono bg-white/[0.03] text-canopy-text/60 border border-divider truncate max-w-[20rem]"
          title={lastCommand}
        >
          {lastCommand}
        </span>
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
        <div
          className="inline-flex items-center gap-1 text-xs font-sans bg-canopy-accent/15 text-canopy-text px-1.5 py-0.5 rounded ml-1"
          role="status"
          aria-live="polite"
          title={`${queueCount} command${queueCount > 1 ? "s" : ""} queued`}
        >
          <span className="font-mono tabular-nums">{queueCount}</span>
          <span>queued</span>
        </div>
      )}

      {/* Paused badge */}
      {flowStatus === "paused-backpressure" && (
        <div
          className="flex items-center gap-1 text-xs font-sans bg-[var(--color-status-warning)]/15 text-[var(--color-status-warning)] px-1.5 py-0.5 rounded ml-1"
          role="status"
          aria-live="polite"
          title="Terminal paused due to buffer overflow (right-click for Force Resume)"
        >
          <Pause className="w-3 h-3" aria-hidden="true" />
          Paused
        </div>
      )}

      {/* Suspended badge */}
      {flowStatus === "suspended" && (
        <div
          className="flex items-center gap-1 text-xs font-sans bg-[var(--color-status-warning)]/15 text-[var(--color-status-warning)] px-1.5 py-0.5 rounded ml-1"
          role="status"
          aria-live="polite"
          title="Terminal output streaming suspended due to a stall (auto-recovers on focus)"
        >
          <Pause className="w-3 h-3" aria-hidden="true" />
          Suspended
        </div>
      )}

      {/* Input locked indicator */}
      {isInputLocked && (
        <div
          className="flex items-center text-canopy-text/50 shrink-0"
          role="status"
          title="Input locked (read-only monitor mode)"
        >
          <Lock className="w-3.5 h-3.5" aria-hidden="true" />
        </div>
      )}

      {/* Agent state chip */}
      {renderAgentStateChip()}
    </>
  );
}

export const TerminalHeaderContent = React.memo(TerminalHeaderContentComponent);
