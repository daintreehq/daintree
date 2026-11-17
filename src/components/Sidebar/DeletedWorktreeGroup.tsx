import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ChevronRight,
  FolderX,
  GripVertical,
  PanelBottom,
  PanelTopClose,
  Trash2,
} from "lucide-react";
import { DRAG_GRIP_CLASS, DRAG_GRIP_ICON_CLASS } from "@/components/ui/dragGripStyles";
import { SortableContext, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { useShallow } from "zustand/react/shallow";
import { usePanelStore } from "@/store/panelStore";
import { exitProjectHome } from "@/store/storeAccessors";
import { usePreferencesStore } from "@/store/preferencesStore";
import { useVisibilityAwareInterval } from "@/hooks/useVisibilityAwareInterval";
import {
  getDeletedWorktreeTerminalIds,
  selectDeletedWorktreeTerminalIds,
  useWorktreeSelectionStore,
  type DeletedWorktree,
} from "@/store/worktreeStore";
import {
  useTerminalPendingDestructiveActionStore,
  type DestructivePreviewGroup,
} from "@/store/terminalPendingDestructiveActionStore";
import { DeletedWorktreeCard } from "./DeletedWorktreeCard";
import { TerminalIcon } from "@/components/Terminal/TerminalIcon";
import { TerminalContextMenu } from "@/components/Terminal/TerminalContextMenu";
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
import { selectPtyPanels } from "@/hooks/useWorktreeTerminals";
import type { PanelInstance, PtyPanelData } from "@shared/types/panel";
import { useDeletedWorktreeCountdown } from "./useDeletedWorktreeCountdown";
import {
  DeletedWorktreeTimer,
  describeDeletedWorktreeTimer,
  labelDeletedWorktreeTimer,
} from "./DeletedWorktreeTimer";
import { pluralize } from "@/lib/pluralize";
import { Badge } from "@/components/ui/badge";
import { TruncatedTooltip } from "@/components/ui/TruncatedTooltip";

const ID_SEPARATOR = "\u0000";
const LIST_SEPARATOR = "\u0001";

function splitIds(part: string): string[] {
  return part === "" ? [] : part.split(ID_SEPARATOR);
}

interface GroupMember {
  worktree: DeletedWorktree;
  /**
   * Everything clearing this member would trash. Mirrors
   * `getDeletedWorktreeTerminalIds` (and so `bulkTrashByWorktree`) without
   * narrowing by kind — previewing only the PTY panels would under-report what
   * the confirm is about to close, which is the #9699 mismatch class and a D2
   * consent violation besides.
   */
  panelIds: string[];
  /** The rescuable subset — only a terminal can ride the accordion drag. */
  terminalIds: string[];
}

interface DeletedWorktreeGroupProps {
  worktrees: DeletedWorktree[];
  homeDir?: string;
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
export function DeletedWorktreeGroup({ worktrees, homeDir }: DeletedWorktreeGroupProps) {
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
  // Selected as one string per member rather than through `panelsById`: a
  // panel object is replaced on every activity write, and that subscription
  // re-rendered the group for output in any terminal in the app (#17051). A
  // member's string changes only when its membership, order or PTY subset does,
  // which also tells a rescue between two members apart from no change at all.
  const membership = usePanelStore(
    useShallow((s) =>
      worktrees.map((worktree) => {
        const ids = selectDeletedWorktreeTerminalIds(s, worktree.id);
        const ptyIds = selectPtyPanels(s, ids).map((t) => t.id);
        return `${ids.join(ID_SEPARATOR)}${LIST_SEPARATOR}${ptyIds.join(ID_SEPARATOR)}`;
      })
    )
  );
  const members = useMemo<GroupMember[]>(
    () =>
      worktrees.map((worktree, i) => {
        const [panelPart = "", ptyPart = ""] = (membership[i] ?? "").split(LIST_SEPARATOR);
        return { worktree, panelIds: splitIds(panelPart), terminalIds: splitIds(ptyPart) };
      }),
    [worktrees, membership]
  );

  const terminalCount = members.reduce((n, m) => n + m.panelIds.length, 0);

  // A glanceable "next close" for the whole group. Only running members count:
  // a held member's deadline is re-pinned by the sweep on every pass, so it is
  // not a deadline at all, and letting it win made this readout jitter between
  // two values. Each member's own timer — held ones included — is in the rail.
  const cleanupSeconds = usePreferencesStore((s) => s.deletedWorktreeCleanupSeconds);
  const nextExpiresAt = useMemo(() => {
    let soonest: number | null = null;
    for (const { worktree, panelIds } of members) {
      if (panelIds.length === 0 || worktree.expiresAt === null || worktree.holdReason !== null) {
        continue;
      }
      if (soonest === null || worktree.expiresAt < soonest) soonest = worktree.expiresAt;
    }
    return soonest;
  }, [members]);
  const hasNextClose = nextExpiresAt !== null && cleanupSeconds > 0;
  const [nowTick, setNowTick] = useState(() => Date.now());
  useVisibilityAwareInterval(() => setNowTick(Date.now()), 1000, hasNextClose);
  // The interval sleeps while every member is held; resync on the way back so
  // the readout does not open on a stale second.
  useEffect(() => {
    if (hasNextClose) setNowTick(Date.now());
  }, [hasNextClose]);
  const nextCloseSeconds =
    nextExpiresAt === null
      ? 0
      : Math.ceil(Math.min(Math.max(0, nextExpiresAt - nowTick), cleanupSeconds * 1000) / 1000);

  const handleClearAll = useCallback(() => {
    // Read when clicked, so the confirm names what is there now.
    const { panelsById } = usePanelStore.getState();
    const preview: DestructivePreviewGroup[] = worktrees.flatMap((worktree) => {
      const panels = getDeletedWorktreeTerminalIds(worktree.id)
        .map((id) => panelsById[id])
        .filter((panel): panel is PanelInstance => panel != null);
      return panels.length > 0 ? buildDestructivePreview(panels, () => worktree.title) : [];
    });
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
  }, [worktrees, requestDestructiveAction]);

  const handleTerminalSelect = useCallback(
    (terminal: PtyPanelData) => {
      if (terminal.worktreeId) {
        trackTerminalFocus(terminal.worktreeId, terminal.id);
        selectWorktree(terminal.worktreeId, { source: "focus" });
      }
      if (terminal.location === "dock") {
        openDockTerminal(terminal.id);
      } else {
        // A grid pane is hidden while the project's Home shows.
        exitProjectHome();
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

  const worktreeLabel = pluralize(members.length, "deleted worktree");
  const panelLabel = pluralize(terminalCount, "panel");
  // Same verb as a single card's dismiss — the group only changes the scope.
  const clearLabel = `Close ${panelLabel}`;

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
            <FolderX className="w-3.5 h-3.5 shrink-0 text-text-secondary" aria-hidden="true" />
            {/* At a narrow sidebar the count gives way before the noun does:
                "3 deleted wo…" names nothing. */}
            <span className="shrink-0 text-xs font-medium text-text-secondary transition-colors duration-150 group-hover/summary:text-text-primary">
              {worktreeLabel}
            </span>
            <span className="sr-only">, </span>
            <span className="min-w-0 truncate text-2xs tabular-nums text-text-secondary">
              {panelLabel}
            </span>
          </span>
        </button>
        {/* Outside the disclosure button, so a value that changes every second
            never becomes part of that button's name. */}
        {hasNextClose && (
          <DeletedWorktreeTimer
            description={`Next cleanup in ${nextCloseSeconds}s`}
            ariaLabel={`Next cleanup in ${nextCloseSeconds} seconds`}
            data-testid="deleted-worktree-group-countdown"
          >
            {nextCloseSeconds}s
          </DeletedWorktreeTimer>
        )}
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon-xs"
              onClick={handleClearAll}
              className="sidebar-action-button -my-1 shrink-0 hover:text-status-error focus-visible:text-status-error [&_svg]:size-3.5"
              aria-label={clearLabel}
            >
              <Trash2 aria-hidden="true" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="top">{clearLabel}</TooltipContent>
        </Tooltip>
      </div>

      {isExpanded ? (
        members.map(({ worktree }) => (
          <DeletedWorktreeCard
            key={worktree.id}
            worktree={worktree}
            homeDir={homeDir}
            showDismissAction={false}
          />
        ))
      ) : (
        <SortableContext
          id="deleted-worktree-group-rail"
          items={members.flatMap((m) => m.terminalIds.map(getAccordionDragId))}
          strategy={verticalListSortingStrategy}
        >
          <div className="flex flex-col gap-2 pb-3 pl-7.5 pr-4">
            {members.map(({ worktree, terminalIds }) =>
              terminalIds.length === 0 ? null : (
                <DeletedWorktreeRailMember
                  key={worktree.id}
                  worktree={worktree}
                  terminalIds={terminalIds}
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
  terminalIds: readonly string[];
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
  terminalIds,
  onSelect,
}: DeletedWorktreeRailMemberProps) {
  const terminals = usePanelStore(useShallow((s) => selectPtyPanels(s, terminalIds)));
  const { hasCountdown, hold, remainingSeconds } = useDeletedWorktreeCountdown(worktree);
  const listLabel = `Terminals from deleted worktree ${worktree.title}`;

  return (
    <div data-deleted-worktree-member={worktree.id}>
      <div className="flex min-h-5 items-center gap-2 pl-1.5">
        <TruncatedTooltip content={worktree.title}>
          <span className="min-w-0 flex-1 truncate font-mono text-2xs text-text-secondary">
            {worktree.title}
          </span>
        </TruncatedTooltip>
        {hold !== undefined && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Badge
                size="xs"
                data-testid="deleted-worktree-member-hold"
                data-hold-reason={worktree.holdReason}
              >
                {hold.label}
              </Badge>
            </TooltipTrigger>
            <TooltipContent side="top">{hold.tooltip}</TooltipContent>
          </Tooltip>
        )}
        {hasCountdown && (
          <DeletedWorktreeTimer
            description={describeDeletedWorktreeTimer({ hold, remainingSeconds })}
            ariaLabel={labelDeletedWorktreeTimer({ hold, remainingSeconds })}
            data-testid="deleted-worktree-member-countdown"
          >
            {remainingSeconds}s
          </DeletedWorktreeTimer>
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
  // around this chip, and nesting a second announces every entry twice. The
  // chip's menu is the session's own, "Move to worktree" included: the other
  // way to rescue it.
  return (
    <TerminalContextMenu terminalId={terminal.id} proxy>
      <div className="group/chip flex items-center rounded-[var(--radius-lg)] transition-colors duration-150 hover:bg-overlay-subtle">
        <button
          ref={dragHandle?.setActivatorNodeRef}
          type="button"
          data-drag-handle
          className={DRAG_GRIP_CLASS}
          aria-label={`Drag to rescue ${label}`}
          {...(dragHandle?.listeners as React.HTMLAttributes<HTMLElement> | undefined)}
        >
          <GripVertical className={DRAG_GRIP_ICON_CLASS} aria-hidden="true" />
        </button>
        <button
          type="button"
          onClick={() => onSelect(terminal)}
          className="flex min-h-6 min-w-0 flex-1 items-center gap-2 self-stretch rounded-[var(--radius-md)] pr-2 text-left focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent-primary"
          aria-label={label}
          aria-description={description}
        >
          <TerminalIcon chrome={chrome} className="w-3 h-3 shrink-0" />
          <TruncatedTooltip content={terminal.title} focusable={false}>
            <span className="min-w-0 flex-1 truncate text-xs font-medium text-text-secondary transition-colors duration-150 group-hover/chip:text-text-primary">
              {terminal.title}
            </span>
          </TruncatedTooltip>
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
    </TerminalContextMenu>
  );
}
