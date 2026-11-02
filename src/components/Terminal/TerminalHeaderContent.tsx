import { useEffect, useRef, useState } from "react";
import { Lock } from "lucide-react";
import { OctagonAlert, TriangleAlert } from "@/components/icons";
import type { AgentState, PanelKind } from "@/types";
import { cn } from "@/lib/utils";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { usePanelStore } from "@/store";
import { isPtyPanel } from "@shared/types/panel";
import { useShallow } from "zustand/react/shallow";
import { formatTokenCount } from "@/utils/formatTokenCount";
import {
  isSettledResourceState,
  useResourceMonitoringStore,
} from "@/store/resourceMonitoringStore";
import { TerminalResourceSparkline } from "./TerminalResourceSparkline";
import { SubagentChip } from "./SubagentChip";
import {
  HEADER_CHIP_CLASS,
  HEADER_CHIP_FOCUS_CLASS,
  HEADER_CHIP_SURFACE,
} from "./terminalHeaderChip";
import { TerminalDrivenByBadge } from "./TerminalHandOver";
import { TerminalRateLimitBadge } from "./TerminalRateLimitBadge";
import { TerminalNotifyChip } from "./TerminalNotifyChip";
import { TerminalDecisionsChip } from "./TerminalDecisionsChip";
import { panelKindHasPty } from "@shared/config/panelKindRegistry";
import { describeExitStatus } from "./exitStatus";
import { pluralize } from "@/lib/pluralize";
import { SEVERITY_VISUAL } from "@/lib/statusSeverity";
import { formatCores } from "@/components/Project/ProjectResourceBadge.utils";

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
   * True when the agent transitioned to `completed` and git status observed
   * zero uncommitted changes in its worktree (never when the count is unknown).
   * Leads the settled trace chip with "Nothing to commit".
   */
  completedWithNoChanges?: boolean;
}

/**
 * `$0.42` in the row; with `exact`, every digit the session summary printed
 * (`$0.012345`), so the disclosure never rounds a small run down to `$0.00`.
 */
function formatSessionCost(cost: number, exact = false): string {
  // A run that cost something never reads as free in the row.
  if (!exact && cost > 0 && cost < 0.005) return "<$0.01";
  return cost.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: exact ? 20 : 2,
  });
}

const ExitMark = SEVERITY_VISUAL.error.Icon;

function formatMemory(kb: number): string {
  if (kb >= 1048576) return `${(kb / 1048576).toFixed(1)}G`;
  if (kb >= 1024) return `${Math.round(kb / 1024)}M`;
  return `${kb}K`;
}

type ResourceSeverity = "muted" | "amber" | "red";

// CPU is the sum of ps %cpu across the pane's process tree, so 100 is one busy
// core and a multi-core build reads above it; the bands are about one core.
function getCpuSeverity(cpuPercent: number): ResourceSeverity {
  if (cpuPercent >= 80) return "red";
  if (cpuPercent >= 50) return "amber";
  return "muted";
}

function getMemorySeverity(memoryKb: number): ResourceSeverity {
  if (memoryKb >= 2097152) return "red";
  if (memoryKb >= 1048576) return "amber";
  return "muted";
}

const SEVERITY_ORDER: Record<ResourceSeverity, number> = { muted: 0, amber: 1, red: 2 };

const SEVERITY_TONE: Record<ResourceSeverity, string> = {
  muted: "text-text-secondary",
  amber: "text-status-warning",
  red: "text-status-error",
};

/** A mark's footprint: `w-3` plus its `mr-1`, reserved alongside the digits. */
const SEVERITY_MARK_WIDTH = "1rem";

/**
 * The band in shape, set immediately before the reading it is about. The
 * reading itself stays `text-text-secondary`: status hues on 10px numerals fall
 * under 4.5:1 on light headers, and forced colours flatten them anyway.
 */
function SeverityMark({ severity }: { severity: ResourceSeverity }) {
  if (severity === "muted") return null;
  const Icon = severity === "red" ? OctagonAlert : TriangleAlert;
  return (
    <Icon
      className={cn("w-3 h-3 shrink-0 mr-1", SEVERITY_TONE[severity])}
      data-severity-mark={severity}
      data-resource-glyph=""
      aria-hidden="true"
    />
  );
}

