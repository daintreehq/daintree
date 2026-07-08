import { useEffect, useMemo, useRef } from "react";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { m } from "framer-motion";
import { cn } from "@/lib/utils";
import { UI_ANIMATION_DURATION, DRAG_GHOST_OPACITY, DRAG_GHOST_EASING } from "@/lib/animationUtils";
import type { PanelInstance } from "@shared/types/panel";
import type { DragData } from "./DndProvider";
import { DragHandleProvider, type DragHandleContextValue } from "./DragHandleContext";
import { useDockPanelDragHandleRegistration } from "@/components/Layout/dockPanelPortalContext";

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

  // Publish this dock item's drag handle so the portaled panel body (a React
  // sibling rendered by DockPanelOffscreenContainer, out of this provider's
  // subtree) can make its PanelHeader a drag handle too — grid parity (#10990).
  // Register under every group member id so whichever tab is active resolves the
  // group's shared handle; fall back to the panel's own id for a single item.
  // Keyed on the joined id string (a primitive) rather than the array reference,
  // so a fresh `groupPanelIds` array on an unrelated render doesn't re-fire this.
  const registerDragHandle = useDockPanelDragHandleRegistration();
  const dragHandleIdKey = groupPanelIds?.join(",");

  // dnd-kit re-creates `listeners` on every shared-DndContext render — which is
  // effectively every drag frame anywhere in the app (DndProvider churns
  // placeholder/over state, and its inline sensor options defeat useSensor
  // memoization). Registering the raw `{ listeners, setActivatorNodeRef }` would
  // make this effect re-fire and re-render DockPanelOffscreenContainer on every
  // such frame — the exact drag-perf regression this dock path is hardened
  // against. So keep the latest handle in a ref and register a STABLE proxy that
  // reads through it, keyed only on the (stable) id set. The bridged header
  // re-reads the proxy each time it opens, so it always sees live listeners.
  const handleRef = useRef<DragHandleContextValue>({ listeners, setActivatorNodeRef });
  useEffect(() => {
    handleRef.current = { listeners, setActivatorNodeRef };
  });
  const bridgedHandle = useMemo<DragHandleContextValue>(
    () => ({
      get listeners() {
        return handleRef.current.listeners;
      },
      get setActivatorNodeRef() {
        return handleRef.current.setActivatorNodeRef;
      },
    }),
    []
  );
  useEffect(() => {
    const ids = dragHandleIdKey ? dragHandleIdKey.split(",") : [terminal.id];
    return registerDragHandle(ids, bridgedHandle);
  }, [registerDragHandle, terminal.id, dragHandleIdKey, bridgedHandle]);

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
              // Transient drop affordance. On dark, border-strong reads as a
              // clear hairline against the deep grid (kept byte-for-byte). On
              // light borderInk@0.18 composites near-invisible (~1.4:1, below
              // the 3:1 graphical-indicator floor), so .light substitutes a
              // strong text-ink line at /70, which clears 3:1 on every light
              // theme and surface (>=4.2:1) — a conventional crisp placement
              // line, kept neutral rather than borrowing the accent anchor.
              "pointer-events-none absolute inset-y-0 z-10 w-0.5 bg-border-strong",
              "[.light_&]:bg-daintree-text/70",
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
