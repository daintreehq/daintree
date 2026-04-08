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
  MeasuringStrategy,
  type DragStartEvent,
  type DragEndEvent,
  type DragOverEvent,
  type CollisionDetection,
  type Modifier,
  type Announcements,
  type MeasuringConfiguration,
} from "@dnd-kit/core";
import {
  usePanelStore,
  useLayoutConfigStore,
  useWorktreeSelectionStore,
  type TerminalInstance,
} from "@/store";
import { useShallow } from "zustand/react/shallow";
import { TerminalDragPreview } from "./TerminalDragPreview";
import { WorktreeDragPreview } from "./WorktreeDragPreview";
import { terminalInstanceService } from "@/services/TerminalInstanceService";
import { arrayMove } from "@dnd-kit/sortable";
import { parseAccordionDragId } from "./SortableWorktreeTerminal";
import { isWorktreeSortDragData, parseWorktreeSortDragId } from "./SortableWorktreeCard";
import { useWorktreeFilterStore } from "@/store/worktreeFilterStore";
import { getCurrentViewStore } from "@/store/createWorktreeStore";
import { useLayoutUndoStore } from "@/store/layoutUndoStore";
import type { WorktreeSnapshot } from "@shared/types";

// Placeholder ID used when dragging from dock to grid
export const GRID_PLACEHOLDER_ID = "__grid-placeholder__";

// Context to share placeholder state with ContentGrid
interface DndPlaceholderContextValue {
  placeholderIndex: number | null;
  sourceContainer: "grid" | "dock" | null;
  activeTerminal: TerminalInstance | null;
  isDragging: boolean;
  isWorktreeSortDragging: boolean;
  /** If dragging a tab group, the group ID */
  activeGroupId: string | null;
  /** If dragging a tab group, the panel IDs in the group */
  activeGroupPanelIds: string[] | null;
}

const DndPlaceholderContext = createContext<DndPlaceholderContextValue>({
  placeholderIndex: null,
  sourceContainer: null,
  activeTerminal: null,
  isDragging: false,
  isWorktreeSortDragging: false,
  activeGroupId: null,
  activeGroupPanelIds: null,
});

export function useDndPlaceholder() {
  return useContext(DndPlaceholderContext);
}

export function useIsDragging() {
  return useContext(DndPlaceholderContext).isDragging;
}

export function useIsWorktreeSortDragging() {
  return useContext(DndPlaceholderContext).isWorktreeSortDragging;
}

// Minimum distance (px) pointer must move before drag starts
// This allows clicks to work for popovers without triggering drag
const DRAG_ACTIVATION_DISTANCE = 8;

// Cursor offset from top of preview (positions cursor in title bar area)
const TITLE_BAR_CURSOR_OFFSET = 12;

// Horizontal offset from cursor to left edge of worktree drag preview
const WORKTREE_CURSOR_LEFT_OFFSET = 8;

interface DndProviderProps {
  children: React.ReactNode;
}

export interface DragData {
  terminal: TerminalInstance;
  sourceLocation: "grid" | "dock";
  sourceIndex: number;
  /** If panel is part of a tab group, the group ID */
  groupId?: string;
  /** If panel is part of a tab group, all panel IDs in the group */
  groupPanelIds?: string[];
}

export interface WorktreeDragData extends DragData {
  worktreeId: string;
  origin: "accordion";
}

function getDragLabel(data: DragData | WorktreeDragData | undefined): string {
  return data?.terminal?.title ?? "panel";
}

const MEASURING_CONFIG: MeasuringConfiguration = {
  droppable: {
    strategy: MeasuringStrategy.Always,
    frequency: 150,
  },
};

const dragAnnouncements: Announcements = {
  onDragStart({ active }) {
    return `Picked up ${getDragLabel(active.data.current as DragData | undefined)}`;
  },
  onDragOver({ active, over }) {
    const label = getDragLabel(active.data.current as DragData | undefined);
    if (over) {
      const overLabel = getDragLabel(over.data.current as DragData | undefined);
      return `${label} is over ${overLabel}`;
    }
    return `${label} is no longer over a droppable area`;
  },
  onDragEnd({ active, over }) {
    const label = getDragLabel(active.data.current as DragData | undefined);
    if (over) {
      return `Dropped ${label}`;
    }
    return `${label} returned to its original position`;
  },
  onDragCancel({ active }) {
    const label = getDragLabel(active.data.current as DragData | undefined);
    return `Drag cancelled. ${label} returned to its original position`;
  },
};