// Asymmetric same-direction poll hysteresis before the displayed band changes —
// prevents flicker at threshold boundaries (CPU 50/80, mem 1G/2G). Escalating to
// a hotter band reacts quickly (3 polls); de-escalating back down lingers longer
// (5 polls) so hot states don't vanish on a single quiet poll. This deliberately
// diverges from ProcessDetector's symmetric hysteresis: a missed spike is worse
// than a slightly stale calm reading.
const ESCALATION_HYSTERESIS_POLLS = 3;
const DE_ESCALATION_HYSTERESIS_POLLS = 5;

/**
 * The displayed band for one metric. `poll` changes identity once per sample,
 * so each effect run counts one poll; `raw == null` means no sample and resets
 * to muted.
 *
 * Runs count readings at or above a band, not readings of exactly that band: a
 * pane swinging 60% / 90% / 60% is above amber on every poll and must earn it,
 * where matching the exact band would reset on every swing and stay muted.
 * Coming down, the run counts readings below the shown band and lands on the
 * hottest band seen during it, so a quiet spell with a spike in it steps down
 * rather than falling straight through.
 *
 * A `settled` poll has held for a full history window, longer than either run,
 * and the store stops issuing new polls for it — so it shows as-is rather than
 * starting a run that would never complete.
 */
function useStickySeverity(
  raw: ResourceSeverity | null,
  poll: unknown,
  settled: boolean
): ResourceSeverity {
  const [sticky, setSticky] = useState<ResourceSeverity>("muted");
  // The bookkeeping lives in refs and is keyed to the poll it last counted, so
  // StrictMode's doubled mount effect cannot count one sample twice.
  const shownRef = useRef<ResourceSeverity>("muted");
  const countedPollRef = useRef<unknown>(undefined);
  const aboveRef = useRef<Record<"amber" | "red", number>>({ amber: 0, red: 0 });
  const belowRef = useRef<{ count: number; peak: ResourceSeverity }>({ count: 0, peak: "muted" });

  useEffect(() => {
    const above = aboveRef.current;
    const below = belowRef.current;
    const show = (next: ResourceSeverity) => {
      shownRef.current = next;
      setSticky(next);
    };

    if (raw == null) {
      countedPollRef.current = undefined;
      above.amber = 0;
      above.red = 0;
      below.count = 0;
      show("muted");
      return;
    }
    if (countedPollRef.current === poll) return;
    countedPollRef.current = poll;

    if (settled) {
      above.amber = 0;
      above.red = 0;
      below.count = 0;
      show(raw);
      return;
    }

    const level = SEVERITY_ORDER[raw];
    const shown = SEVERITY_ORDER[shownRef.current];
    above.amber = level >= SEVERITY_ORDER.amber ? above.amber + 1 : 0;
    above.red = level >= SEVERITY_ORDER.red ? above.red + 1 : 0;

    if (shown < SEVERITY_ORDER.red && above.red >= ESCALATION_HYSTERESIS_POLLS) {
      below.count = 0;
      show("red");
      return;
    }
    if (shown < SEVERITY_ORDER.amber && above.amber >= ESCALATION_HYSTERESIS_POLLS) {
      below.count = 0;
      show("amber");
      return;
    }
    if (level >= shown) {
      below.count = 0;
      return;
    }
    if (below.count === 0 || level > SEVERITY_ORDER[below.peak]) below.peak = raw;
    below.count += 1;
    if (below.count >= DE_ESCALATION_HYSTERESIS_POLLS) {
      below.count = 0;
      show(below.peak);
    }
  }, [raw, poll, settled]);

  return sticky;
}

