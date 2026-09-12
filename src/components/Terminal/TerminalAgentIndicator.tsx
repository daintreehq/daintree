import { useCallback } from "react";
import type { AgentState, AgentStateChangeTrigger } from "@/types";
import { cn } from "@/lib/utils";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  getEffectiveStateIcon,
  getEffectiveStateColor,
  getEffectiveStateLabel,
} from "@/components/Worktree/terminalStateConfig";
import type { ActivityState } from "./TerminalPane";
import { usePanelStore } from "@/store";
import { isPtyPanel } from "@shared/types/panel";
import {
  actionableWaitingReason,
  WAITING_REASON_BADGE_LABEL,
} from "@shared/utils/waitingReasonDisplay";
import { useShallow } from "zustand/react/shallow";
import { useErrorStore } from "@/store/errorStore";
import { useGlobalMinuteTicker } from "@/hooks/useGlobalMinuteTicker";
import { formatElapsedDuration } from "@/utils/formatElapsedDuration";
import { formatTimeAgo } from "@/utils/timeAgo";

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

export interface TerminalAgentIndicatorProps {
  id: string;
  agentState?: AgentState;
  activity?: ActivityState | null;
  isExited?: boolean;
  exitCode?: number | null;
}

/**
 * The agent state glyph: one fixed-size circle with the explanation in its
 * tooltip. `PanelHeader` renders it past the close button in a reserved box that
 * never moves. Everything variable-width — cost, badges, telemetry — lives in
 * `TerminalHeaderContent` after the title instead (#12374).
 */
export function TerminalAgentIndicator({
  id,
  agentState,
  activity,
  isExited = false,
  exitCode = null,
}: TerminalAgentIndicatorProps) {
  const {
    startedAt,
    lastStateChange,
    stateChangeTrigger,
    stateChangeConfidence,
    waitingReason,
    sessionCost,
  } = usePanelStore(
    useShallow((state) => {
      const t = state.panelsById[id];
      const pty = t && isPtyPanel(t) ? t : undefined;
      return {
        startedAt: pty?.startedAt,
        lastStateChange: pty?.lastStateChange,
        stateChangeTrigger: pty?.stateChangeTrigger,
        stateChangeConfidence: pty?.stateChangeConfidence,
        waitingReason: pty?.waitingReason,
        sessionCost: pty?.sessionCost,
      };
    })
  );

  const errorCount = useErrorStore(
    useCallback(
      (s) => s.errors.filter((e) => e.context?.terminalId === id && !e.dismissed).length,
      [id]
    )
  );

  // Shared visibility-aware ticker — drives the elapsed-duration displays
  // that update at minute granularity. The tick value itself is unused;
  // its identity changes ~every 30 s, which is what re-derives `now`.
  useGlobalMinuteTicker();
  const now = Date.now();

  if (!agentState || agentState === "idle") {
    return null;
  }

  // A settled agent only keeps its glyph while there is a session cost to
  // explain in the tooltip; without one the row's "Finished, no changes" pill
  // is the only trace.
  if ((agentState === "completed" || agentState === "exited") && sessionCost == null) {
    return null;
  }

  const StateIcon = getEffectiveStateIcon(agentState);
  if (!StateIcon) return null;

  const effectiveColor = getEffectiveStateColor(agentState);

  const chipStyle =
    agentState === "working"
      ? "bg-[color-mix(in_oklab,var(--color-state-working)_15%,transparent)] border-state-working/40"
      : agentState === "directing"
        ? "bg-[color-mix(in_oklab,var(--color-category-blue)_15%,transparent)] border-category-blue/40"
        : // Settled: finished and exited share one neutral chip. Completion is
          // not asking for anything, so it does not get a hue of its own
          // (#12002) — and the two stay apart on the channels that survive
          // without one, `CheckCircle2` against `ExitedCircle` in slate
          // against secondary.
          agentState === "completed" || agentState === "exited"
          ? "bg-overlay-soft border-divider"
          : "bg-[color-mix(in_oklab,var(--color-state-waiting)_15%,transparent)] border-state-waiting/40";

  const headline = activity?.headline?.trim() || `Agent ${agentState}`;
  const showConfidence = stateChangeConfidence != null && stateChangeConfidence < 1;
  const stateLabel = getEffectiveStateLabel(agentState);
  const showStateDuration =
    (agentState === "working" || agentState === "waiting" || agentState === "directing") &&
    lastStateChange != null &&
    lastStateChange > 0 &&
    now - lastStateChange > 10_000;
  // Specific reasons only — the classifier's `prompt` fallback stays a
  // plain "waiting" so the chip never overclaims.
  const chipWaitingReason =
    agentState === "waiting" ? actionableWaitingReason(waitingReason) : null;
  const chipAriaLabel = chipWaitingReason
    ? `Agent state: ${stateLabel} (${WAITING_REASON_BADGE_LABEL[chipWaitingReason].toLowerCase()})`
    : `Agent state: ${stateLabel}`;

  return (
    <Tooltip autoDismiss={false}>
      <TooltipTrigger asChild>
        <div className="relative inline-flex items-center shrink-0">
          <div
            className={cn(
              "inline-flex items-center justify-center w-5 h-5 rounded-full border shrink-0",
              chipStyle,
              effectiveColor
            )}
            role="status"
            aria-label={chipAriaLabel}
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
          {errorCount > 0 && (
            <span
              className="status-mark absolute -top-0.5 -right-0.5 w-2 h-2 rounded-full bg-status-error"
              aria-label={`${errorCount} error${errorCount > 1 ? "s" : ""}`}
            />
          )}
        </div>
      </TooltipTrigger>
      <TooltipContent side="bottom" className="max-w-xs">
        <div className="flex flex-col gap-0.5">
          <span className="font-medium">
            {headline}
            {startedAt != null && <> · {formatElapsedDuration(now - startedAt)}</>}
          </span>
          {isExited && exitCode != null && (
            <span className="text-status-error tabular-nums">Exit code: {exitCode}</span>
          )}
          <span>
            State: {stateLabel}
            {chipWaitingReason && (
              <> ({WAITING_REASON_BADGE_LABEL[chipWaitingReason].toLowerCase()})</>
            )}
            {showStateDuration && (
              <span className="motion-safe:animate-in motion-safe:fade-in motion-safe:duration-150">
                {" · "}
                {formatElapsedDuration(now - lastStateChange!)}
              </span>
            )}
            {stateChangeTrigger && <> · {TRIGGER_LABELS[stateChangeTrigger]}</>}
            {showConfidence && <> ({Math.round(stateChangeConfidence * 100)}%)</>}
          </span>
          {lastStateChange != null && lastStateChange > 0 && (
            <span className="text-text-secondary">Since: {formatTimeAgo(lastStateChange)}</span>
          )}
          {sessionCost != null && (
            <span className="text-text-secondary tabular-nums">
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
  );
}
