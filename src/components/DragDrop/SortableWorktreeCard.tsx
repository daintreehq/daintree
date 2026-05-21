import React from "react";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import type { SyntheticListenerMap } from "@dnd-kit/core/dist/hooks/utilities";
import { cn } from "@/lib/utils";
import { getWorktreeSidebarRowId } from "@/components/Sidebar/useWorktreeSidebarKeyboard";

export interface WorktreeSortDragData {
  type: "worktree-sort";
  worktreeId: string;
  dragStartOrder: string[];
}

const WORKTREE_SORT_PREFIX = "worktree-sort-";

export function getWorktreeSortDragId(worktreeId: string): string {
  return `${WORKTREE_SORT_PREFIX}${worktreeId}`;
}

export function parseWorktreeSortDragId(dragId: string | number): string | null {
  if (typeof dragId !== "string") return null;
  if (dragId.startsWith(WORKTREE_SORT_PREFIX)) {
    return dragId.slice(WORKTREE_SORT_PREFIX.length);
  }
  return null;
}

export function isWorktreeSortDragData(
  data: Record<string, unknown> | undefined
): data is Record<string, unknown> & WorktreeSortDragData {
  return data?.type === "worktree-sort";
}

interface SortableWorktreeCardProps {
  worktreeId: string;
  dragStartOrder: string[];
  disabled?: boolean;
  ariaRowIndex: number;
  isActive: boolean;
  children: (props: {
    isDraggingSort: boolean;
    dragHandleListeners: SyntheticListenerMap | undefined;
    dragHandleActivatorRef: (node: HTMLElement | null) => void;
  }) => React.ReactNode;
}

function sortableWorktreeCardPropsAreEqual(
  prev: SortableWorktreeCardProps,
  next: SortableWorktreeCardProps
): boolean {
  if (
    prev.worktreeId !== next.worktreeId ||
    prev.disabled !== next.disabled ||
    prev.ariaRowIndex !== next.ariaRowIndex ||
    prev.isActive !== next.isActive ||
    prev.children !== next.children
  ) {
    return false;
  }
  if (prev.dragStartOrder === next.dragStartOrder) return true;
  if (prev.dragStartOrder.length !== next.dragStartOrder.length) return false;
  for (let i = 0; i < prev.dragStartOrder.length; i++) {
    if (prev.dragStartOrder[i] !== next.dragStartOrder[i]) return false;
  }
  return true;
}

export const SortableWorktreeCard = React.memo(function SortableWorktreeCard({
  worktreeId,
  dragStartOrder,
  disabled,
  ariaRowIndex,
  isActive,
  children,
}: SortableWorktreeCardProps) {
  const dragData: WorktreeSortDragData = {
    type: "worktree-sort",
    worktreeId,
    dragStartOrder,
  };

  const {
    attributes,
    listeners,
    setNodeRef,
    setActivatorNodeRef,
    transform,
    transition,
    isDragging,
    isOver,
    active,
    over,
  } = useSortable({
    id: getWorktreeSortDragId(worktreeId),
    data: dragData,
    disabled,
    animateLayoutChanges: () => false,
  });

  // Directional insertion-line indicator: only fire for sort drags (a terminal
  // or browser drag would also raise isOver on the inner droppable, but not on
  // the sortable), and only when dnd-kit has measured the dragged rect.
  // Compare midpoints — index comparison gives the optimistic visual slot, not
  // the user's intent relative to the hovered row.
  const isSortDragOver = isOver && active?.data.current?.type === "worktree-sort";
  const translatedRect = active?.rect.current.translated;
  let dropDirection: "above" | "below" | null = null;
  if (isSortDragOver && translatedRect && over) {
    const draggedMid = translatedRect.top + translatedRect.height / 2;
    const overMid = over.rect.top + over.rect.height / 2;
    dropDirection = draggedMid < overMid ? "above" : "below";
  }

  // Virtuoso's windowing already eliminates layout cost for offscreen rows, so
  // content-visibility:auto here would only break dnd-kit transforms on the
  // active drag row (lesson #4438) without buying additional paint savings.
  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    isolation: isDragging ? "auto" : "isolate",
  };

  const {
    role: _role,
    "aria-roledescription": _ariaRoleDesc,
    tabIndex: _tabIndex,
    ...filteredAttributes
  } = attributes;

  return (
    <div
      ref={setNodeRef}
      style={style}
      role="row"
      id={getWorktreeSidebarRowId(worktreeId)}
      aria-roledescription="sortable worktree"
      aria-rowindex={ariaRowIndex}
      aria-current={isActive ? "true" : undefined}
      aria-keyshortcuts={disabled ? undefined : "Alt+ArrowUp Alt+ArrowDown"}
      data-worktree-row={worktreeId}
      tabIndex={-1}
      className="relative"
      {...filteredAttributes}
    >
      {dropDirection !== null && (
        <div
          aria-hidden="true"
          data-worktree-drop-indicator={dropDirection}
          className={cn(
            "pointer-events-none absolute inset-x-0 z-10 h-0.5 bg-border-strong",
            dropDirection === "above" ? "-top-px" : "-bottom-px"
          )}
        />
      )}
      <div role="gridcell">
        <div
          className={`h-full transition-opacity duration-150 motion-reduce:transition-none ${
            isDragging ? "opacity-40" : ""
          }`}
        >
          {children({
            isDraggingSort: isDragging,
            dragHandleListeners: listeners,
            dragHandleActivatorRef: setActivatorNodeRef,
          })}
        </div>
      </div>
    </div>
  );
}, sortableWorktreeCardPropsAreEqual);
