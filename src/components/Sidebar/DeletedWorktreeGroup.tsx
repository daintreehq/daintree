import { useCallback, useMemo } from "react";
import {
  ChevronRight,
  FolderX,
  GripVertical,
  PanelBottom,
  PanelTopClose,
  Trash2,
} from "lucide-react";
import { SortableContext, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { cn } from "@/lib/utils";
import { usePanelStore } from "@/store/panelStore";
import {
  getDeletedWorktreeTerminalIds,
  useWorktreeSelectionStore,
  type DeletedWorktree,
} from "@/store/worktreeStore";
import {
  useTerminalPendingDestructiveActionStore,
  type DestructivePreviewGroup,
} from "@/store/terminalPendingDestructiveActionStore";
import { DeletedWorktreeCard } from "./DeletedWorktreeCard";
import { TerminalIcon } from "@/components/Terminal/TerminalIcon";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  SortableWorktreeTerminal,
  getAccordionDragId,
} from "@/components/DragDrop/SortableWorktreeTerminal";
import { useDragHandle } from "@/components/DragDrop/DragHandleContext";
import { deriveTerminalChrome } from "@/utils/terminalChrome";
import { getTerminalAgentDisplayState } from "@/utils/terminalAgentDisplayState";
import {
  STATE_LABELS,
  getEffectiveStateColor,
  getEffectiveStateIcon,
} from "@/components/Worktree/terminalStateConfig";
import { buildDestructivePreview } from "@/utils/destructiveSessionConfirm";
import { isPtyPanel, type PanelInstance, type PtyPanelData } from "@shared/types/panel";
import { useDeletedWorktreeCountdown } from "./useDeletedWorktreeCountdown";

interface GroupMember {
  worktree: DeletedWorktree;
  /**
   * Everything clearing this member would trash. Mirrors
   * `getDeletedWorktreeTerminalIds` (and so `bulkTrashByWorktree`) without
   * narrowing by kind — previewing only the PTY panels would under-report what
   * the confirm is about to close, which is the #9699 mismatch class and a D2
   * consent violation besides.
   */
  panels: PanelInstance[];
  /** The rescuable subset — only a terminal can ride the accordion drag. */
  terminals: PtyPanelData[];
}

interface DeletedWorktreeGroupProps {
  worktrees: DeletedWorktree[];
}

/**
 * Collapsed summary standing in for several deleted-worktree rows at once
 * (#11260). A burst of deletions used to render one full-height ghost card per
 * worktree, each with its own countdown and trash button; grouped-by-type mode
 * piled all of them at the end.
 *
 * Collapsed, the group is one row plus a rail of every surviving terminal,
 * filed under the worktree it came from with that worktree's own countdown.
 * The rail is not decoration: dragging a terminal onto a live worktree is the
 * direct way to rescue an agent session (the pane's "Move to worktree" is the
 * other), and a summary that unmounted its terminals would take that away
 * exactly when the rows are hardest to read.
 * Each chip is a real `SortableWorktreeTerminal`, so it emits the same
 * `origin: "accordion"` drag data a card's terminal row does and `DndProvider`
 * needs no knowledge of this component at all.
 */
