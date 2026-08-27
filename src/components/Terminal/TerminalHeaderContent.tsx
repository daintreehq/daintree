import { useCallback, useEffect, useRef, useState } from "react";
import { Pause, Cpu, Hourglass, Lock, CheckCircle2, Moon } from "lucide-react";
import type { AgentState, PanelKind, AgentStateChangeTrigger, TerminalFlowStatus } from "@/types";
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
import { formatElapsedDuration } from "@/utils/formatElapsedDuration";
import { formatTokenCount } from "@/utils/formatTokenCount";
import { formatTimeAgo } from "@/utils/timeAgo";
import { useResourceMonitoringStore } from "@/store/resourceMonitoringStore";
import { useErrorStore } from "@/store/errorStore";
import { useGlobalMinuteTicker } from "@/hooks/useGlobalMinuteTicker";
import { TerminalResourceSparkline } from "./TerminalResourceSparkline";
import { SubagentChip } from "./SubagentChip";
import { panelKindHasPty } from "@shared/config/panelKindRegistry";

// FUTURE_SAB: the `flowStatus` prop is widened to `TerminalFlowStatus` (not
// `PersistableFlowStatus`) so the Suspended pill below remains type-safe
// while `suspended` is a skeleton value with no production producer (#9900).
// Callers in practice only pass `PersistableFlowStatus` values; the wider
// type is purely so the future-sab branch is reachable. When the SAB
// transport path is revived, restore the narrow prop type.

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
  flowStatus?: TerminalFlowStatus;
  /**
   * Submit-lane state for this terminal (#11875). Only `"slow"` renders here —
   * it is the Tier-1 ambient half of the signal. `"stalled"`/`"failed"` escalate
   * to `TerminalSubmitStatusBanner` in the pane, which owns the recovery action.
   */
  submitStatus?: "slow" | "stalled" | "failed";
  /**
   * True when the agent transitioned to `completed` and the worktree's
   * changed-file count is zero. Drives the "Finished, no changes" pill
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
  submitStatus,
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
    waitingReason,
    sessionCost,
    sessionTokens,
    heldDurationMs,
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
        waitingReason: pty?.waitingReason,
        sessionCost: pty?.sessionCost,
        sessionTokens: pty?.sessionTokens,
        heldDurationMs: pty?.heldDurationMs,
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
              className="inline-flex items-center gap-1 shrink-0 px-2 py-0.5 rounded-full text-2xs bg-overlay-soft border border-divider text-daintree-text/60"
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
          <div className="inline-flex items-center gap-1.5 shrink-0">
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
            {(agentState === "completed" || agentState === "exited") && sessionCost != null && (
              <span
                className="text-2xs text-daintree-text/50 font-mono shrink-0"
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
      {/* Agent state chip — the macro pane-state signal leads the row per the
          runtime-signals tier table: macro state → pane-local error/flow →
          diagnostic text → ambient state → telemetry last. */}
      {renderAgentStateChip()}

      {/* Exit code badge — aria-live="off" overrides role="status"'s implicit
          polite live region. The global announcer in useAccessibilityAnnouncements
          routes the transition once with a pane-title prefix, avoiding competing
          live regions across a multi-pane fleet (#9204). */}
      {isExited && (
        <span className="text-xs font-mono text-status-error" role="status" aria-live="off">
          [exit {exitCode}]
        </span>
      )}

      {/* Prompt-still-sending badge — Tier-1 ambient (#11875). Self-clearing:
          the submit reports `settled` when it finally lands. Deliberately no
          action here — the original Enter is still armed, so any "send again"
          affordance would double-submit. If it stops progressing entirely the
          pane escalates to a banner and this pill gives way to it. */}
      {submitStatus === "slow" && (
        <Tooltip>
          <TooltipTrigger asChild>
            <div
              className="inline-flex items-center gap-1 text-xs font-sans bg-overlay-soft text-daintree-text/60 px-1.5 py-0.5 rounded border border-divider"
              role="status"
              aria-live="off"
            >
              <Hourglass className="w-3 h-3" aria-hidden="true" />
              Prompt still sending
            </div>
          </TooltipTrigger>
          <TooltipContent side="bottom" className="max-w-xs">
            <div className="flex flex-col gap-0.5">
              <span className="font-medium">Still sending</span>
              <span>Later prompts stay queued so they can&apos;t merge into this one.</span>
            </div>
          </TooltipContent>
        </Tooltip>
      )}

      {/* Paused-backpressure badge — Tier-1 ambient (auto-recovering).
          Demoted off `status-warning/15` per docs/architecture/resource-governance.md#173;
          distinct from the other two flow pills by its `Pause` icon. */}
      {flowStatus === "paused-backpressure" && (
        <Tooltip>
          <TooltipTrigger asChild>
            <div
              className="inline-flex items-center gap-1 text-xs font-sans bg-overlay-soft text-daintree-text/60 px-1.5 py-0.5 rounded border border-divider"
              role="status"
              aria-live="off"
            >
              <Pause className="w-3 h-3" aria-hidden="true" />
              Paused
            </div>
          </TooltipTrigger>
          <TooltipContent side="bottom" className="max-w-xs">
            <div className="flex flex-col gap-0.5">
              <span className="font-medium">Buffer overflow</span>
              <span>Output paused to prevent data loss.</span>
              {heldDurationMs != null && heldDurationMs > 0 && (
                <span className="text-daintree-text/60 tabular-nums">
                  Paused for {formatElapsedDuration(heldDurationMs)}
                </span>
              )}
            </div>
          </TooltipContent>
        </Tooltip>
      )}

      {/* Resource-governor pause badge — Tier-1 ambient. Distinguished from
          the other two flow pills by its `Cpu` icon (memory pressure). */}
      {flowStatus === "paused-resource-governor" && (
        <Tooltip>
          <TooltipTrigger asChild>
            <div
              className="inline-flex items-center gap-1 text-xs font-sans bg-overlay-soft text-daintree-text/60 px-1.5 py-0.5 rounded border border-divider"
              role="status"
              aria-live="off"
            >
              <Cpu className="w-3 h-3" aria-hidden="true" />
              Paused (memory)
            </div>
          </TooltipTrigger>
          <TooltipContent side="bottom" className="max-w-xs">
            <div className="flex flex-col gap-0.5">
              <span className="font-medium">System memory pressure</span>
              <span>Paused to reduce memory pressure. Recovers automatically.</span>
              {/* Held-duration gauge intentionally omitted: ResourceGovernor
                  pauses via the coordinator but does not emit `pause-start`
                  / `pause-end` reliability metrics, so the
                  `pause-duration-gauge` funnel never tracks it. Showing
                  a frozen "Paused for Xs" line would be a lie. */}
            </div>
          </TooltipContent>
        </Tooltip>
      )}

      {/* FUTURE_SAB: Suspended badge — Tier-1 ambient. The `suspended` flowStatus
          is only emitted by the SharedArrayBuffer transport path in the PTY host
          (`BackpressureManager.suspendVisualStream`, see
          `electron/pty-host/backpressure.ts:277`). That path is unreachable in
          production — SharedArrayBuffer is not supported in Electron
          UtilityProcess (PR #7724, issue #7653). The badge is kept as a
          forward-looking skeleton for a potential Worker-thread migration
          that could revive the SAB zero-copy data path. Mirror of the
          // FUTURE_SAB: annotation in the producer. When the SAB transport
          is revived, this branch is reachable again; until then it never
          renders in production. See issue #9900. Distinguished by its
          `Hourglass` icon (time-based wait, recovers on focus). */}
      {flowStatus === "suspended" && (
        <Tooltip>
          <TooltipTrigger asChild>
            <div
              className="inline-flex items-center gap-1 text-xs font-sans bg-overlay-soft text-daintree-text/60 px-1.5 py-0.5 rounded border border-divider"
              role="status"
              aria-live="off"
            >
              <Hourglass className="w-3 h-3" aria-hidden="true" />
              Suspended
            </div>
          </TooltipTrigger>
          <TooltipContent side="bottom" className="max-w-xs">
            <div className="flex flex-col gap-0.5">
              <span className="font-medium">Output suspended</span>
              <span>Streaming stalled. Recovers automatically on focus.</span>
              {heldDurationMs != null && heldDurationMs > 0 && (
                <span className="text-daintree-text/60 tabular-nums">
                  Paused for {formatElapsedDuration(heldDurationMs)}
                </span>
              )}
            </div>
          </TooltipContent>
        </Tooltip>
      )}

      {/* Hibernated badge — ambient cue that the pane's renderer is asleep.
          Rounded-full + dashed border separates its silhouette from the three
          transient flow pills (which stay `rounded` + solid border) without
          escalating weight. Renders after Paused/Suspended so higher-urgency
          flow-control states lead visually when both apply. The PTY survives;
          focus wakes it. */}
      {isHibernated && (
        <Tooltip>
          <TooltipTrigger asChild>
            <div
              className="inline-flex items-center gap-1 text-xs font-sans bg-overlay-soft text-daintree-text/60 px-1.5 py-0.5 rounded-full border border-dashed border-divider"
              role="status"
              aria-live="off"
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

      {/* Command Pill - shows currently running command (inline with title).
          Slimmed to px-2 py-0.5 to match the row's other small badges. */}
      {showCommandPill && (
        <Tooltip autoDismiss={false}>
          <TooltipTrigger asChild>
            <span className="px-2 py-0.5 rounded-full text-2xs font-mono bg-overlay-soft text-daintree-text/60 border border-divider truncate max-w-[20rem]">
              {lastCommand}
            </span>
          </TooltipTrigger>
          <TooltipContent side="bottom">{lastCommand}</TooltipContent>
        </Tooltip>
      )}

      {/* Queue count badge */}
      {queueCount > 0 && (
        <Tooltip>
          <TooltipTrigger asChild>
            <div
              className="inline-flex items-center gap-1 text-xs font-sans bg-overlay-medium text-text-primary px-1.5 py-0.5 rounded"
              role="status"
              aria-live="off"
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

      {/* Resource monitoring badge — ambient telemetry, last. The severity
          hysteresis (escalation 3 polls / de-escalation 5 polls) encodes a
          semantic timing and is intentionally NOT normalized to a motion tier. */}
      {showResource && (
        <Tooltip autoDismiss={false}>
          <TooltipTrigger asChild>
            <div
              className={cn(
                "inline-flex items-center gap-1 text-2xs font-mono shrink-0 transition-colors duration-150",
                {
                  "text-text-secondary": stickySeverity === "muted",
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

      {/* Input locked indicator — bare ambient glyph. */}
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

      {/* Subagent count — self-gating, renders nothing unless this terminal's
          agent actually spawned children. */}
      <SubagentChip terminalId={id} />
    </>
  );
}