function isWorktreeDragData(
  data: DragData | WorktreeDragData | undefined
): data is WorktreeDragData {
  return (
    data !== undefined && "origin" in data && data.origin === "accordion" && "worktreeId" in data
  );
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
  activeWorktree,
  groupTabCount,
}: {
  activeTerminal: TerminalInstance | null;
  activeWorktree: WorktreeSnapshot | null;
  groupTabCount?: number;
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

  // Modifier that positions overlay to the RIGHT of cursor (cursor at middle-left)
  const worktreeCursorModifier: Modifier = useCallback(({ transform, overlayNodeRect }) => {
    const cursor = pointerPositionRef.current;
    if (!transform || !overlayNodeRect || !cursor) return transform;

    return {
      ...transform,
      x: cursor.x - overlayNodeRect.left + WORKTREE_CURSOR_LEFT_OFFSET,
      y: cursor.y - overlayNodeRect.top - overlayNodeRect.height / 2,
    };
  }, []);

  const overlayContent = activeTerminal ? (
    <TerminalDragPreview terminal={activeTerminal} groupTabCount={groupTabCount} />
  ) : activeWorktree ? (
    <WorktreeDragPreview worktree={activeWorktree} />
  ) : null;

  const activeModifiers = useMemo(
    () => [activeWorktree ? worktreeCursorModifier : cursorOverlayModifier],
    [activeWorktree, worktreeCursorModifier, cursorOverlayModifier]
  );

  return (
    <DragOverlay dropAnimation={null} modifiers={activeModifiers}>
      {overlayContent}
    </DragOverlay>
  );
}