export function DeletedWorktreeGroup({ worktrees }: DeletedWorktreeGroupProps) {
  const panelsById = usePanelStore((s) => s.panelsById);
  const panelIdsByWorktreeId = usePanelStore((s) => s.panelIdsByWorktreeId);
  const setFocused = usePanelStore((s) => s.setFocused);
  const openDockTerminal = usePanelStore((s) => s.openDockTerminal);
  const pingTerminal = usePanelStore((s) => s.pingTerminal);
  const isExpanded = useWorktreeSelectionStore((s) => s.deletedWorktreeGroupExpanded);
  const toggleExpanded = useWorktreeSelectionStore((s) => s.toggleDeletedWorktreeGroupExpanded);
  const selectWorktree = useWorktreeSelectionStore((s) => s.selectWorktree);
  const trackTerminalFocus = useWorktreeSelectionStore((s) => s.trackTerminalFocus);
  const requestDestructiveAction = useTerminalPendingDestructiveActionStore((s) => s.request);

  // Membership is derived, never snapshotted: a terminal rescued out of the
  // group shrinks it the same way it shrinks a single card (#11232).
  const members = useMemo<GroupMember[]>(() => {
    void panelIdsByWorktreeId;
    return worktrees.map((worktree) => {
      const panels = getDeletedWorktreeTerminalIds(worktree.id)
        .map((id) => panelsById[id])
        .filter((panel): panel is PanelInstance => panel != null);
      return { worktree, panels, terminals: panels.filter(isPtyPanel) };
    });
  }, [worktrees, panelsById, panelIdsByWorktreeId]);

  const terminalCount = members.reduce((n, m) => n + m.panels.length, 0);

  const handleClearAll = useCallback(() => {
    const preview: DestructivePreviewGroup[] = members
      .filter((m) => m.panels.length > 0)
      .flatMap((m) => buildDestructivePreview(m.panels, () => m.worktree.title));
    if (preview.length === 0) return;
    const previewedTerminals = preview.reduce((n, entry) => n + entry.terminals.length, 0);
    requestDestructiveAction({
      kind: "deletedWorktreeGroupDismiss",
      targetCount: previewedTerminals,
      runningAgentCount: preview.reduce(
        (n, entry) => n + entry.terminals.filter((t) => t.hasRunningAgent).length,
        0
      ),
      preview,
    });
  }, [members, requestDestructiveAction]);

  const handleTerminalSelect = useCallback(
    (terminal: PtyPanelData) => {
      if (terminal.worktreeId) {
        trackTerminalFocus(terminal.worktreeId, terminal.id);
        selectWorktree(terminal.worktreeId, { source: "focus" });
      }
      if (terminal.location === "dock") {
        openDockTerminal(terminal.id);
      } else {
        setFocused(terminal.id);
      }
      pingTerminal(terminal.id);
    },
    [trackTerminalFocus, selectWorktree, openDockTerminal, setFocused, pingTerminal]
  );

  // Defensive: SidebarContent only builds a group above the threshold, and the
  // store prunes rows whose last terminal left. Bailing keeps a torn frame from
  // rendering an empty summary.
  if (terminalCount === 0) return null;

  const worktreeNoun = members.length === 1 ? "deleted worktree" : "deleted worktrees";
  const terminalNoun = terminalCount === 1 ? "terminal" : "terminals";
  // Same verb as a single card's dismiss — the group only changes the scope.
  const clearLabel = `Close ${terminalCount} ${terminalNoun}`;

  return (
    <div className="border-b border-border-default" data-testid="deleted-worktree-group">
      {/* Columns match a live card's header: the chevron takes the drag-grip
          gutter, FolderX sits on the branch-icon column (16px) and the label
          on the branch-name column (36px). */}
      <div className="flex items-center gap-2 pl-0.5 pr-4 py-2.5">
        <button
          type="button"
          onClick={toggleExpanded}
          aria-expanded={isExpanded}
          className="group/summary flex min-w-0 flex-1 items-center gap-0.5 rounded-[var(--radius-md)] text-left outline-hidden focus-visible:outline-solid focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent-primary"
        >
          <ChevronRight
            data-animated-chevron
            className={cn(
              "w-3 h-3 shrink-0 text-text-secondary transition-transform duration-150 ease-out",
              isExpanded && "rotate-90"
            )}
            aria-hidden="true"
          />
          <span className="flex min-w-0 flex-1 items-center gap-1.5">
            <FolderX
              className="w-3.5 h-3.5 shrink-0 text-text-secondary"
              strokeWidth={2.5}
              aria-hidden="true"
            />
            <span className="truncate text-xs font-medium text-text-secondary transition-colors duration-150 group-hover/summary:text-text-primary">
              {members.length} {worktreeNoun}
            </span>
            <span className="sr-only">, </span>
            <span className="shrink-0 text-2xs tabular-nums text-text-secondary">
              {terminalCount} {terminalNoun}
            </span>
          </span>
        </button>
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              onClick={handleClearAll}
              className="sidebar-action-button shrink-0 rounded-[var(--radius-md)] p-1.5 -my-1.5 text-text-secondary transition-colors hover:text-status-error focus-visible:text-status-error focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-primary"
              aria-label={clearLabel}
            >
              <Trash2 className="w-3.5 h-3.5" aria-hidden="true" />
            </button>
          </TooltipTrigger>
          <TooltipContent side="top">{clearLabel}</TooltipContent>
        </Tooltip>
      </div>

      {isExpanded ? (
        members.map(({ worktree }) => (
          <DeletedWorktreeCard key={worktree.id} worktree={worktree} showDismissAction={false} />
        ))
      ) : (
        <SortableContext
          id="deleted-worktree-group-rail"
          items={members.flatMap((m) => m.terminals.map((t) => getAccordionDragId(t.id)))}
          strategy={verticalListSortingStrategy}
        >
          <div className="flex flex-col gap-2 pb-3 pl-7.5 pr-4">
            {members.map(({ worktree, terminals }) =>
              terminals.length === 0 ? null : (
                <DeletedWorktreeRailMember
                  key={worktree.id}
                  worktree={worktree}
                  terminals={terminals}
                  onSelect={handleTerminalSelect}
                />
              )
            )}
          </div>
        </SortableContext>
      )}
    </div>
  );
}

interface DeletedWorktreeRailMemberProps {
  worktree: DeletedWorktree;
  terminals: PtyPanelData[];
  onSelect: (terminal: PtyPanelData) => void;
}

/**
 * One member's terminals in the collapsed rail, under the worktree they came
 * from. Several agents often share a title ("Claude"), so without the name a
 * chip cannot say which session it is; and the countdown lives here rather
 * than on the summary row because members expire — and hold — independently.
 */
