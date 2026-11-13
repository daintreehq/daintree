import { useCallback } from "react";
import type { AgentState, AgentStateChangeTrigger } from "@/types";
import { cn } from "@/lib/utils";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  SESSION_ICONS,
  SESSION_COLORS,
  SESSION_LABELS,
} from "@/components/Worktree/terminalStateConfig";
import {
  resolvePaneSessionPresentation,
  type SessionPresentationState,
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
import { FactSeparator } from "@/components/ui/FactSeparator";
import { SEVERITY_VISUAL } from "@/lib/statusSeverity";

const ErrorMark = SEVERITY_VISUAL.error.Icon;

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
 *
 * `neutral` draws the glyph in the settled grey instead of its state's hue: a
 * wait the pane header keeps on show although nothing in it is news.
 */
export function AgentStateChip({
  agentState,
  ariaLabel,
  neutral = false,
}: {
  agentState: SessionPresentationState;
  ariaLabel: string;
  neutral?: boolean;
}) {
  const StateIcon = SESSION_ICONS[agentState];
  if (!StateIcon) return null;
  // Finished is white here rather than the settled grey it wears in lists: the
  // title bar shows one agent, and its ring has no chip around it to carry it.
  const tone = neutral
    ? "text-text-secondary"
    : agentState === "completed"
      ? "text-text-primary"
      : SESSION_COLORS[agentState];
  return (
    <div
      className={cn(
        "inline-flex items-center justify-center w-5 h-5 shrink-0",
        "transition-colors duration-150 ease-out reduce-motion:transition-none",
        tone
      )}
      role="status"
      // The global announcer speaks each transition once, with the pane's
      // name; a live region per pane would compete across a fleet (#9204).
      aria-live="off"
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
 *
 * It is the pane's permanent status, so every state draws a glyph (#16138):
 * the fleet band only decides what a wait is, and a wait that isn't news keeps
 * the waiting ring in grey rather than leaving the slot empty.
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

  if (!agentState) return null;

  // The glyph follows the run's fleet band; `agentState` stays the observation.
  const bandedState = resolvePaneSessionPresentation(agentState, band, {
    agentState: rawAgentState,
    waitingReason,
    isRestarting,
  });
  // The band leaves a wait undrawn when it isn't news: a prompt that asks
  // nothing, a seen ask, a park or snooze, no fleet report yet, or a pane that
  // has moved on from an ask the band still holds. The header still draws it,
  // without the amber that only an unread ask wears: a restart is not waiting
  // on anyone, and an error wait is blocked whatever the band has caught up to.
  const isPassiveWait = bandedState === undefined && agentState === "waiting";
  // A waiting reason only describes a wait the pane still observes; the fold
  // draws idle and finished agents waiting too, over whatever reason is left.
  const observesWait = (rawAgentState ?? agentState) === "waiting";
  const shownState: SessionPresentationState | undefined = !isPassiveWait
    ? bandedState
    : isRestarting === true
      ? "idle"
      : observesWait && waitingReason === "error"
        ? "blocked"
        : "waiting";
  const isReinterpreted = shownState !== agentState;

  if (!shownState || !SESSION_ICONS[shownState]) return null;

  const showConfidence = stateChangeConfidence != null && stateChangeConfidence < 1;
  const stateLabel = SESSION_LABELS[shownState];
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
    observesWait && (shownState === "waiting" || shownState === "blocked")
      ? actionableWaitingReason(waitingReason)
      : null;
  const chipAriaLabel = chipWaitingReason
    ? `Agent state: ${stateLabel} (${WAITING_REASON_BADGE_LABEL[chipWaitingReason].toLowerCase()})`
    : `Agent state: ${stateLabel}`;

  return (
    <Tooltip autoDismiss={false}>
      <TooltipTrigger asChild>
        {/* Focusable so the explanation behind the bar's most important mark
            reaches the keyboard too. Inset ring: the bar clips at its edge. */}
        <div
          className="relative inline-flex shrink-0 cursor-default items-center rounded-sm focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent-primary"
          tabIndex={0}
        >
          <AgentStateChip
            agentState={shownState}
            ariaLabel={chipAriaLabel}
            neutral={isPassiveWait && shownState === "waiting"}
          />
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
            {startedAt != null && (
              <>
                {" "}
                <FactSeparator /> {formatElapsedDuration(now - startedAt)}
              </>
            )}
          </span>
          {exitStatus && (
            <span
              // Neutral ink with the failure marked in shape: the error hue on
              // tooltip text falls under 4.5:1 on several themes.
              className="inline-flex items-center gap-1 tabular-nums text-text-secondary"
            >
              {exitStatus.failed && (
                <ErrorMark
                  className={cn("h-3 w-3 shrink-0", SEVERITY_VISUAL.error.toneClass)}
                  aria-hidden="true"
                />
              )}
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
                {" "}
                <FactSeparator /> {formatElapsedDuration(now - lastStateChange!)}
              </span>
            )}
            {stateChangeTrigger && (
              <>
                {" "}
                <FactSeparator /> {TRIGGER_LABELS[stateChangeTrigger]}
              </>
            )}
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
            <span className="inline-flex items-center gap-1">
              <ErrorMark
                className={cn("h-3 w-3 shrink-0", SEVERITY_VISUAL.error.toneClass)}
                aria-hidden="true"
              />
              {pluralize(errorCount, "error")}
            </span>
          )}
        </div>
      </TooltipContent>
    </Tooltip>
  );
}
