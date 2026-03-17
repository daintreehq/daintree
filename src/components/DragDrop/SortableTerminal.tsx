import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { cn } from "@/lib/utils";
import type { TerminalInstance } from "@/store";
import type { DragData } from "./DndProvider";
import { DragHandleProvider } from "./DragHandleContext";

interface SortableTerminalProps {
  terminal: TerminalInstance;
  sourceLocation: "grid" | "dock";
  sourceIndex: number;
  children: React.ReactNode;
  disabled?: boolean;
  /** If this panel is part of a tab group, the group ID */
  groupId?: string;
  /** If this panel is part of a tab group, all panel IDs in the group */
  groupPanelIds?: string[];
}

export function SortableTerminal({
  terminal,
  sourceLocation,
  sourceIndex,
  children,
  disabled = false,
  groupId,
  groupPanelIds,
}: SortableTerminalProps) {
  const dragData: DragData = {
    terminal,
    sourceLocation,
    sourceIndex,
    groupId,
    groupPanelIds,
  };

  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: terminal.id,
    data: dragData,
    disabled,
  });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      data-terminal-id={terminal.id}
      className={cn("h-full", isDragging && "opacity-40 ring-2 ring-canopy-accent/50 rounded")}
      {...attributes}
      aria-roledescription="sortable item"
    >
      <DragHandleProvider value={{ listeners }}>{children}</DragHandleProvider>
    </div>
  );
}
