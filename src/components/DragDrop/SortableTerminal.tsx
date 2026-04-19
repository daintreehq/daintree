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

  // dnd-kit attaches role="button" + tabIndex={0} to the sortable container by
  // default, which conflicts with axe's nested-interactive rule because the
  // panel content hosts its own buttons, inputs, and xterm textarea. Strip
  // those props — actual drag initiation happens via drag handles passed
  // through DragHandleProvider, not via focusing the outer container.
  const {
    role: _role,
    tabIndex: _tabIndex,
    ...remainingAttributes
  } = attributes as unknown as Record<string, unknown>;
  void _role;
  void _tabIndex;

  return (
    <div
      ref={setNodeRef}
      style={style}
      data-terminal-id={terminal.id}
      className={cn(
        "h-full min-w-0 contain-layout contain-style",
        isDragging && "opacity-40 ring-2 ring-daintree-accent/50 rounded"
      )}
      {...remainingAttributes}
      aria-roledescription="sortable item"
    >
      <DragHandleProvider value={{ listeners }}>{children}</DragHandleProvider>
    </div>
  );
}
