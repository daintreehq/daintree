import { useCallback, useEffect, useRef, useState } from "react";
import { Pause, Lock, CheckCircle2, Moon } from "lucide-react";
import type {
  AgentState,
  PanelKind,
  AgentStateChangeTrigger,
  PersistableFlowStatus,
} from "@/types";
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
import { useShallow } from "zustand/react/shallow";
import { formatElapsedDuration } from "@/utils/formatElapsedDuration";
import { formatTokenCount } from "@/utils/formatTokenCount";
import { formatTimeAgo } from "@/utils/timeAgo";
import { useResourceMonitoringStore } from "@/store/resourceMonitoringStore";
import { useErrorStore } from "@/store/errorStore";
import { useGlobalMinuteTicker } from "@/hooks/useGlobalMinuteTicker";
import { TerminalResourceSparkline } from "./TerminalResourceSparkline";
import { panelKindHasPty } from "@shared/config/panelKindRegistry";

function ElapsedTime({ startedAt, now }: { startedAt: number; now: number }) {
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
  agentState?: AgentState;
  activity?: ActivityState | null;
  activityStatus?: "working" | "waiting" | "success" | "failure";
  lastCommand?: string;
  isExited?: boolean;
  exitCode?: number | null;
  queueCount?: number;
  flowStatus?: PersistableFlowStatus;
  /**
   * True when the agent transitioned to `completed` and the pre-agent snapshot
   * confirms no file changes were made. Drives the "Finished, no changes" pill
   * so users get a quiet confirmation instead of the chip silently disappearing.
   */
  completedWithNoChanges?: boolean;
  /**
   * True when the terminal's renderer is hibernated (PTY preserved, xterm
   * disposed). Drives the ambient Moon pill — Tier-1 only, no toast.
   */
  isHibernated?: boolean;
}

function formatMemory(kb: number): string {
  if (kb >= 1048576) return `${(kb / 1048576).toFixed(1)}G`;
  if (kb >= 1024) return `${Math.round(kb / 1024)}M`;
  return `${kb}K`;
}

type ResourceSeverity = "muted" | "amber" | "red";

function getResourceSeverity(cpuPercent: number, memoryKb: number): ResourceSeverity {
  if (cpuPercent >= 80 || memoryKb >= 2097152) return "red";
  if (cpuPercent >= 50 || memoryKb >= 1048576) return "amber";
  return "muted";
}

const SEVERITY_ORDER: Record<ResourceSeverity, number> = { muted: 0, amber: 1, red: 2 };

// Asymmetric same-direction poll hysteresis before the displayed band changes —
// prevents flicker at threshold boundaries (CPU 50/80, mem 1G/2G). Escalating to
// a hotter band reacts quickly (3 polls); de-escalating back down lingers longer
// (5 polls) so hot states don't vanish on a single quiet poll. This deliberately
// diverges from ProcessDetector's symmetric hysteresis: a missed spike is worse
// than a slightly stale calm reading.
const ESCALATION_HYSTERESIS_POLLS = 3;
const DE_ESCALATION_HYSTERESIS_POLLS = 5;

