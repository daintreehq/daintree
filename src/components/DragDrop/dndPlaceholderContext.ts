import { createContext, useContext } from "react";
import type { PanelInstance } from "@shared/types/panel";

export const GRID_PLACEHOLDER_ID = "__grid-placeholder__";

// Placeholder state shared with ContentGrid, the dock and the sidebar. Lives
// apart from DndProvider so the placeholder components (and their previews and
// tests) can read it without pulling the whole orchestration provider — and its
// store graph — into their module graph.
export interface DndPlaceholderContextValue {
  placeholderIndex: number | null;
  sourceContainer: "grid" | "dock" | null;
  activeTerminal: PanelInstance | null;
  isDragging: boolean;
  isWorktreeSortDragging: boolean;
  /** If dragging a tab group, the group ID */
  activeGroupId: string | null;
  /** If dragging a tab group, the panel IDs in the group */
  activeGroupPanelIds: string[] | null;
  /**
   * True when the active drag can't be dropped in the dock — its kind, or ANY
   * live member's kind for a group drag, is non-dockable (#11375). Consumers
   * (the dock's `cursor-no-drop` cue) read this instead of re-checking the lone
   * representative kind, so the cue matches what `cancelDrop`/`collisionDetection`
   * actually enforce for a mixed group.
   */
  activeDragRejectsDock: boolean;
}

export const IDLE_DND_PLACEHOLDER: DndPlaceholderContextValue = {
  placeholderIndex: null,
  sourceContainer: null,
  activeTerminal: null,
  isDragging: false,
  isWorktreeSortDragging: false,
  activeGroupId: null,
  activeGroupPanelIds: null,
  activeDragRejectsDock: false,
};

export const DndPlaceholderContext =
  createContext<DndPlaceholderContextValue>(IDLE_DND_PLACEHOLDER);

export function useDndPlaceholder() {
  return useContext(DndPlaceholderContext);
}

export function useIsDragging() {
  return useContext(DndPlaceholderContext).isDragging;
}

export function useIsWorktreeSortDragging() {
  return useContext(DndPlaceholderContext).isWorktreeSortDragging;
}
