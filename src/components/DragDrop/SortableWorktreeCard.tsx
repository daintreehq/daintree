import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { cn } from "@/lib/utils";
import type { SyntheticListenerMap } from "@dnd-kit/core/dist/hooks/utilities";

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
  children: (props: {
    sortableRef: (node: HTMLElement | null) => void;
    sortableStyle: React.CSSProperties;
    isDraggingSort: boolean;
    dragHandleListeners: SyntheticListenerMap | undefined;
    dragHandleActivatorRef: (node: HTMLElement | null) => void;
  }) => React.ReactNode;
}

export function SortableWorktreeCard({
  worktreeId,
  dragStartOrder,
  disabled,
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
  } = useSortable({
    id: getWorktreeSortDragId(worktreeId),
    data: dragData,
    disabled,
  });

  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
  };

  const { role: _role, "aria-roledescription": _ariaRoleDesc, ...filteredAttributes } = attributes;

  return (
    <div
      style={style}
      className={cn(isDragging && "opacity-40")}
      role="listitem"
      aria-roledescription="sortable worktree"
      {...filteredAttributes}
    >
      {children({
        sortableRef: setNodeRef,
        sortableStyle: style,
        isDraggingSort: isDragging,
        dragHandleListeners: listeners,
        dragHandleActivatorRef: setActivatorNodeRef,
      })}
    </div>
  );
}
