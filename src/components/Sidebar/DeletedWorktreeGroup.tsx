import { useCallback, useEffect, useMemo, useState } from "react";
import { ChevronRight, FolderX, GripVertical, Trash2 } from "lucide-react";
import { SortableContext, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { cn } from "@/lib/utils";
import { usePanelStore } from "@/store/panelStore";
import {
  getDeletedWorktreeTerminalIds,
  useWorktreeSelectionStore,
  type DeletedWorktree,
} from "@/store/worktreeStore";
import { usePreferencesStore } from "@/store/preferencesStore";
import {
  useTerminalPendingDestructiveActionStore,
  type DeletedWorktreeGroupPreviewWorktree,
} from "@/store/terminalPendingDestructiveActionStore";
import { useVisibilityAwareInterval } from "@/hooks/useVisibilityAwareInterval";
import { DeletedWorktreeCard } from "./DeletedWorktreeCard";
import { TerminalIcon } from "@/components/Terminal/TerminalIcon";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  SortableWorktreeTerminal,
  getAccordionDragId,
} from "@/components/DragDrop/SortableWorktreeTerminal";
import { useDragHandle } from "@/components/DragDrop/DragHandleContext";
import { deriveTerminalChrome } from "@/utils/terminalChrome";
import { isPtyPanel, type PanelInstance, type PtyPanelData } from "@shared/types/panel";

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
 * Collapsed, the group is one row plus a rail of every surviving terminal.
 * The rail is not decoration: dragging a terminal onto a live worktree is the
 * only way to rescue an agent session, and a summary that unmounted its
 * terminals would take that away exactly when the rows are hardest to read.
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

  const cleanupSeconds = usePreferencesStore((s) => s.deletedWorktreeCleanupSeconds);
  const [nowTick, setNowTick] = useState(() => Date.now());
  // The group speaks for whichever member expires first — the deadlines stay
  // per-row and the cards still show their own once expanded.
  const soonestExpiresAt = useMemo(() => {
    let soonest: number | null = null;
    for (const { worktree } of members) {
      if (worktree.expiresAt === null) continue;
      if (soonest === null || worktree.expiresAt < soonest) soonest = worktree.expiresAt;
    }
    return soonest;
  }, [members]);
  const hasCountdown = soonestExpiresAt !== null && cleanupSeconds > 0 && !isExpanded;
  useVisibilityAwareInterval(() => setNowTick(Date.now()), 1000, hasCountdown);
  // The interval is off while expanded, so `nowTick` is stale on the way back:
  // collapsing after a minute would flash the full TTL until the first tick.
  useEffect(() => {
    if (hasCountdown) setNowTick(Date.now());
  }, [hasCountdown]);
  const cleanupMs = cleanupSeconds * 1000;
  const rawRemainingMs = soonestExpiresAt !== null ? Math.max(0, soonestExpiresAt - nowTick) : 0;
  const remainingSeconds = Math.ceil(
    (cleanupMs > 0 ? Math.min(rawRemainingMs, cleanupMs) : rawRemainingMs) / 1000
  );

  const handleClearAll = useCallback(() => {
    const preview: DeletedWorktreeGroupPreviewWorktree[] = members
      .filter((m) => m.panels.length > 0)
      .map((m) => ({
        worktreeId: m.worktree.id,
        worktreeTitle: m.worktree.title,
        terminals: m.panels.map((panel) => ({
          terminalId: panel.id,
          // The row's own title, matching what the accordion shows — the
          // derived chrome label is the terminal's kind, not its name.
          terminalTitle: panel.title,
          hasRunningAgent: deriveTerminalChrome(panel).isAgent,
        })),
      }));
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
      <div className="flex items-center gap-2 pl-1 pr-4 py-3">
        <button
          type="button"
          onClick={toggleExpanded}
          aria-expanded={isExpanded}
          className="flex min-w-0 flex-1 items-center gap-1.5 rounded text-left outline-hidden focus-visible:outline-solid focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-daintree-accent"
        >
          <ChevronRight
            data-animated-chevron
            className={cn(
              "w-3.5 h-3.5 shrink-0 text-text-muted transition-transform duration-150 ease-out",
              isExpanded && "rotate-90"
            )}
            aria-hidden="true"
          />
          <FolderX
            className="w-3.5 h-3.5 shrink-0 text-text-muted"
            strokeWidth={2.5}
            aria-hidden="true"
          />
          <span className="truncate text-[11px] font-medium text-text-muted">
            {members.length} {worktreeNoun}
            <span aria-hidden="true"> · </span>
            <span className="sr-only">, </span>
            {terminalCount} {terminalNoun}
          </span>
        </button>
        <div className="flex shrink-0 items-center gap-2">
          {hasCountdown && (
            <span
              className="font-mono text-[11px] tabular-nums text-text-muted"
              title={`Next cleanup in ${remainingSeconds}s`}
              data-testid="deleted-worktree-group-countdown"
            >
              {remainingSeconds}s
            </span>
          )}
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                onClick={handleClearAll}
                className="sidebar-action-button shrink-0 rounded p-1.5 -my-1.5 text-status-error/70 transition-colors hover:text-status-error focus-visible:outline focus-visible:outline-2 focus-visible:outline-daintree-accent"
                aria-label={clearLabel}
              >
                <Trash2 className="w-3.5 h-3.5" aria-hidden="true" />
              </button>
            </TooltipTrigger>
            <TooltipContent side="top">{clearLabel}</TooltipContent>
          </Tooltip>
        </div>
      </div>

      {isExpanded ? (
        members.map(({ worktree }) => (
          <DeletedWorktreeCard key={worktree.id} worktree={worktree} showDismissAction={false} />
        ))
      ) : (
        <div className="pb-2 pl-6 pr-4">
          <SortableContext
            id="deleted-worktree-group-rail"
            items={members.flatMap((m) => m.terminals.map((t) => getAccordionDragId(t.id)))}
            strategy={verticalListSortingStrategy}
          >
            <div role="list" aria-label="Terminals to rescue" className="flex flex-col gap-0.5">
              {members.map(({ worktree, terminals }) =>
                terminals.map((terminal, index) => (
                  <SortableWorktreeTerminal
                    key={terminal.id}
                    terminal={terminal}
                    worktreeId={worktree.id}
                    sourceIndex={index}
                  >
                    <DeletedWorktreeTerminalChip
                      terminal={terminal}
                      worktreeTitle={worktree.title}
                      onSelect={handleTerminalSelect}
                    />
                  </SortableWorktreeTerminal>
                ))
              )}
            </div>
          </SortableContext>
        </div>
      )}
    </div>
  );
}