function DeletedWorktreeRailMember({
  worktree,
  terminals,
  onSelect,
}: DeletedWorktreeRailMemberProps) {
  const { hasCountdown, hold, remainingSeconds } = useDeletedWorktreeCountdown(worktree);
  const listLabel = `Terminals from deleted worktree ${worktree.title}`;

  return (
    <div data-deleted-worktree-member={worktree.id}>
      <div className="flex min-h-5 items-center gap-2 pl-1.5">
        <span
          className="min-w-0 flex-1 truncate font-mono text-2xs text-text-secondary"
          title={worktree.title}
        >
          {worktree.title}
        </span>
        {hold !== undefined && (
          <Tooltip>
            <TooltipTrigger asChild>
              <span
                className="shrink-0 rounded-full bg-overlay-soft px-1.5 py-0.5 text-3xs font-medium text-text-secondary"
                data-testid="deleted-worktree-member-hold"
                data-hold-reason={worktree.holdReason}
              >
                {hold.label}
              </span>
            </TooltipTrigger>
            <TooltipContent side="top">{hold.tooltip}</TooltipContent>
          </Tooltip>
        )}
        {hasCountdown && (
          <span
            role="timer"
            aria-label={
              hold !== undefined
                ? `${hold.tooltip}, holding at ${remainingSeconds} seconds`
                : `Closes automatically in ${remainingSeconds} seconds`
            }
            className="shrink-0 font-mono text-2xs tabular-nums text-text-secondary"
            data-testid="deleted-worktree-member-countdown"
          >
            {remainingSeconds}s
          </span>
        )}
      </div>
      <div role="list" aria-label={listLabel} className="flex flex-col">
        {terminals.map((terminal, index) => (
          <SortableWorktreeTerminal
            key={terminal.id}
            terminal={terminal}
            worktreeId={worktree.id}
            sourceIndex={index}
          >
            <DeletedWorktreeTerminalChip
              terminal={terminal}
              worktreeTitle={worktree.title}
              onSelect={onSelect}
            />
          </SortableWorktreeTerminal>
        ))}
      </div>
    </div>
  );
}

interface DeletedWorktreeTerminalChipProps {
  terminal: PtyPanelData;
  worktreeTitle: string;
  onSelect: (terminal: PtyPanelData) => void;
}

/**
 * One rescuable terminal in the collapsed rail. Built from the live
 * `WorktreeTerminalSection` row's parts — the same grip, glyph, type and
 * trailing state mark — but deliberately thinner: no fleet arming, no marquee
 * selection, because the rail exists to keep the drag source reachable and
 * legible, not to reproduce a live worktree's accordion.
 */
function DeletedWorktreeTerminalChip({
  terminal,
  worktreeTitle,
  onSelect,
}: DeletedWorktreeTerminalChipProps) {
  const dragHandle = useDragHandle();
  const chrome = deriveTerminalChrome(terminal);
  const agentState = getTerminalAgentDisplayState(chrome, terminal.agentState);
  const StateIcon = agentState ? getEffectiveStateIcon(agentState) : null;
  const label = `${terminal.title} in deleted worktree ${worktreeTitle}`;
  const placementLabel = terminal.location === "dock" ? "Docked" : "On grid";
  const description = agentState
    ? `${STATE_LABELS[agentState]}, ${placementLabel.toLowerCase()}`
    : placementLabel;

  // No `role="listitem"` here — `SortableWorktreeTerminal` already provides one
  // around this chip, and nesting a second announces every entry twice.
  return (
    <div className="group/chip flex items-center rounded-[var(--radius-lg)] transition-colors duration-150 hover:bg-overlay-subtle">
      <button
        ref={dragHandle?.setActivatorNodeRef}
        type="button"
        data-drag-handle
        className="flex h-6 w-6 shrink-0 items-center justify-center cursor-grab rounded-[var(--radius-md)] text-text-secondary hover:text-text-primary focus-visible:text-text-primary focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-primary focus-visible:outline-offset-[-2px] active:cursor-grabbing"
        aria-label={`Drag to rescue ${label}`}
        {...(dragHandle?.listeners as React.HTMLAttributes<HTMLElement> | undefined)}
      >
        <GripVertical className="w-3 h-3" aria-hidden="true" />
      </button>
      <button
        type="button"
        onClick={() => onSelect(terminal)}
        className="flex min-h-6 min-w-0 flex-1 items-center gap-2 self-stretch rounded-[var(--radius-md)] pr-2 text-left focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent-primary"
        aria-label={label}
        aria-description={description}
      >
        <TerminalIcon chrome={chrome} className="w-3 h-3 shrink-0" />
        <span className="min-w-0 flex-1 truncate text-xs font-medium text-text-secondary transition-colors duration-150 group-hover/chip:text-text-primary">
          {terminal.title}
        </span>
        <span className="flex shrink-0 items-center gap-1.5" aria-hidden="true">
          {StateIcon && agentState && (
            <StateIcon
              className={cn(
                "w-3 h-3",
                getEffectiveStateColor(agentState),
                agentState === "working" && "animate-spin-slow motion-reduce:animate-none"
              )}
            />
          )}
          <span className="text-text-secondary">
            {terminal.location === "dock" ? (
              <PanelBottom className="w-3 h-3" />
            ) : (
              <PanelTopClose className="w-3 h-3" />
            )}
          </span>
        </span>
      </button>
    </div>
  );
}
