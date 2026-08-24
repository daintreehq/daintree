import { useEffect, useRef, useState } from "react";
import { Lock, CheckCircle2, Moon } from "lucide-react";
import type { AgentState, PanelKind } from "@/types";
import { cn } from "@/lib/utils";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { usePanelStore } from "@/store";
import { isPtyPanel } from "@shared/types/panel";
import { useShallow } from "zustand/react/shallow";
import { useResourceMonitoringStore } from "@/store/resourceMonitoringStore";
import { TerminalResourceSparkline } from "./TerminalResourceSparkline";
import { SubagentChip } from "./SubagentChip";
import { panelKindHasPty } from "@shared/config/panelKindRegistry";

export interface TerminalHeaderContentProps {
  id: string;
  kind?: PanelKind;
  agentState?: AgentState;
  activityStatus?: "working" | "waiting" | "success" | "failure";
  lastCommand?: string;
  isExited?: boolean;
  exitCode?: number | null;
  queueCount?: number;
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
  activityStatus,
  lastCommand,
  isExited = false,
  exitCode = null,
  queueCount = 0,
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

  const { isInputLocked, sessionCost } = usePanelStore(
    useShallow((state) => {
      const t = state.panelsById[id];
      const pty = t && isPtyPanel(t) ? t : undefined;
      return {
        isInputLocked: pty?.isInputLocked ?? false,
        sessionCost: pty?.sessionCost,
      };
    })
  );

  // Show command pill only for plain terminals (not agent terminals)
  const isPlainTerminal = kind == null || kind === "terminal";
  const showCommandPill =
    isPlainTerminal && !agentState && activityStatus === "working" && !!lastCommand;

  // The agent state glyph itself is not here: PanelHeader keeps it in its own
  // reserved box past the close button (TerminalAgentIndicator). This row only
  // carries the settled agent's trace — a cost readout, or a quiet "finished,
  // no changes" pill when there is no cost to show.
  const renderSettledPill = () => {
    if (agentState !== "completed" && agentState !== "exited") return null;

    if (sessionCost != null) {
      return (
        <span
          className="text-2xs text-text-secondary font-mono shrink-0"
          style={{ fontVariantNumeric: "tabular-nums" }}
        >
          ${sessionCost.toFixed(2)}
        </span>
      );
    }

    // Zero-change confirmation: agent finished without touching the working
    // tree. Show a quiet pill instead of letting the glyph vanish silently, so
    // the user has a clear signal that the run ended cleanly.
    if (agentState === "completed" && completedWithNoChanges) {
      return (
        <Tooltip>
          <TooltipTrigger asChild>
            <span
              className="inline-flex items-center gap-1 shrink-0 px-2 py-0.5 rounded-full text-2xs bg-overlay-soft border border-divider text-text-secondary"
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

    return null;
  };

  return (
    <>
      {/* Settled-agent trace leads the row per the runtime-signals tier table:
          macro state → pane-local error → diagnostic text → ambient state →
          telemetry last. Transient flow and submit status sit outside this row,
          in TerminalStatusSlot's reserved box ahead of the window controls
          (#12374). */}
      {renderSettledPill()}

      {/* Exit code badge — aria-live="off" overrides role="status"'s implicit
          polite live region. The global announcer in useAccessibilityAnnouncements
          routes the transition once with a pane-title prefix, avoiding competing
          live regions across a multi-pane fleet (#9204). */}
      {isExited && (
        <span className="text-xs font-mono text-status-error" role="status" aria-live="off">
          [exit {exitCode}]
        </span>
      )}

      {/* Hibernated badge — ambient cue that the pane's renderer is asleep.
          Rounded-full + dashed border keeps its silhouette apart from the
          other metadata chips without escalating weight. Transient flow and
          submit status live in TerminalStatusSlot's reserved box instead
          (#12374). The PTY survives; focus wakes it. */}
      {isHibernated && (
        <Tooltip>
          <TooltipTrigger asChild>
            <div
              className="inline-flex items-center gap-1 text-xs font-sans bg-overlay-soft text-text-secondary px-1.5 py-0.5 rounded-full border border-dashed border-divider"
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
            <span className="px-2 py-0.5 rounded-full text-2xs font-mono bg-overlay-soft text-text-secondary border border-divider truncate max-w-[20rem]">
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

      {/* Subagent count — self-gating, renders nothing unless this terminal's
          agent actually spawned children. The row's only pointer entry point,
          so it sits ahead of the ambient glyph and telemetry that a narrow
          pane's header clips first (#12374). */}
      <SubagentChip terminalId={id} />

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
                    <tr className="text-text-secondary">
                      <th className="text-left pr-2">PID</th>
                      <th className="text-left pr-2">Name</th>
                      <th className="text-right pr-2">CPU</th>
                      <th className="text-right">Mem</th>
                    </tr>
                  </thead>
                  <tbody>
                    {resourceState.breakdown.map((p) => (
                      <tr key={p.pid}>
                        <td className="pr-2 text-text-secondary">{p.pid}</td>
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
    </>
  );
}
