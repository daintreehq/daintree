import { useMemo } from "react";
import { AlertTriangle, Check, Sprout } from "lucide-react";
import type { AgentState, WorktreeState } from "@/types";
import type { PtyPanelData } from "@shared/types/panel";
import { cn } from "@/lib/utils";
import { getWorktreeBranchLabel, getWorktreeHeadline } from "@/lib/worktreeHeadline";
import { getPrStateColor, getPrStateGlyph } from "@/lib/prStateGlyph";
import { getCIStatusVisual } from "@/lib/worktreeCIStatus";
import { deriveTerminalChrome } from "@/utils/terminalChrome";
import { getTerminalAgentDisplayState } from "@/utils/terminalAgentDisplayState";
import { TerminalIcon } from "@/components/Terminal/TerminalIcon";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useWorktreeTerminals } from "@/hooks/useWorktreeTerminals";
import type { ChipState } from "./utils/computeChipState";
import { getBranchTypeIcon } from "./BranchLabel";
import { LiveTimeAgo } from "./LiveTimeAgo";
import { CHIP_LABELS, WorktreeStatusTick } from "./WorktreeCard/WorktreeStatusTick";
import { STATE_COLORS, STATE_ICONS, STATE_LABELS } from "./terminalStateConfig";

/**
 * Column tracks shared by every row, so the columns line up down the list. The
 * worktree column takes what the fixed ones leave: at the palette's overview
 * tier that is ~300px, the sidebar card's own content width, which is what
 * keeps a row's left half reading as the sidebar card it came from.
 */
export const OVERVIEW_ROW_COLUMNS = "grid-cols-[minmax(0,1fr)_144px_88px_36px]";

/** At most this many agent marks before the rest collapse to "+N". */
const MAX_AGENT_MARKS = 3;

/**
 * Which session speaks for the row on its second line. The one that needs the
 * user comes first, then live work; an idle agent only when nothing else is
 * going on.
 */
const LEAD_PRIORITY: Record<AgentState, number> = {
  waiting: 0,
  directing: 1,
  working: 2,
  completed: 3,
  idle: 4,
  exited: 5,
};

interface SessionMark {
  terminal: PtyPanelData;
  chrome: ReturnType<typeof deriveTerminalChrome>;
  state: AgentState | undefined;
}

function useSessionMarks(worktreeId: string): SessionMark[] {
  const { terminals } = useWorktreeTerminals(worktreeId);
  return useMemo(() => {
    const marks = terminals
      .filter((t) => t.location !== "trash")
      .map((terminal) => {
        const chrome = deriveTerminalChrome(terminal);
        return {
          terminal,
          chrome,
          state: getTerminalAgentDisplayState(chrome, terminal.agentState),
        };
      });
    // Agents before plain terminals, then by how much each one needs the user.
    return marks.sort((a, b) => {
      if (a.chrome.isAgent !== b.chrome.isAgent) return a.chrome.isAgent ? -1 : 1;
      const pa = a.state ? LEAD_PRIORITY[a.state] : 9;
      const pb = b.state ? LEAD_PRIORITY[b.state] : 9;
      return pa - pb;
    });
  }, [terminals]);
}

function leadLine(mark: SessionMark | undefined): { text: string; mono: boolean } | null {
  if (!mark) return null;
  const { terminal, chrome } = mark;
  if (chrome.isAgent) {
    const task = terminal.lastObservedTitle?.trim();
    return { text: task || terminal.title, mono: false };
  }
  const command = terminal.lastCommand?.trim();
  return command ? { text: command, mono: true } : { text: terminal.title, mono: false };
}

export interface WorktreeOverviewRowProps {
  worktree: WorktreeState;
  cellId: string;
  chipState: ChipState;
  isCurrent: boolean;
  isSelected: boolean;
  isCursor: boolean;
  /** True while any row is selected: every row shows its checkbox, not its type glyph. */
  isSelecting: boolean;
  isLast: boolean;
  onActivate: (worktreeId: string) => void;
  onToggleSelect: (worktreeId: string, event: React.MouseEvent) => void;
}

