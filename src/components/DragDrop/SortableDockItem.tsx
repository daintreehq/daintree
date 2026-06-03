import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { m } from "framer-motion";
import { cn } from "@/lib/utils";
import { UI_ANIMATION_DURATION, DRAG_GHOST_OPACITY, DRAG_GHOST_EASING } from "@/lib/animationUtils";
import type { PanelInstance } from "@shared/types/panel";
import type { DragData } from "./DndProvider";
import { DragHandleProvider } from "./DragHandleContext";

interface SortableDockItemProps {
  terminal: PanelInstance;
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
    id: terminal.id,
    data: dragData,
    animateLayoutChanges: () => false,
  });

  // Directional insertion-line indicator: only fire for dock sort drags (a
  // grid→dock cross-container drag also raises isOver, but its own highlight
  // handles that; an accordion-origin drag of a docked terminal also reports
  // sourceLocation "dock", so exclude it via `origin`), and only when dnd-kit
  // has measured the dragged rect. Compare horizontal midpoints — index
  // comparison gives the optimistic visual slot, not the user's intent
  // relative to the hovered chip.
  const isDockSortDragOver =
    isOver && active?.data.current?.sourceLocation === "dock" && !active?.data.current?.origin;
  const translatedRect = active?.rect.current.translated;
  let dropDirection: "before" | "after" | null = null;
  if (isDockSortDragOver && translatedRect && over) {
    const draggedMid = translatedRect.left + translatedRect.width / 2;
    const overMid = over.rect.left + over.rect.width / 2;
    dropDirection = draggedMid < overMid ? "before" : "after";
  }

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
  };

  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
  const destructured = attributes as unknown as Record<string, unknown>;
  const { role: _role, tabIndex: _tabIndex, ...remainingAttributes } = destructured;
  void _role;
  void _tabIndex;

  return (
    <m.div
      layout="position"
      className="flex-shrink-0"
      {...remainingAttributes}
      aria-roledescription="sortable item"
    >
      <div ref={setNodeRef} style={style} role="listitem" className={cn("relative flex-shrink-0")}>
        {dropDirection !== null && (
          <div
            aria-hidden="true"
            data-dock-drop-indicator={dropDirection}
            className={cn(
              "pointer-events-none absolute inset-y-0 z-10 w-0.5 bg-border-strong",
              dropDirection === "before" ? "-left-px" : "-right-px"
            )}
          />
        )}
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