export function TerminalHeaderContent({
  id,
  kind,
  agentState,
  activity,
  activityStatus,
  lastCommand,
  isExited = false,
  exitCode = null,
  queueCount = 0,
  flowStatus,
  completedWithNoChanges = false,
  isHibernated = false,
}: TerminalHeaderContentProps) {
  const resourceEnabled = useResourceMonitoringStore((s) => s.enabled);
  const resourceState = useResourceMonitoringStore((s) => s.metrics.get(id));
  const hasPtyKind = kind == null || panelKindHasPty(kind);
  const showResource = resourceEnabled && hasPtyKind && resourceState != null;

  const [stickySeverity, setStickySeverity] = useState<ResourceSeverity>("muted");
  const pendingCandidateRef = useRef<ResourceSeverity | null>(null);
  const pendingCountRef = useRef(0);

  useEffect(() => {
    if (!showResource || resourceState == null) {
      pendingCandidateRef.current = null;
      pendingCountRef.current = 0;
      setStickySeverity((current) => (current === "muted" ? current : "muted"));
      return;
    }

    const rawSeverity = getResourceSeverity(resourceState.cpuPercent, resourceState.memoryKb);
    setStickySeverity((current) => {
      if (rawSeverity === current) {
        pendingCandidateRef.current = null;
        pendingCountRef.current = 0;
        return current;
      }

      if (rawSeverity === pendingCandidateRef.current) {
        pendingCountRef.current += 1;
      } else {
        pendingCandidateRef.current = rawSeverity;
        pendingCountRef.current = 1;
      }

      const threshold =
        SEVERITY_ORDER[rawSeverity] > SEVERITY_ORDER[current]
          ? ESCALATION_HYSTERESIS_POLLS
          : DE_ESCALATION_HYSTERESIS_POLLS;
      if (pendingCountRef.current < threshold) {
        return current;
      }

      pendingCandidateRef.current = null;
      pendingCountRef.current = 0;
      return rawSeverity;
    });
  }, [resourceState, showResource]);

  const {
    isInputLocked,
    startedAt,
    lastStateChange,
    stateChangeTrigger,
    stateChangeConfidence,
    sessionCost,
    sessionTokens,
  } = usePanelStore(
    useShallow((state) => {
      const t = state.panelsById[id];
      const pty = t && isPtyPanel(t) ? t : undefined;
      return {
        isInputLocked: pty?.isInputLocked ?? false,
        startedAt: pty?.startedAt,
        lastStateChange: pty?.lastStateChange,
        stateChangeTrigger: pty?.stateChangeTrigger,
        stateChangeConfidence: pty?.stateChangeConfidence,
        sessionCost: pty?.sessionCost,
        sessionTokens: pty?.sessionTokens,
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

  const showStateDuration =
    (agentState === "working" || agentState === "waiting" || agentState === "directing") &&
    lastStateChange != null &&
    lastStateChange > 0 &&
    now - lastStateChange > 10_000;

  // Show command pill only for plain terminals (not agent terminals)
  const isPlainTerminal = kind == null || kind === "terminal";
  const showCommandPill =
    isPlainTerminal && !agentState && activityStatus === "working" && !!lastCommand;

  const renderAgentStateChip = () => {
    if (!agentState || agentState === "idle") {
      return null;
    }

    // Zero-change confirmation: agent finished without touching the working
    // tree. Show a quiet pill instead of letting the chip disappear, so the
    // user has a clear signal that the run ended cleanly.
    if (agentState === "completed" && sessionCost == null && completedWithNoChanges) {
      return (
        <Tooltip>
          <TooltipTrigger asChild>
            <span
              className="inline-flex items-center gap-1 shrink-0 px-2 py-0.5 rounded-full text-[11px] bg-overlay-soft border border-divider text-daintree-text/60"
              role="status"
              aria-label="Agent finished with no file changes"
            >
              <CheckCircle2 className="w-3 h-3" aria-hidden="true" />
              Finished, no changes
            </span>
          </TooltipTrigger>
          <TooltipContent side="bottom">No file changes since the agent started.</TooltipContent>
        </Tooltip>
      );
    }

    // Show completed/exited chip only when there's a cost to display
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
          : agentState === "completed"
            ? "bg-[color-mix(in_oklab,var(--color-status-success)_15%,transparent)] border-status-success/40"
            : agentState === "exited"
              ? "bg-overlay-soft border-divider"
              : "bg-[color-mix(in_oklab,var(--color-state-waiting)_15%,transparent)] border-state-waiting/40";

    const headline = activity?.headline?.trim() || `Agent ${agentState}`;
    const showConfidence = stateChangeConfidence != null && stateChangeConfidence < 1;
    const stateLabel = getEffectiveStateLabel(agentState);

    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <div className="inline-flex items-center gap-1.5 shrink-0">
            <div className="relative inline-flex items-center shrink-0">
              <div
                className={cn(
                  "inline-flex items-center justify-center w-5 h-5 rounded-full border shrink-0",
                  chipStyle,
                  effectiveColor
                )}
                role="status"
                aria-label={`Agent state: ${stateLabel}`}
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
                  className="absolute -top-0.5 -right-0.5 w-2 h-2 rounded-full bg-status-error"
                  aria-label={`${errorCount} error${errorCount > 1 ? "s" : ""}`}
                />
              )}
            </div>
            {(agentState === "completed" || agentState === "exited") && sessionCost != null && (
              <span
                className="text-[11px] text-daintree-text/50 font-mono shrink-0"
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
              {startedAt != null && <ElapsedTime startedAt={startedAt} now={now} />}
            </span>
            {isExited && exitCode != null && (
              <span className="text-status-error tabular-nums">Exit code: {exitCode}</span>
            )}
            <span>
              State: {stateLabel}
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
              <span className="text-daintree-text/60">Since: {formatTimeAgo(lastStateChange)}</span>
            )}
            {sessionCost != null && (
              <span className="text-daintree-text/60 tabular-nums">
                Cost: ${sessionCost.toFixed(2)}
                {sessionTokens != null && ` · ${formatTokenCount(sessionTokens)} tokens`}
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
  };

  return (
    <>
      {/* Command Pill - shows currently running command (inline with title) */}
      {showCommandPill && (
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="px-3 py-1 rounded-full text-[11px] font-mono bg-overlay-soft text-daintree-text/60 border border-divider truncate max-w-[20rem]">
              {lastCommand}
            </span>
          </TooltipTrigger>
          <TooltipContent side="bottom">{lastCommand}</TooltipContent>
        </Tooltip>
      )}

      {/* Exit code badge */}
      {isExited && (
        <span className="text-xs font-mono text-status-error ml-1" role="status" aria-live="polite">
          [exit {exitCode}]
        </span>
      )}

      {/* Queue count badge */}
      {queueCount > 0 && (
        <Tooltip>
          <TooltipTrigger asChild>
            <div
              className="inline-flex items-center gap-1 text-xs font-sans bg-overlay-medium text-daintree-text px-1.5 py-0.5 rounded ml-1"
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
      )}

      {/* Paused badge */}
      {flowStatus === "paused-backpressure" && (
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
          <TooltipContent side="bottom" className="max-w-xs">
            <div className="flex flex-col gap-0.5">
              <span className="font-medium">Buffer overflow</span>
              <span>Output paused to prevent data loss.</span>
            </div>
          </TooltipContent>
        </Tooltip>
      )}

      {/* Resource governor pause badge */}
      {flowStatus === "paused-resource-governor" && (
        <Tooltip>
          <TooltipTrigger asChild>
            <div
              className="flex items-center gap-1 text-xs font-sans bg-status-warning/15 text-status-warning px-1.5 py-0.5 rounded ml-1"
              role="status"
              aria-live="polite"
            >
              <Pause className="w-3 h-3" aria-hidden="true" />
              Paused (memory)
            </div>
          </TooltipTrigger>
          <TooltipContent side="bottom" className="max-w-xs">
            <div className="flex flex-col gap-0.5">
              <span className="font-medium">System memory pressure</span>
              <span>Paused to reduce memory pressure. Recovers automatically.</span>
            </div>
          </TooltipContent>
        </Tooltip>
      )}

      {/* Suspended badge */}
      {flowStatus === "suspended" && (
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
          <TooltipContent side="bottom" className="max-w-xs">
            <div className="flex flex-col gap-0.5">
              <span className="font-medium">Output suspended</span>
              <span>Streaming stalled. Recovers automatically on focus.</span>
            </div>
          </TooltipContent>
        </Tooltip>
      )}

      {/* Hibernated badge — ambient cue that the pane's renderer is asleep.
          Uses the idle activity color, not accent. The PTY survives; focus wakes it.
          Renders after Paused/Suspended so higher-urgency flow-control states lead
          visually when both apply (a lingering flowStatus can outlive hibernation). */}
      {isHibernated && (
        <Tooltip>
          <TooltipTrigger asChild>
            <div
              className="flex items-center gap-1 text-xs font-sans bg-overlay-soft text-daintree-text/60 px-1.5 py-0.5 rounded ml-1 border border-divider"
              role="status"
              aria-live="polite"
              data-testid="terminal-hibernated-badge"
            >
              <Moon className="w-3 h-3" aria-hidden="true" />
              Hibernated
            </div>
          </TooltipTrigger>
          <TooltipContent side="bottom" className="max-w-xs">
            <div className="flex flex-col gap-0.5">
              <span className="font-medium">Renderer asleep</span>
              <span>PTY preserved. Wakes on focus.</span>
            </div>
          </TooltipContent>
        </Tooltip>
      )}

      {/* Input locked indicator */}
      {isInputLocked && (
        <Tooltip>
          <TooltipTrigger asChild>
            <div className="flex items-center text-daintree-text/50 shrink-0" role="status">
              <Lock className="w-3.5 h-3.5" aria-hidden="true" />
            </div>
          </TooltipTrigger>
          <TooltipContent side="bottom">Input locked (read-only monitor mode)</TooltipContent>
        </Tooltip>
      )}

      {/* Resource monitoring badge */}
      {showResource && (
        <Tooltip>
          <TooltipTrigger asChild>
            <div
              className={cn(
                "inline-flex items-center gap-1 text-[11px] font-mono shrink-0 ml-1 transition-colors duration-150",
                {
                  "text-daintree-text/40": stickySeverity === "muted",
                  "text-status-warning": stickySeverity === "amber",
                  "text-status-error": stickySeverity === "red",
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
                    <tr className="text-daintree-text/60">
                      <th className="text-left pr-2">PID</th>
                      <th className="text-left pr-2">Name</th>
                      <th className="text-right pr-2">CPU</th>
                      <th className="text-right">Mem</th>
                    </tr>
                  </thead>
                  <tbody>
                    {resourceState.breakdown.map((p) => (
                      <tr key={p.pid}>
                        <td className="pr-2 text-daintree-text/60">{p.pid}</td>
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
      )}

      {/* Agent state chip */}
      {renderAgentStateChip()}
    </>
  );
}
