import {
  useState,
  useCallback,
  useMemo,
  useRef,
  createContext,
  useContext,
  useEffect,
} from "react";
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
import {
  useTerminalStore,
  useWorktreeSelectionStore,
  type TerminalInstance,
  MAX_GRID_TERMINALS,
} from "@/store";
import { TerminalDragPreview } from "./TerminalDragPreview";
import { terminalInstanceService } from "@/services/TerminalInstanceService";

// Placeholder ID used when dragging from dock to grid
export const GRID_PLACEHOLDER_ID = "__grid-placeholder__";

// Context to share placeholder state with TerminalGrid
interface DndPlaceholderContextValue {
  placeholderIndex: number | null;
  sourceContainer: "grid" | "dock" | null;
  activeTerminal: TerminalInstance | null;
  isDragging: boolean;
}

const DndPlaceholderContext = createContext<DndPlaceholderContextValue>({
  placeholderIndex: null,
  sourceContainer: null,
  activeTerminal: null,
  isDragging: false,
});

export function useDndPlaceholder() {
  return useContext(DndPlaceholderContext);
}

export function useIsDragging() {
  return useContext(DndPlaceholderContext).isDragging;
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

  // Ref to track overContainer for stable collision detection (avoids infinite loops)
  const overContainerRef = useRef<"grid" | "dock" | null>(null);
  useEffect(() => {
    overContainerRef.current = overContainer;
  }, [overContainer]);

  // Placeholder state for cross-container drags (dock -> grid)
  const [placeholderIndex, setPlaceholderIndex] = useState<number | null>(null);
  const stabilizationTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const dockRetryTimersRef = useRef<Set<ReturnType<typeof setTimeout>>>(new Set());

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
    terminalInstanceService.lockResize(active.id as string, true);

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

      // Capture dragged ID immediately for guaranteed unlock
      const draggedId = active?.id ? String(active.id) : null;
      console.log(`[DND_DEBUG] handleDragEnd id=${draggedId} over=${over?.id}`);

      // Capture source location before clearing
      const sourceLocation = activeData?.sourceLocation ?? null;

      // Capture state before clearing
      const dropContainer = overContainer;

      setActiveId(null);
      setActiveData(null);
      setOverContainer(null);
      setPlaceholderIndex(null);

      // ALWAYS unlock resize regardless of drop target - fixes stuck resize locks
      // when dropping outside droppable areas (over === null)
      if (draggedId) {
        setTimeout(() => terminalInstanceService.lockResize(draggedId, false), 100);
      }

      if (!over || !activeData || !draggedId) return;

      const overId = over.id as string;

      const overData = over.data.current as
        | {
            container?: "grid" | "dock";
            sortable?: { containerId?: string; index?: number };
            type?: string;
            worktreeId?: string;
          }
        | undefined;

      // Track if this is a worktree drop (skip reorder logic, but still run stabilization)
      const isWorktreeDrop = overData?.type === "worktree" && !!overData.worktreeId;
      if (isWorktreeDrop) {
        console.log(`[DND_DEBUG] Worktree drop detected: ${overData.worktreeId}`);
        const currentTerminal = terminals.find((t) => t.id === draggedId);
        if (currentTerminal && currentTerminal.worktreeId !== overData.worktreeId) {
          console.log(
            `[DND_DEBUG] Moving terminal ${draggedId} to worktree ${overData.worktreeId}`
          );
          moveTerminalToWorktree(draggedId, overData.worktreeId!);
          setFocused(null);
        }
        // Don't return - fall through to stabilization
      }

      // Determine target container (only used for grid/dock moves, not worktree drops)
      let targetContainer: "grid" | "dock" = sourceLocation ?? "grid";

      // Only process grid/dock reorder logic if this is NOT a worktree drop
      if (!isWorktreeDrop) {
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
          // Grid is full, cancel the drop - still run stabilization below
        } else {
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
        }
      }

      // Post-drag stabilization: Reset renderers after layout settles.
      // This fixes blank terminals caused by CSS transforms during drag.
      // Wait for dnd-kit's CSS transition to complete (~250ms) before resetting.
      // Using setTimeout instead of RAF because transitions can outlast multiple frames.

      // Cancel any pending stabilization from rapid drags
      if (stabilizationTimerRef.current) {
        clearTimeout(stabilizationTimerRef.current);
      }

      // Cancel any pending dock retry timers
      dockRetryTimersRef.current.forEach(clearTimeout);
      dockRetryTimersRef.current.clear();

      stabilizationTimerRef.current = setTimeout(() => {
        stabilizationTimerRef.current = null;
        console.log("[DND_DEBUG] Running stabilization");

        // Skip stabilization for remaining grid terminals if this was a worktree drop.
        // The remaining terminals just reflow and don't require a renderer reset.
        if (isWorktreeDrop) {
          console.log("[DND_DEBUG] Skipping stabilization for worktree drop");
          return;
        }

        // Get fresh terminal list from store to avoid stale closures
        const currentTerminals = useTerminalStore.getState().terminals;
        const activeWorktreeId = useWorktreeSelectionStore.getState().activeWorktreeId;

        // Only stabilize grid terminals in the ACTIVE worktree
        // Use nullish coalescing to handle null/undefined mismatch (matches TerminalGrid filter)
        const gridTerminalsList = currentTerminals.filter(
          (t) =>
            (t.location === "grid" || t.location === undefined) &&
            (t.worktreeId ?? undefined) === (activeWorktreeId ?? undefined)
        );

        console.log(
          `[DND_DEBUG] Stabilizing ${gridTerminalsList.length} terminals in active worktree ${activeWorktreeId}`
        );

        for (const terminal of gridTerminalsList) {
          // Flush any pending resize jobs that could have stale dimensions
          terminalInstanceService.flushResize(terminal.id);

          // Force store visibility to true to ensure terminals re-render after drag
          useTerminalStore.getState().updateVisibility(terminal.id, true);

          const managed = terminalInstanceService.get(terminal.id);
          if (managed?.hostElement.isConnected) {
            console.log(`[DND_DEBUG] Resetting renderer for ${terminal.id}`);
            // Force service visibility true since we know grid terminals should be visible
            managed.isVisible = true;

            // CRITICAL: Re-apply renderer policy to update lastAppliedTier.
            // Without this, terminals stuck in BACKGROUND tier continue dropping writes
            // even after visibility is restored, because writeToTerminal checks lastAppliedTier.
            // This also triggers wakeAndRestore() for terminals that had data dropped.
            const tier = managed.getRefreshTier();
            terminalInstanceService.applyRendererPolicy(terminal.id, tier);

            terminalInstanceService.resetRenderer(terminal.id);
          } else {
            console.log(`[DND_DEBUG] Skipping reset for ${terminal.id} - not connected`);
          }
        }

        // Handle dock terminal resize when terminal moved from grid to dock
        // This ensures the terminal refreshes with the correct dock dimensions
        if (sourceLocation === "grid" && targetContainer === "dock" && draggedId) {
          const refreshDockTerminal = () => {
            // Re-check current location to avoid race conditions
            const currentTerminal = useTerminalStore
              .getState()
              .terminals.find((t) => t.id === draggedId);
            if (currentTerminal?.location !== "dock") return;

            terminalInstanceService.flushResize(draggedId);
            const managed = terminalInstanceService.get(draggedId);
            if (managed?.hostElement.isConnected) {
              terminalInstanceService.resetRenderer(draggedId);
            }
          };

          // Try immediate refresh first
          const dims = terminalInstanceService.fit(draggedId);
          if (dims) {
            // Terminal is already attached to visible container
            refreshDockTerminal();
          } else {
            // Terminal may not be mounted yet (popover timing), retry with bounded attempts
            let attempts = 0;
            const maxAttempts = 10;
            const retryInterval = 16;

            const retryFit = () => {
              attempts++;
              const fitResult = terminalInstanceService.fit(draggedId);
              if (fitResult) {
                refreshDockTerminal();
                return;
              }
              if (attempts < maxAttempts) {
                const timerId = setTimeout(retryFit, retryInterval);
                dockRetryTimersRef.current.add(timerId);
              }
            };

            // Start retry loop
            const initialTimerId = setTimeout(retryFit, retryInterval);
            dockRetryTimersRef.current.add(initialTimerId);
          }
        }
      }, 300);
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
    if (activeId) {
      terminalInstanceService.lockResize(activeId, false);
    }
    setActiveId(null);
    setActiveData(null);
    setOverContainer(null);
    setPlaceholderIndex(null);
    // No explicit refresh needed - terminals return to original state (no layout change)
  }, [activeId]);

  // Use rectIntersection as default (stable when cursor outside containers),
  // closestCenter only for dock (better for 1D horizontal reordering)
  const collisionDetection: CollisionDetection = useCallback(
    (args) => {
      // First check if we're directly over any droppable
      const pointerCollisions = pointerWithin(args);
      if (pointerCollisions.length > 0) {
        return pointerCollisions;
      }

      // For dock, use closest center (better for 1D); otherwise rect intersection
      // Using rectIntersection as default prevents oscillation when cursor is
      // outside all containers (e.g., over disabled worktree drop target)
      if (overContainerRef.current === "dock") {
        return closestCenter(args);
      }
      return rectIntersection(args);
    },
    [] // Empty deps - function must be stable to prevent dnd-kit measurement loops
  );

  const placeholderContextValue = useMemo(
    () => ({
      placeholderIndex,
      sourceContainer: activeData?.sourceLocation ?? null,
      activeTerminal,
      isDragging: activeId !== null,
    }),
    [placeholderIndex, activeData?.sourceLocation, activeTerminal, activeId]
  );

  useEffect(() => {
    return () => {
      if (stabilizationTimerRef.current) {
        clearTimeout(stabilizationTimerRef.current);
      }
      dockRetryTimersRef.current.forEach(clearTimeout);
      dockRetryTimersRef.current.clear();
    };
  }, []);

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
