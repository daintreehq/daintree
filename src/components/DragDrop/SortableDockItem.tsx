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
  } = useSortable({
    id: terminal.id,
    data: dragData,
    animateLayoutChanges: () => false,
  });

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
      <div ref={setNodeRef} style={style} role="listitem" className={cn("flex-shrink-0")}>
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
