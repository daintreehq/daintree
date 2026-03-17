import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { cn } from "@/lib/utils";
import type { TerminalInstance } from "@/store";
import type { DragData } from "./DndProvider";
import { DragHandleProvider } from "./DragHandleContext";

interface SortableDockItemProps {
  terminal: TerminalInstance;
  sourceIndex: number;
  children: React.ReactNode;
  /** If this panel is part of a tab group, the group ID */
  groupId?: string;
  /** If this panel is part of a tab group, all panel IDs in the group */
  groupPanelIds?: string[];
}

export function SortableDockItem({
  terminal,
  sourceIndex,
  children,
  groupId,
  groupPanelIds,
}: SortableDockItemProps) {
  const dragData: DragData = {
    terminal,
    sourceLocation: "dock",
    sourceIndex,
    groupId,
    groupPanelIds,
  };

  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: terminal.id,
    data: dragData,
  });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={cn("flex-shrink-0", isDragging && "opacity-40")}
      {...attributes}
      {...listeners}
      role="listitem"
      aria-roledescription="sortable item"
    >
      <DragHandleProvider value={{ listeners }}>{children}</DragHandleProvider>
    </div>
  );
}
