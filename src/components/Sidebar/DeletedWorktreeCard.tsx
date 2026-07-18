import { useCallback, useMemo } from "react";
import { FolderX } from "lucide-react";
import { SortableContext, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { cn } from "@/lib/utils";
import { usePanelStore } from "@/store/panelStore";
import {
  getDeletedWorktreeTerminalIds,
  useWorktreeSelectionStore,
  type DeletedWorktree,
} from "@/store/worktreeStore";
import { useTerminalPendingDestructiveActionStore } from "@/store/terminalPendingDestructiveActionStore";
import {
  SortableWorktreeTerminal,
  getAccordionDragId,
} from "@/components/DragDrop/SortableWorktreeTerminal";
import { TerminalIcon } from "@/components/Terminal/TerminalIcon";
import { deriveTerminalChrome } from "@/utils/terminalChrome";
import { getTerminalAgentDisplayState } from "@/utils/terminalAgentDisplayState";
import { useDragHandle } from "@/components/DragDrop/DragHandleContext";
import { isPtyPanel } from "@shared/types/panel";
import type { PanelInstance } from "@shared/types/panel";

interface DeletedWorktreeCardProps {
  worktree: DeletedWorktree;
}

/**
 * A deleted-worktree terminal row.
 *
 * Deliberately *not* `WorktreeTerminalSection`'s `TerminalRow`: that row's
 * primary affordance is click-to-focus, which cannot work here. Both the grid
 * and the dock filter panels by `activeWorktreeId`, and a deleted worktree can
 * never be active — so a deleted-worktree terminal is genuinely unviewable in place. The
 * row therefore presents identity only, and dragging it to a live worktree is
 * the single real affordance (hence the card's subtitle).
 */
function DeletedWorktreeTerminalRow({ panel }: { panel: PanelInstance }) {
  const dragHandle = useDragHandle();
  const chrome = deriveTerminalChrome(panel);
  const agentState = getTerminalAgentDisplayState(
    chrome,
    isPtyPanel(panel) ? panel.agentState : undefined
  );

  return (
    <div
      data-terminal-id={panel.id}
      data-deleted-worktree-terminal-id={panel.id}
      data-terminal-runtime-kind={chrome.runtimeKind}
      data-terminal-agent-id={chrome.agentId || undefined}
      data-terminal-agent-state={agentState || undefined}
      ref={dragHandle?.setActivatorNodeRef}
      {...(dragHandle?.listeners ?? {})}
      className="group/deletedrow flex items-center gap-2 px-3 py-2 cursor-grab active:cursor-grabbing"
    >
      <div className="shrink-0 opacity-60 group-hover/deletedrow:opacity-100 transition-opacity">
        <TerminalIcon kind={panel.kind} chrome={chrome} className="w-3 h-3" />
      </div>
      <span className="truncate text-xs font-medium text-text-secondary" title={panel.title}>
        {panel.title}
      </span>
    </div>
  );
}

/**
 * Sidebar row for a worktree whose directory is gone but whose terminals are
 * still running (#11232).
 *
 * Intentionally a separate component rather than a variant of `WorktreeCard`:
 * a deleted worktree has no git status, no branch operations, and nowhere to open an
 * editor, so it renders none of that chrome. It also deliberately does *not*
 * use `SortableWorktreeCard`, which is what registers a card as a drop target
 * via `type: "worktree"` drag data — a deleted worktree must never accept terminals, and
 * omitting that wrapper excludes it by construction rather than by a flag
 * `DndProvider` would have to check.
 */
export function DeletedWorktreeCard({ worktree }: DeletedWorktreeCardProps) {
  const panelsById = usePanelStore((s) => s.panelsById);
  const panelIdsByWorktreeId = usePanelStore((s) => s.panelIdsByWorktreeId);
  const requestDestructiveAction = useTerminalPendingDestructiveActionStore((s) => s.request);
  const dismissDeletedWorktree = useWorktreeSelectionStore((s) => s.dismissDeletedWorktree);

  const panels = useMemo(() => {
    void panelIdsByWorktreeId;
    return getDeletedWorktreeTerminalIds(worktree.id)
      .map((id) => panelsById[id])
      .filter((panel): panel is PanelInstance => panel != null);
  }, [worktree.id, panelsById, panelIdsByWorktreeId]);

  const handleDismiss = useCallback(() => {
    if (panels.length === 0) {
      // Nothing left to confirm — the pruning subscription is about to drop
      // this row anyway, but dismissing directly keeps the button honest.
      dismissDeletedWorktree(worktree.id);
      return;
    }
    requestDestructiveAction({
      kind: "deletedWorktreeDismiss",
      targetCount: panels.length,
      runningAgentCount: panels.filter((panel) => deriveTerminalChrome(panel).isAgent).length,
      worktreeId: worktree.id,
    });
  }, [panels, worktree.id, requestDestructiveAction, dismissDeletedWorktree]);

  // Defensive: the store prunes empty deleted-worktree rows, so an empty row should never
  // reach render. Bailing keeps a torn frame from showing a zero-terminal card.
  if (panels.length === 0) return null;

  const noun = panels.length === 1 ? "terminal" : "terminals";

  return (
    <div
      data-deleted-worktree-id={worktree.id}
      // The dashed outline is the load-bearing "this is not a real worktree"
      // signal — live cards are always solid. Everything else stays neutral and
      // muted on purpose: a deleted worktree is a resting state the user chose,
      // not a failure, so no error or warning colour appears anywhere here.
      className="border-b border-border-default bg-surface-inset/40 border-l-2 border-l-transparent outline-dashed outline-1 -outline-offset-1 outline-border-strong/50"
    >
      <div className="flex items-start gap-2 px-4 py-3">
        <FolderX className="w-4 h-4 text-text-muted mt-0.5 shrink-0" aria-hidden="true" />
        <div className="flex-1 min-w-0 space-y-0.5">
          <div className="flex items-center gap-2 min-w-0">
            <span className="truncate text-sm font-medium text-text-muted">{worktree.title}</span>
            <span className="shrink-0 rounded-full bg-overlay-soft px-1.5 py-0.5 text-[10px] font-medium text-text-muted">
              Deleted
            </span>
          </div>
          <div className="truncate text-xs text-text-muted line-through" title={worktree.path}>
            {worktree.path}
          </div>
          <div className="text-xs text-text-muted">Drag terminals to another worktree</div>
        </div>
        <button
          type="button"
          onClick={handleDismiss}
          className={cn(
            "shrink-0 rounded-sm text-xs text-text-muted transition-colors",
            "hover:text-daintree-text focus-visible:outline focus-visible:outline-2",
            "focus-visible:outline-daintree-accent"
          )}
        >
          {`Close ${panels.length} ${noun}`}
        </button>
      </div>

      <SortableContext
        items={panels.map((panel) => getAccordionDragId(panel.id))}
        strategy={verticalListSortingStrategy}
      >
        <div role="list" aria-label={`Terminals from deleted worktree ${worktree.title}`}>
          {panels.map((panel, index) => (
            <SortableWorktreeTerminal
              key={panel.id}
              terminal={panel}
              worktreeId={worktree.id}
              sourceIndex={index}
            >
              <DeletedWorktreeTerminalRow panel={panel} />
            </SortableWorktreeTerminal>
          ))}
        </div>
      </SortableContext>
    </div>
  );
}