export function DndProvider({ children }: DndProviderProps) {
  const [activeId, setActiveId] = useState<string | null>(null);
  const [activeData, setActiveData] = useState<DragData | WorktreeDragData | null>(null);
  const [overContainer, setOverContainer] = useState<"grid" | "dock" | null>(null);
  const [isWorktreeSortActive, setIsWorktreeSortActive] = useState(false);
  const [activeSortWorktree, setActiveSortWorktree] = useState<WorktreeSnapshot | null>(null);

  // Ref to track overContainer for stable collision detection (avoids infinite loops)
  const overContainerRef = useRef<"grid" | "dock" | null>(null);
  useEffect(() => {
    overContainerRef.current = overContainer;
  }, [overContainer]);

  // Ref to track worktree sort state for stable collision detection
  const isWorktreeSortActiveRef = useRef(false);
  useEffect(() => {
    isWorktreeSortActiveRef.current = isWorktreeSortActive;
  }, [isWorktreeSortActive]);

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

  const panelsById = usePanelStore(useShallow((state) => state.panelsById));
  const reorderTerminals = usePanelStore((s) => s.reorderTerminals);
  const reorderTabGroups = usePanelStore((s) => s.reorderTabGroups);
  const moveTerminalToPosition = usePanelStore((s) => s.moveTerminalToPosition);
  const moveTabGroupToLocation = usePanelStore((s) => s.moveTabGroupToLocation);
  const moveTerminalToWorktree = usePanelStore((s) => s.moveTerminalToWorktree);
  const setFocused = usePanelStore((s) => s.setFocused);
  const activeWorktreeId = useWorktreeSelectionStore((state) => state.activeWorktreeId);
  const getMaxGridCapacity = useLayoutConfigStore((state) => state.getMaxGridCapacity);

  const activeTerminal = useMemo(() => {
    if (!activeId && !activeData) return null;
    if (activeData?.terminal) return activeData.terminal;
    // Parse accordion IDs to get actual terminal ID
    const terminalId = parseAccordionDragId(activeId!) ?? activeId;
    return (terminalId ? panelsById[terminalId] : null) ?? null;
  }, [activeId, activeData, panelsById]);

  const handleDragStart = useCallback((event: DragStartEvent) => {
    const { active } = event;
    const dragId = active.id as string;

    // Skip terminal-specific logic for worktree-sort drags
    if (isWorktreeSortDragData(active.data.current as Record<string, unknown> | undefined)) {
      setActiveId(dragId);
      setIsWorktreeSortActive(true);
      const worktreeId = parseWorktreeSortDragId(dragId);
      if (worktreeId) {
        const wt = getCurrentViewStore().getState().worktrees.get(worktreeId);
        setActiveSortWorktree(wt ?? null);
      }
      return;
    }

    const data = active.data.current as DragData | WorktreeDragData | undefined;

    const terminalId = data?.terminal?.id ?? parseAccordionDragId(dragId) ?? dragId;

    setActiveId(dragId);
    terminalInstanceService.lockResize(terminalId, true);

    // Clear any pending stabilization timers from previous drags
    if (stabilizationTimerRef.current) {
      clearTimeout(stabilizationTimerRef.current);
      stabilizationTimerRef.current = null;
    }
    dockRetryTimersRef.current.forEach(clearTimeout);
    dockRetryTimersRef.current.clear();

    if (data) {
      setActiveData(data);
      setOverContainer(data.sourceLocation);
    }
  }, []);

  const handleDragOver = useCallback((event: DragOverEvent) => {
    const { active, over } = event;
    if (!over) {
      setOverContainer(null);
      setPlaceholderIndex(null);
      return;
    }

    // Skip all container/placeholder logic for worktree-sort drags
    if (isWorktreeSortDragData(active.data.current as Record<string, unknown> | undefined)) {
      return;
    }

    const activeDataCurrent = active.data.current as DragData | WorktreeDragData | undefined;
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
      // Accordion containers (worktree-*-accordion) are ignored for grid/dock detection
    } else {
      const overId = over.id as string;
      // Skip accordion drop targets for non-accordion drags
      const parsedId = parseAccordionDragId(overId);
      const terminalId = parsedId ?? overId;
      const overTerminal = usePanelStore.getState().panelsById[terminalId];
      if (overTerminal && !parsedId) {
        // Only set container for non-accordion terminals
        detectedContainer = overTerminal.location === "dock" ? "dock" : "grid";
      }
    }

    setOverContainer(detectedContainer);

    // Handle placeholder for cross-container drag (dock -> grid)
    // Skip placeholders for accordion drags - they stay within their container
    const sourceContainer = activeDataCurrent?.sourceLocation;
    const isAccordionDrag = isWorktreeDragData(activeDataCurrent);

    if (!isAccordionDrag && sourceContainer === "dock" && detectedContainer === "grid") {
      // Get tab groups to compute group-based placeholder index
      // ContentGrid uses tab groups for SortableContext, so placeholderIndex must be a group index
      const activeWorktreeId = useWorktreeSelectionStore.getState().activeWorktreeId;
      const tabGroups = usePanelStore
        .getState()
        .getTabGroups("grid", activeWorktreeId ?? undefined);

      const overId = over.id as string;

      // Determine group index based on what we're hovering over
      let groupIndex = -1;

      if (overId === GRID_PLACEHOLDER_ID) {
        // Hovering over the placeholder itself - use sortable.index if available
        // (this can happen during drag oscillation)
        if (overData?.sortable?.index !== undefined) {
          groupIndex = Math.min(Math.max(0, overData.sortable.index), tabGroups.length);
        } else {
          // Fallback to end
          groupIndex = tabGroups.length;
        }
      } else {
        // Hovering over a real group or terminal - find which group it belongs to
        groupIndex = tabGroups.findIndex((g) => g.id === overId || g.panelIds.includes(overId));

        if (groupIndex === -1) {
          // Not found in any group - could be hovering over container or using sortable.index
          if (overData?.sortable?.index !== undefined) {
            groupIndex = Math.min(Math.max(0, overData.sortable.index), tabGroups.length);
          } else {
            // Dropping on empty grid or container itself - append to end
            groupIndex = tabGroups.length;
          }
        }
      }

      setPlaceholderIndex(groupIndex);
    } else {
      setPlaceholderIndex(null);
    }
  }, []);

  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      const { active, over } = event;

      // Handle worktree-sort drags before any terminal logic
      const activeRawData = active.data.current as Record<string, unknown> | undefined;
      if (isWorktreeSortDragData(activeRawData)) {
        setActiveId(null);
        setActiveData(null);
        setIsWorktreeSortActive(false);
        setActiveSortWorktree(null);

        if (!over) return;

        const activeWorktreeId = parseWorktreeSortDragId(String(active.id));
        // over.id may be worktree-sort-{id} or worktree-drop-{id} (same DOM node)
        const overId = String(over.id);
        const overWorktreeId =
          parseWorktreeSortDragId(overId) ??
          (overId.startsWith("worktree-drop-") ? overId.slice("worktree-drop-".length) : null);
        if (!activeWorktreeId || !overWorktreeId || activeWorktreeId === overWorktreeId) return;

        const dragOrder = activeRawData.dragStartOrder as string[];
        const oldIndex = dragOrder.indexOf(activeWorktreeId);
        const newIndex = dragOrder.indexOf(overWorktreeId);
        if (oldIndex === -1 || newIndex === -1) return;

        const reorderedSubset = arrayMove(dragOrder, oldIndex, newIndex);

        // Merge reordered subset back into full persisted order
        // so that worktrees hidden by filters don't lose position
        const fullOrder = useWorktreeFilterStore.getState().manualOrder;
        const subsetSet = new Set(reorderedSubset);
        const merged: string[] = [];
        let subsetIdx = 0;
        // Walk through the full order, replacing subset items in their new order
        for (const id of fullOrder) {
          if (subsetSet.has(id)) {
            merged.push(reorderedSubset[subsetIdx++]);
          } else {
            merged.push(id);
          }
        }
        // Append any subset items not in the full order (first drag or new items)
        while (subsetIdx < reorderedSubset.length) {
          merged.push(reorderedSubset[subsetIdx++]);
        }

        useWorktreeFilterStore.getState().setManualOrder(merged);
        useWorktreeFilterStore.getState().setOrderBy("manual");
        return;
      }

      // Read fresh terminal state from store to avoid stale closures
      const { panelsById: freshTerminalsById, panelIds: freshTerminalIds } =
        usePanelStore.getState();

      // Capture dragged terminal ID from data (works for both sortable and worktree list)
      const data = active.data.current as DragData | undefined;
      const draggedId = data?.terminal?.id ?? (active?.id ? String(active.id) : null);
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

      // Capture layout state before any mutations for undo support
      useLayoutUndoStore.getState().pushLayoutSnapshot();

      const overId = over.id as string;

      const overData = over.data.current as
        | {
            container?: "grid" | "dock";
            sortable?: { containerId?: string; index?: number };
            type?: string;
            worktreeId?: string;
          }
        | undefined;

      // Handle accordion reordering
      const isAccordionDrag = isWorktreeDragData(activeData);
      if (isAccordionDrag) {
        const accordionWorktreeId = activeData.worktreeId;
        // Parse accordion IDs to get actual terminal IDs
        const actualDraggedId = parseAccordionDragId(draggedId) ?? draggedId;
        const actualOverId = parseAccordionDragId(overId) ?? overId;
        const overTerminal = freshTerminalsById[actualOverId];

        if (overTerminal && actualDraggedId !== actualOverId) {
          const containerTerminals: TerminalInstance[] = [];
          for (const tid of freshTerminalIds) {
            const t = freshTerminalsById[tid];
            if (!t || (t.worktreeId ?? null) !== (accordionWorktreeId ?? null)) continue;
            if (sourceLocation === "dock") {
              if (t.location === "dock") containerTerminals.push(t);
            } else {
              if (t.location === "grid" || t.location === undefined) containerTerminals.push(t);
            }
          }

          const oldIndex = containerTerminals.findIndex((t) => t.id === actualDraggedId);
          const newIndex = containerTerminals.findIndex((t) => t.id === actualOverId);

          if (oldIndex !== -1 && newIndex !== -1 && oldIndex !== newIndex) {
            reorderTerminals(oldIndex, newIndex, sourceLocation ?? "grid", accordionWorktreeId);
          }
        }
        return;
      }

      // Check if this is a group drag
      const isGroupDrag =
        activeData.groupId && activeData.groupPanelIds && activeData.groupPanelIds.length > 1;

      // Track if this is a worktree drop (skip reorder logic, but still run stabilization)
      const isWorktreeDrop = overData?.type === "worktree" && !!overData.worktreeId;
      if (isWorktreeDrop) {
        // Block worktree drops for multi-panel groups (would split the group)
        if (isGroupDrag) {
          // Cancel the drop - fall through to stabilization only
        } else {
          const currentTerminal = freshTerminalsById[draggedId];
          if (currentTerminal && currentTerminal.worktreeId !== overData.worktreeId) {
            moveTerminalToWorktree(draggedId, overData.worktreeId!);
            setFocused(null);
          }
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
        // Priority 4: Determine from terminal location (skip accordion targets)
        else {
          // Skip accordion drop targets for grid/dock drags
          const isAccordionTarget = parseAccordionDragId(overId) !== null;
          if (!isAccordionTarget) {
            const overTerminal = freshTerminalsById[overId];
            if (overTerminal) {
              targetContainer = overTerminal.location === "dock" ? "dock" : "grid";
            }
          }
        }

        // Get target index
        let targetIndex = 0;
        const containerTerminals: TerminalInstance[] = [];
        for (const tid of freshTerminalIds) {
          const t = freshTerminalsById[tid];
          if (!t || (t.worktreeId ?? undefined) !== (activeWorktreeId ?? undefined)) continue;
          if (targetContainer === "dock") {
            if (t.location === "dock") containerTerminals.push(t);
          } else {
            if (t.location === "grid" || t.location === undefined) containerTerminals.push(t);
          }
        }

        // Find index of item we're dropping on (skip accordion IDs)
        const isAccordionOver = parseAccordionDragId(overId) !== null;
        const overTerminalIndex = isAccordionOver
          ? -1
          : containerTerminals.findIndex((t) => t.id === overId);
        if (overTerminalIndex !== -1) {
          targetIndex = overTerminalIndex;
        } else if (overData?.sortable?.index !== undefined) {
          targetIndex = overData.sortable.index;
        } else {
          // Dropping on empty container - append to end
          targetIndex = containerTerminals.length;
        }

        // Block cross-container move from dock to grid if grid is full
        // Count unique groups (each tab group = 1 slot)
        const gridTerminals: TerminalInstance[] = [];
        for (const tid of freshTerminalIds) {
          const t = freshTerminalsById[tid];
          if (
            t &&
            (t.location === "grid" || t.location === undefined) &&
            (t.worktreeId ?? undefined) === (activeWorktreeId ?? undefined)
          ) {
            gridTerminals.push(t);
          }
        }
        // Count groups using TabGroup data from store
        const tabGroups = usePanelStore.getState().tabGroups;
        const panelsInGroups = new Set<string>();
        let explicitGroupCount = 0;
        for (const group of tabGroups.values()) {
          if (
            group.location === "grid" &&
            (group.worktreeId ?? undefined) === (activeWorktreeId ?? undefined)
          ) {
            explicitGroupCount++;
            group.panelIds.forEach((pid) => panelsInGroups.add(pid));
          }
        }
        // Count ungrouped panels (each is its own virtual group)
        let ungroupedCount = 0;
        for (const t of gridTerminals) {
          if (!panelsInGroups.has(t.id)) {
            ungroupedCount++;
          }
        }
        const isGridFull = explicitGroupCount + ungroupedCount >= getMaxGridCapacity();

        if (sourceLocation === "dock" && targetContainer === "grid" && isGridFull) {
          // Grid is full, cancel the drop - still run stabilization below
        } else if (isGroupDrag) {
          // Group-aware drag: move the entire tab group
          if (sourceLocation === targetContainer) {
            // Same container: reorder groups
            const tabGroupsAtLocation = usePanelStore
              .getState()
              .getTabGroups(targetContainer, activeWorktreeId ?? undefined);

            // Derive fromGroupIndex from live tabGroups by finding the group containing
            // the dragged terminal. activeData.sourceIndex is the panel index among all
            // individual panels, not the group index, so it cannot be used here.
            // Prefer groupId match (explicit groups); fall back to panel membership.
            let fromGroupIndex = tabGroupsAtLocation.findIndex((g) => g.id === activeData.groupId);
            if (fromGroupIndex === -1) {
              fromGroupIndex = tabGroupsAtLocation.findIndex((g) =>
                g.panelIds.includes(activeData.terminal.id)
              );
            }

            if (fromGroupIndex !== -1) {
              // Find target group index: match by group ID or panel membership, then
              // fall back to sortable.index when overId is a synthetic placeholder.
              let toGroupIndex = -1;
              for (let i = 0; i < tabGroupsAtLocation.length; i++) {
                if (
                  tabGroupsAtLocation[i].id === overId ||
                  tabGroupsAtLocation[i].panelIds.includes(overId)
                ) {
                  toGroupIndex = i;
                  break;
                }
              }
              if (toGroupIndex === -1) {
                toGroupIndex =
                  overData?.sortable?.index !== undefined
                    ? Math.min(Math.max(0, overData.sortable.index), tabGroupsAtLocation.length - 1)
                    : tabGroupsAtLocation.length - 1;
              }

              if (fromGroupIndex !== toGroupIndex) {
                reorderTabGroups(fromGroupIndex, toGroupIndex, targetContainer, activeWorktreeId);
              }
            }
          } else {
            // Cross-container: move entire group to new location
            const moveSuccess = moveTabGroupToLocation(activeData.groupId!, targetContainer);

            if (moveSuccess) {
              // After moving, reorder to the drop position
              // The group is now at the end, move it to targetIndex
              const tabGroupsAtLocation = usePanelStore
                .getState()
                .getTabGroups(targetContainer, activeWorktreeId ?? undefined);

              // Find the moved group's current index (should be last)
              const movedGroupIndex = tabGroupsAtLocation.findIndex(
                (g) => g.id === activeData.groupId
              );

              if (movedGroupIndex !== -1) {
                // Find target group index: match by group ID or panel membership, then
                // fall back to sortable.index when overId is a synthetic placeholder.
                let toGroupIndex = -1;
                for (let i = 0; i < tabGroupsAtLocation.length; i++) {
                  if (
                    tabGroupsAtLocation[i].id === overId ||
                    tabGroupsAtLocation[i].panelIds.includes(overId)
                  ) {
                    toGroupIndex = i;
                    break;
                  }
                }
                if (toGroupIndex === -1) {
                  toGroupIndex =
                    overData?.sortable?.index !== undefined
                      ? Math.min(
                          Math.max(0, overData.sortable.index),
                          tabGroupsAtLocation.length - 1
                        )
                      : tabGroupsAtLocation.length - 1;
                }

                // If we're not already at the target position, reorder
                if (movedGroupIndex !== toGroupIndex) {
                  reorderTabGroups(
                    movedGroupIndex,
                    toGroupIndex,
                    targetContainer,
                    activeWorktreeId
                  );
                }
              }

              // Set focus to first panel in group when moving to grid
              if (targetContainer === "grid") {
                setFocused(activeData.groupPanelIds![0] ?? draggedId);
              } else {
                setFocused(null);
              }
            }
          }
        } else {
          // Single panel drag (not part of a multi-panel group)
          // Same container reorder
          if (sourceLocation === targetContainer) {
            if (draggedId !== overId) {
              const oldIndex = containerTerminals.findIndex((t) => t.id === draggedId);

              if (oldIndex !== -1 && targetIndex !== -1 && oldIndex !== targetIndex) {
                reorderTerminals(oldIndex, targetIndex, targetContainer, activeWorktreeId);
              }
            }
          } else {
            // Cross-container move
            moveTerminalToPosition(draggedId, targetIndex, targetContainer, activeWorktreeId);

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
        // Skip stabilization for remaining grid terminals if this was a worktree drop.
        // The remaining terminals just reflow and don't require a renderer reset.
        if (isWorktreeDrop) {
          return;
        }

        // Get fresh terminal state from store to avoid stale closures
        const storeState = usePanelStore.getState();
        const activeWorktreeId = useWorktreeSelectionStore.getState().activeWorktreeId;

        // Only stabilize grid terminals in the ACTIVE worktree
        // Use nullish coalescing to handle null/undefined mismatch (matches ContentGrid filter)
        const gridTerminalsList: TerminalInstance[] = [];
        for (const tid of storeState.panelIds) {
          const t = storeState.panelsById[tid];
          if (
            t &&
            (t.location === "grid" || t.location === undefined) &&
            (t.worktreeId ?? undefined) === (activeWorktreeId ?? undefined)
          ) {
            gridTerminalsList.push(t);
          }
        }

        for (const terminal of gridTerminalsList) {
          // Flush any pending resize jobs that could have stale dimensions
          terminalInstanceService.flushResize(terminal.id);

          // Force store visibility to true to ensure terminals re-render after drag
          usePanelStore.getState().updateVisibility(terminal.id, true);

          const managed = terminalInstanceService.get(terminal.id);
          if (managed?.hostElement.isConnected) {
            // Force service visibility true since we know grid terminals should be visible
            managed.isVisible = true;

            // CRITICAL: Re-apply renderer policy to update lastAppliedTier.
            // Without this, terminals stuck in BACKGROUND tier continue dropping writes
            // even after visibility is restored, because writeToTerminal checks lastAppliedTier.
            // This also triggers wakeAndRestore() for terminals that had data dropped.
            const tier = managed.getRefreshTier();
            terminalInstanceService.applyRendererPolicy(terminal.id, tier);

            terminalInstanceService.resetRenderer(terminal.id);
          }
        }

        // Handle dock terminal resize when terminal moved from grid to dock
        // This ensures the terminal refreshes with the correct dock dimensions
        if (sourceLocation === "grid" && targetContainer === "dock" && draggedId) {
          const refreshDockTerminal = () => {
            // Re-check current location to avoid race conditions
            const currentTerminal = usePanelStore.getState().panelsById[draggedId];
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
      reorderTerminals,
      reorderTabGroups,
      moveTerminalToPosition,
      moveTabGroupToLocation,
      moveTerminalToWorktree,
      setFocused,
      activeWorktreeId,
      getMaxGridCapacity,
    ]
  );

  const handleDragCancel = useCallback(() => {
    // Skip terminal unlock for worktree-sort drags (no lock was acquired)
    const isWorktreeSort = activeId ? parseWorktreeSortDragId(activeId) !== null : false;
    if (!isWorktreeSort) {
      const terminalId =
        activeData?.terminal?.id ??
        (activeId ? (parseAccordionDragId(activeId) ?? activeId) : null);
      if (terminalId) {
        terminalInstanceService.lockResize(terminalId, false);
      }
    }

    // Clear any pending stabilization timers
    if (stabilizationTimerRef.current) {
      clearTimeout(stabilizationTimerRef.current);
      stabilizationTimerRef.current = null;
    }
    dockRetryTimersRef.current.forEach(clearTimeout);
    dockRetryTimersRef.current.clear();

    setActiveId(null);
    setActiveData(null);
    setOverContainer(null);
    setPlaceholderIndex(null);
    setIsWorktreeSortActive(false);
    setActiveSortWorktree(null);
    // No explicit refresh needed - terminals return to original state (no layout change)
  }, [activeId, activeData]);

  // Use rectIntersection as default (stable when cursor outside containers),
  // closestCenter for dock (1D horizontal) and worktree sort (1D vertical)
  const collisionDetection: CollisionDetection = useCallback(
    (args) => {
      // For worktree sort drags, use closestCenter (best for 1D vertical lists)
      if (isWorktreeSortActiveRef.current) {
        return closestCenter(args);
      }

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
      isWorktreeSortDragging: isWorktreeSortActive,
      activeGroupId: activeData?.groupId ?? null,
      activeGroupPanelIds: activeData?.groupPanelIds ?? null,
    }),
    [
      placeholderIndex,
      activeData?.sourceLocation,
      activeData?.groupId,
      activeData?.groupPanelIds,
      activeTerminal,
      activeId,
      isWorktreeSortActive,
    ]
  );

  useEffect(() => {
    if (activeId !== null) {
      document.documentElement.dataset.dragging = "true";
    } else {
      delete document.documentElement.dataset.dragging;
    }
    return () => {
      delete document.documentElement.dataset.dragging;
    };
  }, [activeId]);

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
      measuring={MEASURING_CONFIG}
      accessibility={{ announcements: dragAnnouncements }}
    >
      <DndPlaceholderContext.Provider value={placeholderContextValue}>
        {children}
      </DndPlaceholderContext.Provider>
      <DragOverlayWithCursorTracking
        activeTerminal={activeTerminal}
        activeWorktree={activeSortWorktree}
        groupTabCount={activeData?.groupPanelIds?.length}
      />
    </DndContext>
  );
}