export function WorktreeOverviewRow({
  worktree,
  cellId,
  chipState,
  isCurrent,
  isSelected,
  isCursor,
  isSelecting,
  isLast,
  onActivate,
  onToggleSelect,
}: WorktreeOverviewRowProps) {
  const marks = useSessionMarks(worktree.id);
  const headline = getWorktreeHeadline(worktree);
  const branchLabel = getWorktreeBranchLabel(worktree);
  const title =
    headline.kind === "issue" || headline.kind === "pr"
      ? (headline.title ?? branchLabel)
      : worktree.isMainWorktree
        ? worktree.name
        : (branchLabel.split("/").pop() ?? branchLabel);
  const TypeIcon = worktree.isMainWorktree ? Sprout : getBranchTypeIcon(branchLabel);

  const pr = worktree.linked?.pr;
  const showPr = !!pr && pr.state !== "closed" && pr.state !== "declined";
  const PrIcon = showPr ? getPrStateGlyph(pr.state) : null;
  const ci = showPr ? getCIStatusVisual(pr.ciStatus) : null;

  const changes = worktree.worktreeChanges;
  const fileCount = changes?.changedFileCount ?? 0;
  const insertions = changes?.insertions ?? changes?.totalInsertions ?? 0;
  const deletions = changes?.deletions ?? changes?.totalDeletions ?? 0;
  const conflictCount = changes?.changes.filter((c) => c.status === "conflicted").length ?? 0;
  const ahead = worktree.aheadCount ?? 0;
  const behind = worktree.behindCount ?? 0;

  const agentMarks = marks.filter((m) => m.chrome.isAgent);
  const shownMarks = (agentMarks.length > 0 ? agentMarks : marks).slice(0, MAX_AGENT_MARKS);
  const hiddenCount = marks.length - shownMarks.length;
  const lead = leadLine(marks[0]);

  const sessionsLabel = marks
    .map((m) => `${m.chrome.label}${m.state ? ` ${STATE_LABELS[m.state]}` : ""}`)
    .join(", ");

  return (
    <div role="row" className="contents">
      <div
        id={cellId}
        role="gridcell"
        aria-selected={isSelected}
        data-worktree-overview-cell={worktree.id}
        data-overview-cursor={isCursor ? "true" : undefined}
        aria-current={isCurrent ? "true" : undefined}
        onClick={(e) => {
          if (e.metaKey || e.ctrlKey || e.shiftKey) {
            onToggleSelect(worktree.id, e);
            return;
          }
          onActivate(worktree.id);
        }}
        className={cn(
          "group/row relative grid items-center gap-x-4 px-3 py-2.5 cursor-pointer select-none",
          OVERVIEW_ROW_COLUMNS,
          !isLast && "border-b border-divider",
          "transition-colors duration-150 ease-out",
          isSelected ? "bg-overlay-medium" : "hover:bg-overlay-soft",
          // Cursor only while the grid holds focus — see the modal for why.
          isCursor &&
            "group-focus/overview-grid:outline group-focus/overview-grid:outline-2 group-focus/overview-grid:-outline-offset-2 group-focus/overview-grid:outline-accent-primary"
        )}
      >
        {chipState !== null && (
          <Tooltip>
            <TooltipTrigger asChild>
              <WorktreeStatusTick state={chipState} variant="sidebar" />
            </TooltipTrigger>
            <TooltipContent side="right" align="start" className="text-xs">
              {CHIP_LABELS[chipState]}
            </TooltipContent>
          </Tooltip>
        )}

        {/* Worktree: the sidebar card's identity, in the sidebar's words. */}
        <div className="min-w-0">
          <div className="flex items-center gap-2 min-w-0">
            <span className="relative flex h-4 w-4 shrink-0 items-center justify-center">
              {TypeIcon && (
                <TypeIcon
                  className={cn(
                    "h-3.5 w-3.5 text-text-secondary",
                    isSelecting || isSelected ? "hidden" : "group-hover/row:hidden"
                  )}
                  strokeWidth={worktree.isMainWorktree ? 2 : 2.5}
                  aria-hidden="true"
                />
              )}
              <span
                aria-hidden="true"
                data-overview-checkbox=""
                onClick={(e) => {
                  e.stopPropagation();
                  onToggleSelect(worktree.id, e);
                }}
                className={cn(
                  "absolute inset-0 items-center justify-center rounded-[var(--radius-xs)] border",
                  isSelecting || isSelected || !TypeIcon ? "flex" : "hidden group-hover/row:flex",
                  isSelected
                    ? "border-border-interactive bg-overlay-emphasis text-text-primary"
                    : "border-border-default text-transparent hover:border-border-interactive"
                )}
              >
                <Check className="h-3 w-3" strokeWidth={3} />
              </span>
            </span>
            <span
              className={cn(
                "truncate text-sm",
                isCurrent ? "font-medium text-text-primary" : "text-text-primary"
              )}
            >
              {title}
            </span>
            {isCurrent && <span className="shrink-0 text-2xs text-text-secondary">· current</span>}
          </div>
          <div className="mt-0.5 flex items-center gap-2 min-w-0 pl-6 text-2xs text-text-secondary">
            <span className="truncate font-mono">{branchLabel}</span>
            {showPr && PrIcon && (
              <span
                className="flex shrink-0 items-center gap-1"
                aria-label={`Pull request ${pr.ref.number}, ${pr.state}${ci ? `, ${ci.ariaLabel}` : ""}`}
              >
                <PrIcon className={cn("h-3 w-3", getPrStateColor(pr.state))} aria-hidden="true" />
                <span className="font-mono tabular-nums">#{pr.ref.number}</span>
                {ci?.kind === "icon" && (
                  <ci.Icon className={cn("h-3 w-3", ci.colorClass)} aria-hidden="true" />
                )}
                {ci?.kind === "dot" && (
                  <span
                    className={cn("h-1.5 w-1.5 rounded-full", ci.colorClass)}
                    aria-hidden="true"
                  />
                )}
              </span>
            )}
          </div>
        </div>

        {/* Agents: who is in there, in what state, and what the one that needs you is on. */}
        <div className="min-w-0">
          {marks.length > 0 ? (
            <>
              <div className="flex items-center gap-2" role="img" aria-label={sessionsLabel}>
                {shownMarks.map(({ terminal, chrome, state }) => {
                  const StateIcon = state ? STATE_ICONS[state] : null;
                  return (
                    <span key={terminal.id} className="flex items-center gap-1" aria-hidden="true">
                      <TerminalIcon
                        kind={terminal.kind}
                        chrome={chrome}
                        className="h-3 w-3 shrink-0"
                      />
                      {StateIcon && state && (
                        <StateIcon
                          className={cn(
                            "h-3 w-3",
                            STATE_COLORS[state],
                            state === "working" && "animate-spin-slow motion-reduce:animate-none"
                          )}
                        />
                      )}
                    </span>
                  );
                })}
                {hiddenCount > 0 && (
                  <span className="text-2xs tabular-nums text-text-secondary" aria-hidden="true">
                    +{hiddenCount}
                  </span>
                )}
              </div>
              {lead && (
                <div
                  className={cn(
                    "mt-0.5 truncate text-2xs text-text-secondary",
                    lead.mono && "font-mono"
                  )}
                >
                  {lead.text}
                </div>
              )}
            </>
          ) : (
            <span className="text-2xs text-text-secondary">No sessions</span>
          )}
        </div>

        {/* Changes: size of the diff, then its file count and drift from upstream. */}
        <div className="min-w-0 text-right tabular-nums">
          <div className="text-xs text-text-secondary">
            {changes === null ? (
              "—"
            ) : fileCount > 0 ? (
              <>
                <span className="text-text-primary">+{insertions}</span> −{deletions}
              </>
            ) : (
              "Clean"
            )}
          </div>
          {(fileCount > 0 || ahead > 0 || behind > 0) && (
            <div className="mt-0.5 flex items-center justify-end gap-1.5 text-2xs text-text-secondary">
              {conflictCount > 0 ? (
                <span className="flex items-center gap-1 text-status-error">
                  <AlertTriangle className="h-3 w-3" aria-hidden="true" />
                  {conflictCount} conflict{conflictCount === 1 ? "" : "s"}
                </span>
              ) : fileCount > 0 ? (
                <span>
                  {fileCount} file{fileCount === 1 ? "" : "s"}
                </span>
              ) : null}
              {(ahead > 0 || behind > 0) && (
                <span className="font-mono">
                  {ahead > 0 && <span aria-label={`${ahead} ahead`}>↑{ahead}</span>}
                  {ahead > 0 && behind > 0 && " "}
                  {behind > 0 && <span aria-label={`${behind} behind`}>↓{behind}</span>}
                </span>
              )}
            </div>
          )}
        </div>

        {/* Age of the last activity, the sidebar's own clock. */}
        <div className="text-right text-2xs tabular-nums text-text-secondary">
          {worktree.lastActivityTimestamp ? (
            <LiveTimeAgo timestamp={worktree.lastActivityTimestamp} />
          ) : null}
        </div>
      </div>
    </div>
  );
}
