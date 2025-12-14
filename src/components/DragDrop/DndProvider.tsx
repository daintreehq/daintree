import { useState, useCallback, useMemo, useRef, createContext, useContext } from "react";
import {
  DndContext,
  DragOverlay,
  useDndMonitor,
  useSensors,
  useSensor,
  MouseSensor,
  TouchSensor,
  closestCenter,
  rectIntersection,
  pointerWithin,
  type DragStartEvent,
  type DragEndEvent,
  type DragOverEvent,
  type CollisionDetection,
  type Modifier,
} from "@dnd-kit/core";
import { useTerminalStore, type TerminalInstance, MAX_GRID_TERMINALS } from "@/store";
import { TerminalDragPreview } from "./TerminalDragPreview";

// Placeholder ID used when dragging from dock to grid
export const GRID_PLACEHOLDER_ID = "__grid-placeholder__";

// Context to share placeholder state with TerminalGrid
interface DndPlaceholderContextValue {
  placeholderIndex: number | null;
  sourceContainer: "grid" | "dock" | null;
  activeTerminal: TerminalInstance | null;
}

const DndPlaceholderContext = createContext<DndPlaceholderContextValue>({
  placeholderIndex: null,
  sourceContainer: null,
  activeTerminal: null,
});

export function useDndPlaceholder() {
  return useContext(DndPlaceholderContext);
}

// Minimum distance (px) pointer must move before drag starts
// This allows clicks to work for popovers without triggering drag
const DRAG_ACTIVATION_DISTANCE = 8;

// Cursor offset from top of preview (positions cursor in title bar area)
const TITLE_BAR_CURSOR_OFFSET = 12;

interface DndProviderProps {
  children: React.ReactNode;
}

export interface DragData {
  terminal: TerminalInstance;
  sourceLocation: "grid" | "dock";
  sourceIndex: number;
}

// Helper to get coordinates from pointer or touch event
function getEventCoordinates(event: Event): { x: number; y: number } {
  if ("touches" in event && (event as TouchEvent).touches.length) {
    const touch = (event as TouchEvent).touches[0];
    return { x: touch.clientX, y: touch.clientY };
  }
  const pointerEvent = event as PointerEvent;
  return { x: pointerEvent.clientX, y: pointerEvent.clientY };
}

// Inner component that uses useDndMonitor to track cursor position (must be inside DndContext)
function DragOverlayWithCursorTracking({
  activeTerminal,
}: {
  activeTerminal: TerminalInstance | null;
}) {
  const pointerStartRef = useRef<{ x: number; y: number } | null>(null);
  const pointerPositionRef = useRef<{ x: number; y: number } | null>(null);

  useDndMonitor({
    onDragStart({ activatorEvent }) {
      const coords = getEventCoordinates(activatorEvent as Event);
      pointerStartRef.current = coords;
      pointerPositionRef.current = coords;
    },
    onDragMove({ delta }) {
      const start = pointerStartRef.current;
      if (!start) return;
      pointerPositionRef.current = {
        x: start.x + delta.x,
        y: start.y + delta.y,
      };
    },
    onDragEnd() {
      pointerStartRef.current = null;
      pointerPositionRef.current = null;
    },
    onDragCancel() {
      pointerStartRef.current = null;
      pointerPositionRef.current = null;
    },
  });

  // Modifier that positions overlay centered horizontally on cursor, with cursor in title bar
  const cursorOverlayModifier: Modifier = useCallback(({ transform, overlayNodeRect }) => {
    const cursor = pointerPositionRef.current;
    if (!transform || !overlayNodeRect || !cursor) {
      return transform;
    }

    return {
      ...transform,
      x: cursor.x - overlayNodeRect.left - overlayNodeRect.width / 2,
      y: cursor.y - overlayNodeRect.top - TITLE_BAR_CURSOR_OFFSET,
    };
  }, []);

  return (
    <DragOverlay dropAnimation={null} modifiers={[cursorOverlayModifier]}>
      {activeTerminal ? <TerminalDragPreview terminal={activeTerminal} /> : null}
    </DragOverlay>
  );
}

