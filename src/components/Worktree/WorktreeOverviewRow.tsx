import { useMemo } from "react";
import { AlertTriangle, Check, Sprout } from "lucide-react";
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
import type { ChipState } from "./utils/computeChipState";
import { getBranchTypeIcon } from "./BranchLabel";
import { LiveTimeAgo } from "./LiveTimeAgo";
import { CHIP_LABELS, WorktreeStatusTick } from "./WorktreeCard/WorktreeStatusTick";
import { STATE_COLORS, STATE_ICONS, STATE_LABELS } from "./terminalStateConfig";

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
      <span>Agents</span>
      <span className="text-right">Changes</span>
      <span className="text-right">Active</span>
    </div>
  );
}

/** Beyond the lead session, at most this many compact marks before "+N". */
const MAX_SECONDARY_MARKS = 2;

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

  const leadMark = marks[0];
  const lead = leadLine(leadMark);
  const LeadStateIcon =
    leadMark?.state && leadMark.state !== "idle" && leadMark.state !== "exited"
      ? STATE_ICONS[leadMark.state]
      : null;
  const secondaryMarks = marks.slice(1, 1 + MAX_SECONDARY_MARKS);
  const overflowCount = marks.length - 1 - secondaryMarks.length;

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
                        "h-3.5 w-3.5 text-text-secondary",
                        isSelecting || isSelected
                          ? "hidden"
                          : cn(
                              "group-hover/row:hidden",
                              isCursor && "group-focus/overview-grid:hidden"
                            )
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
                      "truncate text-sm",
                      isCurrent ? "font-medium text-text-primary" : "text-text-primary"
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
                <span className="truncate font-mono">{branchLabel}</span>
                {showPr && PrIcon && (
                  <span
                    className="flex shrink-0 items-center gap-1"
                    aria-label={`Pull request ${pr.ref.number}, ${pr.state}${ci ? `, ${ci.ariaLabel}` : ""}`}
                  >
                    <PrIcon
                      className={cn("h-3 w-3", getPrStateColor(pr.state))}
                      aria-hidden="true"
                    />
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
            {marks.length > 0 ? (
              <Tooltip>
                <TooltipTrigger asChild>
                  <div className="min-w-0">
                    {/* The session that needs you most, in words: who, and what state.
                        A cluster of bare glyphs asked the reader to decode every
                        row; the rest of the sessions are a count and a hover away. */}
                    <div
                      className="flex h-5 items-center gap-1.5 min-w-0 text-xs"
                      role="img"
                      aria-label={sessionsLabel}
                    >
                      {leadMark && (
                        <TerminalIcon
                          kind={leadMark.terminal.kind}
                          chrome={leadMark.chrome}
                          className="h-3.5 w-3.5 shrink-0"
                        />
                      )}
                      <span className="truncate text-text-primary" aria-hidden="true">
                        {leadMark?.chrome.label}
                      </span>
                      {leadMark?.state && (
                        <span
                          className="flex shrink-0 items-center gap-1 text-text-secondary"
                          aria-hidden="true"
                        >
                          {LeadStateIcon && (
                            <LeadStateIcon
                              className={cn(
                                "h-3 w-3",
                                STATE_COLORS[leadMark.state],
                                leadMark.state === "working" &&
                                  "animate-spin-slow motion-reduce:animate-none"
                              )}
                            />
                          )}
                          {STATE_LABELS[leadMark.state]}
                        </span>
                      )}
                      {/* The others, as the sidebar draws them: who, and in
                          what state — so "+1" never hides whether the second
                          session is an agent at work or a plain shell. */}
                      {secondaryMarks.length > 0 && (
                        <span
                          className="ml-1 flex shrink-0 items-center gap-2 border-l border-divider pl-2"
                          aria-hidden="true"
                        >
                          {secondaryMarks.map(({ terminal, chrome, state }) => {
                            const Glyph =
                              state && state !== "idle" && state !== "exited"
                                ? STATE_ICONS[state]
                                : null;
                            return (
                              <span key={terminal.id} className="flex items-center gap-0.5">
                                <TerminalIcon
                                  kind={terminal.kind}
                                  chrome={chrome}
                                  className="h-3 w-3 shrink-0"
                                />
                                {Glyph && state && (
                                  <Glyph
                                    className={cn(
                                      "h-3 w-3",
                                      STATE_COLORS[state],
                                      state === "working" &&
                                        "animate-spin-slow motion-reduce:animate-none"
                                    )}
                                  />
                                )}
                              </span>
                            );
                          })}
                        </span>
                      )}
                      {overflowCount > 0 && (
                        <span
                          className="shrink-0 tabular-nums text-text-secondary"
                          aria-hidden="true"
                        >
                          +{overflowCount}
                        </span>
                      )}
                    </div>
                    {lead && (
                      <div
                        className={cn(
                          "mt-1 truncate pl-5 text-2xs text-text-secondary",
                          lead.mono && "font-mono"
                        )}
                      >
                        {lead.text}
                      </div>
                    )}
                  </div>
                </TooltipTrigger>
                <TooltipContent side="bottom" align="start" className="max-w-[360px] text-xs">
                  <ul className="flex flex-col gap-1">
                    {sessionLines.map((line) => (
                      <li key={line.id}>
                        <span className="text-text-primary">{line.name}</span>
                        {line.detail && line.detail !== line.name && (
                          <span className="block text-text-secondary">{line.detail}</span>
                        )}
                      </li>
                    ))}
                  </ul>
                </TooltipContent>
              </Tooltip>
            ) : (
              <span className="text-xs text-text-secondary" aria-label="No sessions">
                —
              </span>
            )}

            {/* Changes: size of the diff, then its file count and drift from upstream. */}
            <div className="min-w-0 text-right tabular-nums">
              <div className="text-xs leading-5 text-text-secondary">
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
                <div className="mt-1 flex items-center justify-end gap-1.5 text-2xs text-text-secondary">
                  {fileCount > 0 && (
                    <span>
                      {fileCount} file{fileCount === 1 ? "" : "s"}
                    </span>
                  )}
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
            <div className="text-right text-xs leading-5 tabular-nums text-text-secondary">
              {worktree.lastActivityTimestamp ? (
                <LiveTimeAgo timestamp={worktree.lastActivityTimestamp} />
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
