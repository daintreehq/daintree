import { useCallback } from "react";
import type { AgentState, AgentStateChangeTrigger } from "@/types";
import { cn } from "@/lib/utils";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  PANE_SESSION_ICONS,
  PANE_SESSION_COLORS,
  PANE_SESSION_LABELS,
  SESSION_LABELS,
} from "@/components/Worktree/terminalStateConfig";
import {
  resolvePaneSessionPresentation,
  type PaneSessionPresentationState,
} from "@/lib/paneSessionPresentation";
import { useRunFleetBand } from "@/hooks/useRunFleetBand";
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
import { describeExitStatus } from "./exitStatus";
import { pluralize } from "@/lib/pluralize";

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

/**
 * The chip itself: the state's glyph on its own in a fixed 20px slot. Every
 * glyph is already a ring with its mark inside, so the chip draws no ring or
 * tint of its own — a ring around a ring read as a circle inside a circle.
 * Shared with the canopy panel's pane header, which draws a terminal the way
 * its own pane does without that pane's store entry.
 */
export function AgentStateChip({
  agentState,
  ariaLabel,
}: {
  agentState: PaneSessionPresentationState;
  ariaLabel: string;
}) {
  const StateIcon = PANE_SESSION_ICONS[agentState];
  if (!StateIcon) return null;
  // Finished is white here rather than the settled grey it wears in lists: the
  // title bar shows one agent, and its ring has no chip around it to carry it.
  const tone = agentState === "completed" ? "text-text-primary" : PANE_SESSION_COLORS[agentState];
  return (
    <div
      className={cn(
        "inline-flex items-center justify-center w-5 h-5 shrink-0",
        "transition-colors duration-150 ease-out reduce-motion:transition-none",
        tone
      )}
      role="status"
      aria-label={ariaLabel}
    >
      <StateIcon
        className={cn(
          "w-4 h-4",
          agentState === "working" && "animate-spin-slow",
          "motion-reduce:animate-none"
        )}
        aria-hidden="true"
      />
    </div>
  );
}

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
    rawAgentState,
    startedAt,
    lastStateChange,
    stateChangeTrigger,
    stateChangeConfidence,
    waitingReason,
    isRestarting,
    sessionCost,
  } = usePanelStore(
    useShallow((state) => {
      const t = state.panelsById[id];
      const pty = t && isPtyPanel(t) ? t : undefined;
      return {
        rawAgentState: pty?.agentState,
        startedAt: pty?.startedAt,
        lastStateChange: pty?.lastStateChange,
        stateChangeTrigger: pty?.stateChangeTrigger,
        stateChangeConfidence: pty?.stateChangeConfidence,
        waitingReason: pty?.waitingReason,
        isRestarting: pty?.isRestarting,
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

  const band = useRunFleetBand(id);

  if (!agentState || agentState === "idle") {
    return null;
  }

  // The glyph follows the run's fleet band; `agentState` stays the observation.
  const shownState = resolvePaneSessionPresentation(agentState, band, {
    agentState: rawAgentState,
    waitingReason,
    isRestarting,
  });
  const isReinterpreted = shownState !== agentState;

  // A settled agent only keeps its glyph while a session cost is on record;
  // without one the row's settled trace is the only mark. A live agent drawn
  // settled by its band keeps it.
  if (
    !isReinterpreted &&
    (agentState === "completed" || agentState === "exited") &&
    sessionCost == null
  ) {
    return null;
  }

  if (!shownState || !PANE_SESSION_ICONS[shownState]) return null;

  const showConfidence = stateChangeConfidence != null && stateChangeConfidence < 1;
  const stateLabel = PANE_SESSION_LABELS[shownState];
  const observedLabel = SESSION_LABELS[rawAgentState ?? agentState];
  const headline = activity?.headline?.trim() || `Agent ${stateLabel}`;
  const exitStatus = isExited ? describeExitStatus(exitCode) : null;
  const showStateDuration =
    (shownState === "working" ||
      shownState === "waiting" ||
      shownState === "blocked" ||
      shownState === "directing") &&
    lastStateChange != null &&
    lastStateChange > 0 &&
    now - lastStateChange > 10_000;
  // Specific reasons only — the classifier's `prompt` fallback stays a
  // plain "waiting" so the chip never overclaims.
  const chipWaitingReason =
    shownState === "waiting" || shownState === "blocked"
      ? actionableWaitingReason(waitingReason)
      : null;
  const chipAriaLabel = chipWaitingReason
    ? `Agent state: ${stateLabel} (${WAITING_REASON_BADGE_LABEL[chipWaitingReason].toLowerCase()})`
    : `Agent state: ${stateLabel}`;

  return (
    <Tooltip autoDismiss={false}>
      <TooltipTrigger asChild>
        <div className="relative inline-flex items-center shrink-0">
          <AgentStateChip agentState={shownState} ariaLabel={chipAriaLabel} />
          {errorCount > 0 && (
            <span
              className="status-mark absolute -top-0.5 -right-0.5 w-2 h-2 rounded-full bg-status-error"
              aria-label={pluralize(errorCount, "error")}
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
          {exitStatus && (
            <span
              className={cn(
                "tabular-nums",
                exitStatus.failed ? "text-status-error" : "text-text-secondary"
              )}
            >
              {exitStatus.detail}
            </span>
          )}
          <span>
            State: {stateLabel}
            {chipWaitingReason && (
              <> ({WAITING_REASON_BADGE_LABEL[chipWaitingReason].toLowerCase()})</>
            )}
            {showStateDuration && (
              <span className="animate-in fade-in [--tw-animation-duration:var(--duration-150)]">
                {" · "}
                {formatElapsedDuration(now - lastStateChange!)}
              </span>
            )}
            {stateChangeTrigger && <> · {TRIGGER_LABELS[stateChangeTrigger]}</>}
            {showConfidence && <> ({Math.round(stateChangeConfidence * 100)}%)</>}
          </span>
          {isReinterpreted && (
            <span className="text-text-secondary">Observed: {observedLabel}</span>
          )}
          {lastStateChange != null && lastStateChange > 0 && (
            <span className="text-text-secondary">Since: {formatTimeAgo(lastStateChange)}</span>
          )}
          {/* No cost line: the settled trace chip in the header row is the one
              place a session's cost and tokens are disclosed, in full. */}
          {errorCount > 0 && (
            <span className="text-status-error">{pluralize(errorCount, "error")}</span>
          )}
        </div>
      </TooltipContent>
    </Tooltip>
  );
}
