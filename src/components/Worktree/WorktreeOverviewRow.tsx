import { useMemo, useState } from "react";
import {
  AlertTriangle,
  Check,
  ChevronRight,
  CircleDot,
  GitBranch,
  SquareTerminal,
  Sprout,
} from "lucide-react";
import type { AgentState, WorktreeState } from "@/types";
import type { PtyPanelData } from "@shared/types/panel";
import { cn } from "@/lib/utils";
import { PALETTE_SECTION_LABEL_CLASS } from "@/components/ui/paletteRowStyles";
import { getWorktreeBranchLabel, getWorktreeHeadline } from "@/lib/worktreeHeadline";
import { getPrStateColor, getPrStateGlyph } from "@/lib/prStateGlyph";
import { getCIStatusVisual } from "@/lib/worktreeCIStatus";
import { deriveTerminalChrome } from "@/utils/terminalChrome";
import { TerminalIcon } from "@/components/Terminal/TerminalIcon";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { TruncatedTooltip } from "@/components/ui/TruncatedTooltip";
import {
  ContextMenu,
  ContextMenuActionItem,
  ContextMenuContent,
  ContextMenuLabel,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { useWorktreeTerminals } from "@/hooks/useWorktreeTerminals";
import { actionService } from "@/services/ActionService";
import { getAgentConfig } from "@/config/agents";
import type { ChipState } from "./utils/computeChipState";
import { BranchLabel } from "./BranchLabel";
import { LiveTimeAgo } from "./LiveTimeAgo";
import { SECTION_ROW } from "./WorktreeCard/sectionChrome";
import { CHIP_LABELS, WorktreeStatusTick } from "./WorktreeCard/WorktreeStatusTick";
import {
  STATE_COLORS,
  STATE_ICONS,
  STATE_LABELS,
  summarizeSessionStates,
} from "./terminalStateConfig";
import { ActivityLight } from "./ActivityLight";
import { CollapsedSessionIndicators } from "./WorktreeCard/CollapsedSessionIndicators";

/**
 * Column tracks shared by the header and every row, so each section sits on
 * one vertical axis down the list. The worktree section takes what the fixed
 * ones leave — at the workspace tier a little wider than the sidebar card
 * itself, which is what keeps a row's left half reading as that card.
 */
export const OVERVIEW_ROW_COLUMNS = "grid-cols-[minmax(0,1fr)_232px_104px_48px]";
const OVERVIEW_ROW_GAP = "gap-x-5";
const OVERVIEW_ROW_INSET = "px-4";

/**
 * Names the sections once, above the list, in the palette's section-label
 * type — so the columns read as labelled zones rather than a spreadsheet, and
 * nobody has to decode a column from its contents.
 */
export function WorktreeOverviewColumnHeaders() {
  return (
    <div
      aria-hidden="true"
      className={cn(
        "grid shrink-0 items-end py-1.5 border-b border-divider",
        OVERVIEW_ROW_COLUMNS,
        OVERVIEW_ROW_GAP,
        OVERVIEW_ROW_INSET,
        PALETTE_SECTION_LABEL_CLASS
      )}
    >
      <span className="pl-6">Worktree</span>
      <span>Sessions</span>
      <span className="text-right">Changes</span>
      <span className="text-right">Active</span>
    </div>
  );
}

/**
 * Sessions listed in full before the row collapses them to the sidebar's
 * "N active" trigger. Three keeps a busy row to the height of three session
 * lines, which is the tallest a row gets without a click.
 */
const MAX_INLINE_SESSIONS = 3;

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
        // The raw state, not the compact indicator's coerced one: that helper
        // reads idle and completed as waiting, which put amber circles on rows
        // the Attention count beside them did not include.
        const state = chrome.isAgent && !chrome.hasExited ? terminal.agentState : undefined;
        return { terminal, chrome, state };
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

/**
 * One session, as the sidebar's session row draws it: its icon, what it is on,
 * and its state. A button — clicking a session goes straight to it, not to the
 * worktree — and F2 reaches it from the list. Idle and exited agents name their
 * state in words; they have no glyph in the shared vocabulary.
 */
function SessionLine({ mark, onBeforeOpen }: { mark: SessionMark; onBeforeOpen: () => void }) {
  const line = leadLine(mark);
  const text = line?.text ?? mark.chrome.label;
  const Glyph =
    mark.state && mark.state !== "idle" && mark.state !== "exited" ? STATE_ICONS[mark.state] : null;
  const quietState = mark.chrome.hasExited
    ? "exited"
    : mark.chrome.isAgent && (mark.state === "idle" || mark.state === undefined)
      ? "idle"
      : null;
  return (
    <TruncatedTooltip content={text}>
      <button
        type="button"
        // Out of the tab order: the list is one tab stop, and F2 enters a row.
        tabIndex={-1}
        onClick={(e) => {
          e.stopPropagation();
          onBeforeOpen();
          void actionService.dispatch(
            "panel.focus",
            { panelId: mark.terminal.id },
            { source: "user" }
          );
        }}
        aria-label={`${mark.chrome.label}${mark.state ? `, ${STATE_LABELS[mark.state]}` : ""}: ${text}`}
        className={cn(
          "flex h-5 w-full min-w-0 items-center gap-1.5 rounded-[var(--radius-sm)] text-left",
          "text-text-secondary hover:text-text-primary transition-colors",
          "focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent-primary"
        )}
      >
        <TerminalIcon kind={mark.terminal.kind} chrome={mark.chrome} className="h-3 w-3 shrink-0" />
        <span className={cn("min-w-0 flex-1 truncate text-xs", line?.mono && "font-mono text-2xs")}>
          {text}
        </span>
        {Glyph && mark.state && (
          <Glyph
            className={cn(
              "h-3 w-3 shrink-0",
              STATE_COLORS[mark.state],
              mark.state === "working" && "animate-spin-slow motion-reduce:animate-none"
            )}
            aria-hidden="true"
          />
        )}
        {quietState && (
          <span className="shrink-0 text-3xs text-text-secondary" aria-hidden="true">
            {quietState}
          </span>
        )}
      </button>
    </TruncatedTooltip>
  );
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
  /** Called as a context-menu action starts, so the overview gets out of its way. */
  onBeforeMenuAction: () => void;
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
  onBeforeMenuAction,
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
  // The sidebar card's headline glyph: the sprout for main, the issue mark for
  // an issue's worktree, the PR glyph for one made from a PR, and the branch
  // for a bare branch — whose name then IS the title, set in mono as the
  // sidebar sets it. The branch's own type mark rides with the branch line.
  const isBranchTitled =
    !worktree.isMainWorktree && headline.kind !== "issue" && headline.kind !== "pr";
  const headlinePr = headline.kind === "pr" ? worktree.linked?.pr : undefined;
  const TypeIcon = worktree.isMainWorktree
    ? Sprout
    : headline.kind === "issue"
      ? CircleDot
      : headline.kind === "pr"
        ? getPrStateGlyph(headlinePr?.state)
        : GitBranch;
  const typeIconColor =
    headline.kind === "issue"
      ? "text-pr-open"
      : headline.kind === "pr"
        ? getPrStateColor(headlinePr?.state)
        : "text-text-secondary";

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

  const [sessionsExpanded, setSessionsExpanded] = useState(false);
  // Counted from the same raw states the listed rows draw, so the trigger's
  // pips and the rows it expands to can never disagree.
  const sessionSummary = useMemo(() => {
    const byState: Record<AgentState, number> = {
      working: 0,
      waiting: 0,
      directing: 0,
      idle: 0,
      completed: 0,
      exited: 0,
    };
    for (const mark of marks) if (mark.state) byState[mark.state] += 1;
    return summarizeSessionStates(byState, marks.length);
  }, [marks]);

  // The strip's glyph is the sidebar's: the agent's own mark when every
  // session is the same agent, a terminal otherwise.
  const SummaryIcon = useMemo(() => {
    let commonId: string | null = null;
    for (const mark of marks) {
      const id = mark.chrome.agentId;
      if (!id) return SquareTerminal;
      if (commonId === null) commonId = id;
      else if (id !== commonId) return SquareTerminal;
    }
    return (commonId && getAgentConfig(commonId)?.icon) || SquareTerminal;
  }, [marks]);

  // The one exception the row leads with, beside the title: the things that
  // need a human, which a 12px mark inside another section let slide past.
  const ciFailed = showPr && pr.ciStatus?.state === "failure";
  const exception =
    conflictCount > 0
      ? `${conflictCount} conflict${conflictCount === 1 ? "" : "s"}`
      : ciFailed
        ? "CI failed"
        : null;

  const sessionLines = marks.map((m) => ({
    id: m.terminal.id,
    name: `${m.chrome.label}${m.state ? `, ${STATE_LABELS[m.state]}` : ""}`,
    detail: leadLine(m)?.text,
  }));
  const sessionsLabel = sessionLines
    .map((l) => (l.detail && l.detail !== l.name ? `${l.name}: ${l.detail}` : l.name))
    .join("; ");

  const menuArgs = { worktreeId: worktree.id };

  return (
    <div role="row" className="contents">
      <ContextMenu>
        <ContextMenuTrigger asChild>
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
              // Top-aligned: every section is a headline over a detail line, so
              // the headlines share one baseline across the row.
              "group/row relative grid items-start py-3 cursor-pointer select-none",
              OVERVIEW_ROW_COLUMNS,
              OVERVIEW_ROW_GAP,
              OVERVIEW_ROW_INSET,
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
              <div className="flex h-5 items-center gap-2 min-w-0">
                <span className="relative flex h-4 w-4 shrink-0 items-center justify-center">
                  {TypeIcon && (
                    <TypeIcon
                      className={cn(
                        "h-3.5 w-3.5",
                        typeIconColor,
                        isSelecting || isSelected
                          ? "hidden"
                          : cn(
                              "group-hover/row:hidden",
                              isCursor && "group-focus/overview-grid:hidden"
                            )
                      )}
                      strokeWidth={2}
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
                      isSelecting || isSelected || !TypeIcon
                        ? "flex"
                        : cn(
                            "hidden group-hover/row:flex",
                            isCursor && "group-focus/overview-grid:flex"
                          ),
                      isSelected
                        ? "border-border-interactive bg-overlay-emphasis text-text-primary"
                        : "border-border-default text-transparent hover:border-border-interactive"
                    )}
                  >
                    <Check className="h-3 w-3" strokeWidth={3} />
                  </span>
                </span>
                <TruncatedTooltip content={title}>
                  <span
                    className={cn(
                      "truncate text-text-primary",
                      isBranchTitled ? "font-mono text-xs" : "text-sm",
                      isCurrent && "font-medium"
                    )}
                  >
                    {title}
                  </span>
                </TruncatedTooltip>
                {isCurrent && (
                  <span className="shrink-0 rounded-[var(--radius-xs)] border border-border-default px-1 text-3xs leading-4 text-text-secondary">
                    Current
                  </span>
                )}
                {exception && (
                  <span className="flex shrink-0 items-center gap-1 text-2xs font-medium text-status-error">
                    <AlertTriangle className="h-3.5 w-3.5" aria-hidden="true" />
                    {exception}
                  </span>
                )}
              </div>
              <div className="mt-1 flex items-center gap-2 min-w-0 pl-6 text-2xs text-text-secondary">
                {!isBranchTitled && (
                  <BranchLabel
                    label={branchLabel}
                    isActive={isCurrent}
                    // The row's headline already is the main worktree's name; its
                    // branch sits on the detail line at detail size.
                    isMainWorktree={false}
                    className="min-w-0"
                  />
                )}
                {showPr && PrIcon && (
                  <span
                    className="flex shrink-0 items-center gap-1"
                    aria-label={`Pull request ${pr.ref.number}, ${pr.state}${ci ? `, ${ci.ariaLabel}` : ""}`}
                  >
                    <PrIcon
                      className={cn("h-3 w-3", getPrStateColor(pr.state))}
                      aria-hidden="true"
                    />
                    <span className={cn("font-mono tabular-nums", getPrStateColor(pr.state))}>
                      #{pr.ref.number}
                    </span>
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

            {/* Sessions, as the sidebar draws them. Up to three are listed in
                full — icon, what it is on, state — like the sidebar's session
                rows; past that the row collapses to the sidebar's own
                "N active" strip with its state counts, and expands in place. */}
            <div className="min-w-0" role="group" aria-label={sessionsLabel || "No sessions"}>
              {marks.length === 0 ? (
                <span className="text-xs leading-5 text-text-secondary" aria-hidden="true">
                  —
                </span>
              ) : marks.length <= MAX_INLINE_SESSIONS ? (
                marks.map((mark) => (
                  <SessionLine
                    key={mark.terminal.id}
                    mark={mark}
                    onBeforeOpen={onBeforeMenuAction}
                  />
                ))
              ) : (
                <div className="rounded-[var(--radius-lg)] border border-border-default bg-overlay-soft">
                  <button
                    type="button"
                    tabIndex={-1}
                    aria-expanded={sessionsExpanded}
                    aria-label={`${marks.length} active sessions${sessionSummary.breakdown ? `: ${sessionSummary.breakdown}` : ""}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      setSessionsExpanded((v) => !v);
                    }}
                    className={cn(
                      "justify-between gap-2 transition-colors",
                      "focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent-primary",
                      SECTION_ROW
                    )}
                  >
                    <span className="flex items-center gap-1.5 text-2xs text-text-secondary">
                      <ChevronRight
                        className={cn(
                          "h-3 w-3 shrink-0 transition-transform duration-150",
                          sessionsExpanded && "rotate-90"
                        )}
                        aria-hidden="true"
                      />
                      <SummaryIcon className="h-3 w-3 shrink-0" aria-hidden="true" />
                      <span className="inline-flex items-center gap-1">
                        <span className="font-mono tabular-nums">{marks.length}</span>
                        <span>active</span>
                      </span>
                    </span>
                    {sessionSummary.visibleStates.length > 0 && (
                      <CollapsedSessionIndicators
                        visibleStates={sessionSummary.visibleStates}
                        sessionAriaLabel={sessionSummary.label}
                      />
                    )}
                  </button>
                  {sessionsExpanded && (
                    // Children indent under the strip's own icon, as the
                    // sidebar's expanded rows sit under its trigger.
                    <div className="pb-1 pl-[22px] pr-2.5">
                      {marks.map((mark) => (
                        <SessionLine
                          key={mark.terminal.id}
                          mark={mark}
                          onBeforeOpen={onBeforeMenuAction}
                        />
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* Changes, in the sidebar's own words and colours: +added/-removed
                in the success and error inks, then the file count and drift. */}
            <div className="min-w-0 text-right tabular-nums">
              <div className="text-xs leading-5 text-text-secondary">
                {changes === null ? (
                  "—"
                ) : fileCount > 0 && (insertions > 0 || deletions > 0) ? (
                  <span className="inline-flex items-center gap-0.5">
                    {insertions > 0 && <span className="text-status-success">+{insertions}</span>}
                    {insertions > 0 && deletions > 0 && <span className="text-text-muted">/</span>}
                    {deletions > 0 && <span className="text-status-error">-{deletions}</span>}
                  </span>
                ) : fileCount > 0 ? (
                  `${fileCount} file${fileCount === 1 ? "" : "s"}`
                ) : (
                  "Clean"
                )}
              </div>
              {((fileCount > 0 && (insertions > 0 || deletions > 0)) ||
                ahead > 0 ||
                behind > 0) && (
                <div className="mt-1 flex items-center justify-end gap-1.5 text-2xs text-text-secondary">
                  {fileCount > 0 && (insertions > 0 || deletions > 0) && (
                    <span>
                      {fileCount} file{fileCount === 1 ? "" : "s"}
                    </span>
                  )}
                  {(ahead > 0 || behind > 0) && (
                    <span className="font-mono">
                      {ahead > 0 && (
                        <span className="text-status-success" aria-label={`${ahead} ahead`}>
                          ↑{ahead}
                        </span>
                      )}
                      {ahead > 0 && behind > 0 && " "}
                      {behind > 0 && (
                        <span className="text-status-warning" aria-label={`${behind} behind`}>
                          ↓{behind}
                        </span>
                      )}
                    </span>
                  )}
                </div>
              )}
            </div>

            {/* Age of the last activity, with the sidebar's recency light. */}
            <div className="flex h-5 items-center justify-end gap-1.5 text-xs tabular-nums text-text-secondary">
              {worktree.lastActivityTimestamp ? (
                <>
                  <ActivityLight
                    lastActivityTimestamp={worktree.lastActivityTimestamp}
                    className="h-1.5 w-1.5 shrink-0"
                  />
                  <LiveTimeAgo timestamp={worktree.lastActivityTimestamp} />
                </>
              ) : null}
            </div>
          </div>
        </ContextMenuTrigger>
        <ContextMenuContent className="max-w-[360px]">
          {/* The sessions, in full, each a way straight into its terminal. This is
              also where a keyboard user reads what the row's tooltip shows on
              hover: Shift+F10 on the cursor row opens this menu. */}
          {sessionLines.length > 0 && (
            <>
              <ContextMenuLabel>Sessions</ContextMenuLabel>
              {sessionLines.map((line) => (
                <ContextMenuActionItem
                  key={line.id}
                  actionId="panel.focus"
                  args={{ panelId: line.id }}
                  onSelect={onBeforeMenuAction}
                >
                  <span className="flex min-w-0 flex-col">
                    <span className="whitespace-normal break-words">{line.name}</span>
                    {line.detail && line.detail !== line.name && (
                      <span className="whitespace-normal break-words text-2xs text-text-secondary">
                        {line.detail}
                      </span>
                    )}
                  </span>
                </ContextMenuActionItem>
              ))}
              <ContextMenuSeparator />
            </>
          )}
          <ContextMenuActionItem
            actionId="worktree.openEditor"
            args={menuArgs}
            onSelect={onBeforeMenuAction}
          >
            Open in editor
          </ContextMenuActionItem>
          <ContextMenuActionItem
            actionId="worktree.reveal"
            args={menuArgs}
            onSelect={onBeforeMenuAction}
          >
            Reveal in Finder
          </ContextMenuActionItem>
          <ContextMenuActionItem
            actionId="worktree.openReviewHub"
            args={menuArgs}
            onSelect={onBeforeMenuAction}
          >
            Open review hub
          </ContextMenuActionItem>
          {(showPr || worktree.issueNumber) && <ContextMenuSeparator />}
          {showPr && (
            <ContextMenuActionItem
              actionId="worktree.openPR"
              args={menuArgs}
              onSelect={onBeforeMenuAction}
            >
              Open pull request
            </ContextMenuActionItem>
          )}
          {worktree.issueNumber && (
            <ContextMenuActionItem
              actionId="worktree.openIssue"
              args={menuArgs}
              onSelect={onBeforeMenuAction}
            >
              Open issue
            </ContextMenuActionItem>
          )}
          <ContextMenuSeparator />
          <ContextMenuActionItem actionId="worktree.copyContext" args={menuArgs}>
            Copy context
          </ContextMenuActionItem>
        </ContextMenuContent>
      </ContextMenu>
    </div>
  );
}
