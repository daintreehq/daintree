import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { cn } from "@/lib/utils";
import type { TerminalInstance } from "@/store";
import type { WorktreeDragData } from "./DndProvider";

interface SortableWorktreeTerminalProps {
  terminal: TerminalInstance;
  worktreeId: string;
  sourceIndex: number;
  children:
    | React.ReactNode
    | ((props: { listeners: ReturnType<typeof useSortable>["listeners"] }) => React.ReactNode);
}

export function getAccordionDragId(terminalId: string): string {
  return `accordion-${terminalId}`;
}

export function parseAccordionDragId(dragId: string | number): string | null {
  if (typeof dragId !== "string") return null;
  if (dragId.startsWith("accordion-")) {
    return dragId.slice("accordion-".length);
  }
  return null;
}

export function SortableWorktreeTerminal({
  terminal,
  worktreeId,
  sourceIndex,
  children,
}: SortableWorktreeTerminalProps) {
  const dragData: WorktreeDragData = {
    terminal,
    sourceLocation: terminal.location === "dock" ? "dock" : "grid",
    sourceIndex,
    worktreeId,
    origin: "accordion",
  };

  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: getAccordionDragId(terminal.id),
    data: dragData,
  });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
  };

  // Omit role and aria-roledescription from attributes since we set them explicitly
  const { role: _role, "aria-roledescription": _ariaRoleDesc, ...filteredAttributes } = attributes;

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={cn(isDragging && "opacity-40")}
      role="listitem"
      aria-roledescription="sortable item"
      {...filteredAttributes}
    >
      {typeof children === "function" ? (
        children({ listeners })
      ) : (
        <div {...listeners}>{children}</div>
      )}
    </div>
  );
}