function describeResources(
  cpuPercent: number,
  memoryKb: number,
  cpu: ResourceSeverity,
  memory: ResourceSeverity
): string {
  const high = [cpu !== "muted" && "CPU", memory !== "muted" && "memory"].filter(Boolean);
  const reading = `CPU ${formatCores(cpuPercent / 100)}, memory ${formatMemory(memoryKb)}`;
  return high.length > 0 ? `${reading}; high ${high.join(" and ")}` : reading;
}

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
}: TerminalHeaderContentProps) {
  const resourceEnabled = useResourceMonitoringStore((s) => s.enabled);
  const resourceState = useResourceMonitoringStore((s) => s.metrics.get(id));
  const hasPtyKind = kind == null || panelKindHasPty(kind);
  const showResource = resourceEnabled && hasPtyKind && resourceState != null;
  const resourceSettled = showResource && isSettledResourceState(resourceState);

  const cpuSeverity = useStickySeverity(
    showResource ? getCpuSeverity(resourceState.cpuPercent) : null,
    showResource ? resourceState : null,
    resourceSettled
  );
  const memorySeverity = useStickySeverity(
    showResource ? getMemorySeverity(resourceState.memoryKb) : null,
    showResource ? resourceState : null,
    resourceSettled
  );
  const resourceSeverity =
    SEVERITY_ORDER[cpuSeverity] >= SEVERITY_ORDER[memorySeverity] ? cpuSeverity : memorySeverity;

  // When memory is the worse band, the row that explains it leads.
  const breakdownRows =
    showResource && SEVERITY_ORDER[memorySeverity] > SEVERITY_ORDER[cpuSeverity]
      ? [...resourceState.breakdown].sort((a, b) => b.memoryKb - a.memoryKb)
      : (resourceState?.breakdown ?? []);

  const { isInputLocked, sessionCost, sessionTokens } = usePanelStore(
    useShallow((state) => {
      const t = state.panelsById[id];
      const pty = t && isPtyPanel(t) ? t : undefined;
      return {
        isInputLocked: pty?.isInputLocked ?? false,
        sessionCost: pty?.sessionCost,
        sessionTokens: pty?.sessionTokens,
      };
    })
  );

  // Show command pill only for plain terminals (not agent terminals)
  const exitStatus = isExited ? describeExitStatus(exitCode) : null;
  const isPlainTerminal = kind == null || kind === "terminal";
  const showCommandPill =
    isPlainTerminal && !agentState && activityStatus === "working" && !!lastCommand;

  // The agent state glyph itself is not here: PanelHeader keeps it in its own
  // reserved box past the close button (TerminalAgentIndicator), where a
  // finished agent reads as handed back. This row carries what the settled
  // agent left behind, as one chip: an observed clean worktree, then the
  // session summary's cost and tokens. Each part shows only when it was seen.
  const renderSettledTrace = () => {
    if (agentState !== "completed" && agentState !== "exited") return null;

    const noChanges = agentState === "completed" && completedWithNoChanges;
    const hasSummary = sessionCost != null || sessionTokens != null;
    if (!noChanges && !hasSummary) return null;

    const exactSummary = [
      sessionCost != null && `${formatSessionCost(sessionCost, true)} USD`,
      sessionTokens != null && `${sessionTokens.toLocaleString("en-US")} tokens`,
    ].filter(Boolean);
    const label = [
      noChanges && "Agent finished, nothing to commit",
      hasSummary && `session ${exactSummary.join(", ")}`,
    ]
      .filter(Boolean)
      .join("; ");

    return (
      <Tooltip autoDismiss={false} disableHoverableContent={false}>
        <TooltipTrigger asChild>
          <span
            className={cn(
              HEADER_CHIP_CLASS,
              HEADER_CHIP_SURFACE,
              HEADER_CHIP_FOCUS_CLASS,
              "min-w-0 max-w-[20rem] shrink tabular-nums"
            )}
            role="status"
            aria-live="off"
            aria-label={label.charAt(0).toUpperCase() + label.slice(1)}
            tabIndex={0}
            data-testid="terminal-settled-trace"
          >
            {/* Under width pressure the token count goes first, as a unit, then
                the worktree phrase truncates; the cost never clips. The label
                and tooltip carry every part in full. */}
            {noChanges && (
              <span className="min-w-0 truncate" aria-hidden="true">
                Nothing to commit
              </span>
            )}
            {sessionCost != null && (
              <span className="shrink-0 whitespace-pre" aria-hidden="true">
                {noChanges && <span className="mr-1">·</span>}
                {formatSessionCost(sessionCost)}
              </span>
            )}
            {sessionTokens != null && (
              <span
                className={cn(
                  "shrink-0 whitespace-pre",
                  (noChanges || isExited) && sessionCost != null && "@max-[640px]/header:hidden"
                )}
                aria-hidden="true"
              >
                {/* The chip's gap sits before the dot and mr-1 after it, so the
                    dot is centred rather than clinging to the value. */}
                {(noChanges || sessionCost != null) && <span className="mr-1">·</span>}
                {formatTokenCount(sessionTokens)} tokens
              </span>
            )}
          </span>
        </TooltipTrigger>
        <TooltipContent side="bottom" className="max-w-xs">
          <div className="flex flex-col gap-1">
            {noChanges && (
              <div className="flex flex-col gap-0.5">
                <span className="font-medium">Nothing to commit in this worktree</span>
                <span className="text-text-secondary">
                  From git status. Commits made during the run aren’t counted.
                </span>
              </div>
            )}
            {hasSummary && (
              <div className="flex flex-col gap-0.5">
                <span className="font-medium tabular-nums">{exactSummary.join(" · ")}</span>
                <span className="text-text-secondary">From the agent’s session summary</span>
              </div>
            )}
          </div>
        </TooltipContent>
      </Tooltip>
    );
  };

  return (
    <>
      {/* Settled-agent trace leads the row per the runtime-signals tier table:
          macro state → pane-local error → diagnostic text → ambient state →
          telemetry last. Transient flow and submit status sit outside this row,
          in TerminalStatusSlot's reserved box ahead of the window controls
          (#12374). */}
      {renderSettledTrace()}

      {/* Exit code badge — aria-live="off" overrides role="status"'s implicit
          polite live region. The global announcer in useAccessibilityAnnouncements
          routes the transition once with a pane-title prefix, avoiding competing
          live regions across a multi-pane fleet (#9204). In the row's shared
          chip box, so the ended session's cost and exit read as one kind of
          fact; a failure is marked in shape ahead of the reading, which keeps
          secondary ink because the error hue on 11px text falls under 4.5:1 on
          several light headers. */}
      {exitStatus && (
        <span
          className={cn(HEADER_CHIP_CLASS, HEADER_CHIP_SURFACE, "font-mono tabular-nums")}
          role="status"
          aria-live="off"
          aria-label={exitStatus.failed ? `${exitStatus.badge}, failed` : undefined}
        >
          {exitStatus.failed && (
            <ExitMark
              className={cn("w-3 h-3 shrink-0", SEVERITY_VISUAL.error.toneClass)}
              aria-hidden="true"
            />
          )}
          {exitStatus.badge}
        </span>
      )}

      {/* Driven-by badge — ambient cue that the user handed this terminal to
          an orchestrating pane (#12490), naming which one. Self-gating. */}
      {hasPtyKind && <TerminalDrivenByBadge terminalId={id} />}

      {/* Pane-observed rate-limit banner (#12797). Self-gating and expiring. */}
      {hasPtyKind && <TerminalRateLimitBadge terminalId={id} />}

      {/* Command Pill - shows currently running command (inline with title).
          The row's one chip box; the command truncates inside it. */}
      {showCommandPill && (
        <Tooltip autoDismiss={false}>
          <TooltipTrigger asChild>
            <span
              className={cn(
                HEADER_CHIP_CLASS,
                HEADER_CHIP_SURFACE,
                "min-w-0 max-w-[20rem] shrink font-mono"
              )}
            >
              <span className="truncate">{lastCommand}</span>
            </span>
          </TooltipTrigger>
          <TooltipContent side="bottom">{lastCommand}</TooltipContent>
        </Tooltip>
      )}

      {/* Queue count badge */}
      {queueCount > 0 && (
        <Tooltip>
          <TooltipTrigger asChild>
            {/* One run of text like every other count in the bar, not a mono
                digit a flex gap away from its noun. */}
            <div
              className={cn(HEADER_CHIP_CLASS, HEADER_CHIP_SURFACE, "tabular-nums")}
              role="status"
              aria-live="off"
            >
              {queueCount} queued
            </div>
          </TooltipTrigger>
          <TooltipContent side="bottom">
            {`${pluralize(queueCount, "command")} queued`}
          </TooltipContent>
        </Tooltip>
      )}

      {/* Subagent count — self-gating, renders nothing unless this terminal's
          agent actually spawned children. The row's only pointer entry point,
          so it sits ahead of the ambient glyph and telemetry that a narrow
          pane's header clips first (#12374). */}
      <SubagentChip terminalId={id} />

      {/* Decisions — self-gating; shown only while Decisions is on and this
          pane's agent has a question out, an answer waiting to be typed in,
          or an answer that needs a person. */}
      {hasPtyKind && <TerminalDecisionsChip terminalId={id} />}

      {/* Terminal notices — self-gating; shown only while an agent in this
          pane is waiting to hear about other terminals, and the one place the
          user can stop them. */}
      {hasPtyKind && <TerminalNotifyChip terminalId={id} />}

      {/* Input locked indicator — bare ambient glyph. */}
      {isInputLocked && (
        <Tooltip>
          <TooltipTrigger asChild>
            {/* Focusable like the row's other tooltip-bearing marks, so the
                reason the pane ignores keystrokes reaches the keyboard too. */}
            <div
              className={cn(
                "flex shrink-0 items-center rounded-sm p-0.5 text-text-secondary",
                HEADER_CHIP_FOCUS_CLASS
              )}
              role="status"
              aria-live="off"
              aria-label="Input locked (read-only monitor mode)"
              tabIndex={0}
            >
              <Lock className="w-3 h-3" aria-hidden="true" />
            </div>
          </TooltipTrigger>
          <TooltipContent side="bottom">Input locked (read-only monitor mode)</TooltipContent>
        </Tooltip>
      )}

      {/* Resource monitoring badge — ambient telemetry, last. CPU and memory
          each carry their own band, marked in shape beside the reading it is
          about, so a hot badge says which one is high and survives forced
          colours; the CPU line takes the CPU band's hue. Focusable so the
          breakdown reaches keyboard users; aria-live="off" because it changes
          every poll and must not compete with the fleet announcer (#9204). The severity hysteresis encodes a semantic
          timing and is intentionally NOT normalized to a motion tier. */}
      {showResource && (
        <Tooltip autoDismiss={false} disableHoverableContent={false}>
          <TooltipTrigger asChild>
            <div
              className={cn(
                "inline-flex items-center gap-1.5 px-1 py-0.5 text-2xs font-mono shrink-0 rounded-sm tabular-nums",
                HEADER_CHIP_FOCUS_CLASS
              )}
              role="status"
              aria-live="off"
              tabIndex={0}
              aria-label={describeResources(
                resourceState.cpuPercent,
                resourceState.memoryKb,
                cpuSeverity,
                memorySeverity
              )}
              data-testid="terminal-resource-badge"
              data-severity={resourceSeverity}
              data-cpu-severity={cpuSeverity}
              data-memory-severity={memorySeverity}
            >
              <TerminalResourceSparkline
                history={resourceState.cpuHistory}
                className={cn(
                  "shrink-0 transition-colors duration-150",
                  SEVERITY_TONE[cpuSeverity]
                )}
              />
              {/* One block reserved at the width of "10.5 cores · 10.0G" plus any marks
                  showing, slack at its trailing end: the line holds still as
                  digits come and go, and the reading stays tight against the
                  line's end dot. */}
              <span
                className="flex items-center text-text-secondary"
                style={{
                  minWidth: `calc(16ch + 0.5rem + ${
                    [cpuSeverity, memorySeverity].filter((b) => b !== "muted").length
                  } * ${SEVERITY_MARK_WIDTH})`,
                }}
                aria-hidden="true"
              >
                <SeverityMark severity={cpuSeverity} />
                <span>{formatCores(resourceState.cpuPercent / 100)}</span>
                <span className="px-1">·</span>
                <SeverityMark severity={memorySeverity} />
                <span>{formatMemory(resourceState.memoryKb)}</span>
              </span>
            </div>
          </TooltipTrigger>
          <TooltipContent side="bottom" className="max-w-xs">
            <div className="flex flex-col gap-1">
              <div className="font-medium tabular-nums">
                CPU {formatCores(resourceState.cpuPercent / 100)} · Memory{" "}
                {formatMemory(resourceState.memoryKb)}
              </div>
              {resourceState.breakdown.length > 0 && (
                <table className="text-xs tabular-nums">
                  <thead>
                    <tr className="text-text-secondary">
                      <th className="text-left pr-2">PID</th>
                      <th className="text-left pr-3">Name</th>
                      <th className="text-right pr-2">CPU</th>
                      <th className="text-right">Mem</th>
                    </tr>
                  </thead>
                  <tbody>
                    {breakdownRows.map((p) => (
                      <tr key={p.pid}>
                        <td className="pr-2 text-text-secondary">{p.pid}</td>
                        <td className="pr-3 truncate max-w-[8rem]">{p.comm}</td>
                        <td className="text-right pr-2 whitespace-nowrap">
                          {formatCores(p.cpuPercent / 100)}
                        </td>
                        <td className="text-right">{formatMemory(p.memoryKb)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
              {(resourceState.processCount ?? 0) > resourceState.breakdown.length && (
                <span className="tabular-nums text-text-secondary">
                  Showing {resourceState.breakdown.length} of {resourceState.processCount} processes
                </span>
              )}
            </div>
          </TooltipContent>
        </Tooltip>
      )}
    </>
  );
}