interface DeletedWorktreeTerminalChipProps {
  terminal: PtyPanelData;
  worktreeTitle: string;
  onSelect: (terminal: PtyPanelData) => void;
}

/**
 * One rescuable terminal in the collapsed rail. Deliberately thinner than
 * `WorktreeTerminalSection`'s row — no fleet arming, no marquee selection, no
 * state badges — because the rail exists to keep the drag source reachable and
 * legible, not to reproduce a live worktree's accordion.
 */
function DeletedWorktreeTerminalChip({
  terminal,
  worktreeTitle,
  onSelect,
}: DeletedWorktreeTerminalChipProps) {
  const dragHandle = useDragHandle();
  const chrome = deriveTerminalChrome(terminal);
  const label = `${terminal.title} in deleted worktree ${worktreeTitle}`;

  // No `role="listitem"` here — `SortableWorktreeTerminal` already provides one
  // around this chip, and nesting a second announces every entry twice.
  return (
    <div className="group/chip flex items-center gap-1">
      <button
        ref={dragHandle?.setActivatorNodeRef}
        type="button"
        data-drag-handle
        className="cursor-grab rounded text-text-primary/25 transition-colors group-hover/chip:text-text-primary/40 hover:text-text-secondary focus-visible:text-text-secondary focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-daintree-accent active:cursor-grabbing"
        aria-label={`Drag to rescue ${label}`}
        {...(dragHandle?.listeners as React.HTMLAttributes<HTMLElement> | undefined)}
      >
        <GripVertical className="w-3.5 h-3.5" aria-hidden="true" />
      </button>
      <button
        type="button"
        onClick={() => onSelect(terminal)}
        className="flex min-w-0 flex-1 items-center gap-1.5 rounded px-1 py-0.5 text-left transition-colors hover:bg-overlay-subtle focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-1 focus-visible:outline-daintree-accent"
        aria-label={label}
      >
        <TerminalIcon chrome={chrome} className="w-3 h-3 shrink-0" />
        <span className="truncate text-[11px] text-text-muted">{terminal.title}</span>
      </button>
    </div>
  );
}