export function DndProvider({ children }: DndProviderProps) {
  const [activeId, setActiveId] = useState<string | null>(null);
  const [activeData, setActiveData] = useState<DragData | null>(null);
  const [overContainer, setOverContainer] = useState<"grid" | "dock" | null>(null);

  // Placeholder state for cross-container drags (dock -> grid)
  const [placeholderIndex, setPlaceholderIndex] = useState<number | null>(null);

  // Configure sensors with activation constraint so clicks work for popovers
  const sensors = useSensors(
    useSensor(MouseSensor, {
      activationConstraint: { distance: DRAG_ACTIVATION_DISTANCE },
    }),
    useSensor(TouchSensor, {
      activationConstraint: { delay: 150, tolerance: 5 },
    })
  );

  const terminals = useTerminalStore((state) => state.terminals);
  const reorderTerminals = useTerminalStore((s) => s.reorderTerminals);
  const moveTerminalToPosition = useTerminalStore((s) => s.moveTerminalToPosition);
  const moveTerminalToWorktree = useTerminalStore((s) => s.moveTerminalToWorktree);
  const setFocused = useTerminalStore((s) => s.setFocused);

  const activeTerminal = useMemo(() => {
    if (!activeId) return null;
    return terminals.find((t) => t.id === activeId) ?? null;
  }, [activeId, terminals]);

  const handleDragStart = useCallback((event: DragStartEvent) => {
    const { active } = event;
    setActiveId(active.id as string);

    const data = active.data.current as DragData | undefined;
    if (data) {
      setActiveData(data);
      setOverContainer(data.sourceLocation);
    }
  }, []);

  const handleDragOver = useCallback(
    (event: DragOverEvent) => {
      const { active, over } = event;
      if (!over) {
        setOverContainer(null);
        setPlaceholderIndex(null);
        return;
      }

      const activeDataCurrent = active.data.current as DragData | undefined;
      const overData = over.data.current as
        | { container?: "grid" | "dock"; sortable?: { containerId?: string; index?: number } }
        | undefined;

      // Determine which container we're over
      let detectedContainer: "grid" | "dock" | null = null;

      if (overData?.container) {
        detectedContainer = overData.container;
      } else if (overData?.sortable?.containerId) {
        const containerId = overData.sortable.containerId;
        if (containerId === "grid-container") {
          detectedContainer = "grid";
        } else if (containerId === "dock-container") {
          detectedContainer = "dock";
        }
      } else {
        const overId = over.id as string;
        const overTerminal = terminals.find((t) => t.id === overId);
        if (overTerminal) {
          detectedContainer = overTerminal.location === "dock" ? "dock" : "grid";
        }
      }

      setOverContainer(detectedContainer);

      // Handle placeholder for cross-container drag (dock -> grid)
      const sourceContainer = activeDataCurrent?.sourceLocation;
      if (sourceContainer === "dock" && detectedContainer === "grid") {
        // Find grid terminals to calculate insertion index (match TerminalGrid filter)
        const gridTerminals = terminals.filter(
          (t) => t.location === "grid" || t.location === undefined
        );
        const overId = over.id as string;
        const overIndex = gridTerminals.findIndex((t) => t.id === overId);

        if (overIndex !== -1) {
          setPlaceholderIndex(overIndex);
        } else if (overData?.sortable?.index !== undefined) {
          setPlaceholderIndex(overData.sortable.index);
        } else {
          // Dropping on empty grid or container itself - append to end
          setPlaceholderIndex(gridTerminals.length);
        }
      } else {
        setPlaceholderIndex(null);
      }
    },
    [terminals]
  );

  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      const { active, over } = event;

      // Capture state before clearing
      const dropContainer = overContainer;

      setActiveId(null);
      setActiveData(null);
      setOverContainer(null);
      setPlaceholderIndex(null);

      if (!over || !activeData) return;

      const draggedId = active.id as string;
      const overId = over.id as string;

      // Get source info
      const sourceLocation = activeData.sourceLocation;
      const overData = over.data.current as
        | {
            container?: "grid" | "dock";
            sortable?: { containerId?: string; index?: number };
            type?: string;
            worktreeId?: string;
          }
        | undefined;

      if (overData?.type === "worktree" && overData.worktreeId) {
        const currentTerminal = terminals.find((t) => t.id === draggedId);
        if (currentTerminal && currentTerminal.worktreeId !== overData.worktreeId) {
          moveTerminalToWorktree(draggedId, overData.worktreeId);
          setFocused(null);
        }
        return;
      }

      // Determine target container
      let targetContainer: "grid" | "dock" = sourceLocation;

      // Priority 1: Check if dropped on a container directly
      if (overData?.container) {
        targetContainer = overData.container;
      }
      // Priority 2: Check sortable containerId
      else if (overData?.sortable?.containerId) {
        const containerId = overData.sortable.containerId;
        if (containerId === "grid-container") {
          targetContainer = "grid";
        } else if (containerId === "dock-container") {
          targetContainer = "dock";
        }
      }
      // Priority 3: Use tracked overContainer state
      else if (dropContainer) {
        targetContainer = dropContainer;
      }
      // Priority 4: Determine from terminal location
      else {
        const overTerminal = terminals.find((t) => t.id === overId);
        if (overTerminal) {
          targetContainer = overTerminal.location === "dock" ? "dock" : "grid";
        }
      }

      // Get target index
      let targetIndex = 0;
      const containerTerminals = terminals.filter((t) =>
        targetContainer === "dock"
          ? t.location === "dock"
          : t.location === "grid" || t.location === undefined
      );

      // Find index of item we're dropping on
      const overTerminalIndex = containerTerminals.findIndex((t) => t.id === overId);
      if (overTerminalIndex !== -1) {
        targetIndex = overTerminalIndex;
      } else if (overData?.sortable?.index !== undefined) {
        targetIndex = overData.sortable.index;
      } else {
        // Dropping on empty container - append to end
        targetIndex = containerTerminals.length;
      }

      // Block cross-container move from dock to grid if grid is full
      const gridTerminals = terminals.filter(
        (t) => t.location === "grid" || t.location === undefined
      );
      const isGridFull = gridTerminals.length >= MAX_GRID_TERMINALS;
      if (sourceLocation === "dock" && targetContainer === "grid" && isGridFull) {
        // Grid is full, cancel the drop - TerminalGrid's batched fitter handles any needed resizing
        return;
      }

      // Same container reorder
      if (sourceLocation === targetContainer) {
        if (draggedId !== overId) {
          const oldIndex = containerTerminals.findIndex((t) => t.id === draggedId);

          if (oldIndex !== -1 && targetIndex !== -1 && oldIndex !== targetIndex) {
            reorderTerminals(oldIndex, targetIndex, targetContainer);
          }
        }
      } else {
        // Cross-container move
        moveTerminalToPosition(draggedId, targetIndex, targetContainer);

        // Set focus when moving to grid, clear when moving to dock
        if (targetContainer === "grid") {
          setFocused(draggedId);
        } else {
          setFocused(null);
        }
      }
      // TerminalGrid's batched fitter handles resizing automatically when gridTerminals changes
    },
    [
      activeData,
      overContainer,
      terminals,
      reorderTerminals,
      moveTerminalToPosition,
      moveTerminalToWorktree,
      setFocused,
    ]
  );

  const handleDragCancel = useCallback(() => {
    setActiveId(null);
    setActiveData(null);
    setOverContainer(null);
    setPlaceholderIndex(null);
    // No explicit refresh needed - terminals return to original state (no layout change)
  }, []);

  // Use rectIntersection for grid (better for 2D layouts), closestCenter for dock (1D horizontal)
  const collisionDetection: CollisionDetection = useCallback(
    (args) => {
      // First check if we're directly over any droppable
      const pointerCollisions = pointerWithin(args);
      if (pointerCollisions.length > 0) {
        return pointerCollisions;
      }

      // For grid, use rect intersection; for dock, use closest center
      if (overContainer === "grid") {
        return rectIntersection(args);
      }
      return closestCenter(args);
    },
    [overContainer]
  );

  const placeholderContextValue = useMemo(
    () => ({
      placeholderIndex,
      sourceContainer: activeData?.sourceLocation ?? null,
      activeTerminal,
    }),
    [placeholderIndex, activeData?.sourceLocation, activeTerminal]
  );

  return (
    <DndContext
      sensors={sensors}
      onDragStart={handleDragStart}
      onDragOver={handleDragOver}
      onDragEnd={handleDragEnd}
      onDragCancel={handleDragCancel}
      collisionDetection={collisionDetection}
    >
      <DndPlaceholderContext.Provider value={placeholderContextValue}>
        {children}
      </DndPlaceholderContext.Provider>
      <DragOverlayWithCursorTracking activeTerminal={activeTerminal} />
    </DndContext>
  );
}
