import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { m } from "framer-motion";
import { cn } from "@/lib/utils";
import { UI_ANIMATION_DURATION, DRAG_GHOST_OPACITY, DRAG_GHOST_EASING } from "@/lib/animationUtils";
import type { PanelInstance } from "@shared/types/panel";
import type { WorktreeDragData } from "./DndProvider";
import { DragHandleProvider } from "./DragHandleContext";
import { pixelSnapTransform } from "./SortableTerminal";

interface SortableWorktreeTerminalProps {
  terminal: PanelInstance;
  worktreeId: string;
  sourceIndex: number;
  children: React.ReactNode;
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

  const {
    attributes,
    listeners,
    setNodeRef,
    setActivatorNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({
    id: getAccordionDragId(terminal.id),
    data: dragData,
    animateLayoutChanges: () => false,
  });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
  };

  const {
    role: _role,
    "aria-roledescription": _ariaRoleDesc,
    tabIndex: _tabIndex,
    ...filteredAttributes
  } = attributes;
  void _tabIndex;

  return (
    <m.div layout="position" transformTemplate={pixelSnapTransform} className="h-full min-w-0">
      <div
        ref={setNodeRef}
        style={style}
        className={cn("h-full min-w-0")}
        role="listitem"
        aria-roledescription="sortable item"
        {...filteredAttributes}
      >
        <m.div
          className="h-full"
          animate={{ opacity: isDragging ? DRAG_GHOST_OPACITY : 1 }}
          transition={{
            duration: isDragging ? UI_ANIMATION_DURATION / 1000 : 0,
            ease: DRAG_GHOST_EASING,
          }}
        >
          <DragHandleProvider value={{ listeners, setActivatorNodeRef }}>
            {children}
          </DragHandleProvider>
        </m.div>
      </div>
    </m.div>
  );
}
