import type { TerminalInstance } from "@/store";
import type { TabGroup } from "@shared/types";

export interface OverDropData {
  container?: "grid" | "dock";
  sortable?: { containerId?: string; index?: number };
  type?: string;
  worktreeId?: string;
}

/** Map dnd-kit container ID strings ("grid-container", "dock-container") to containers. */
export function resolveContainerId(containerId: string): "grid" | "dock" | null {
  if (containerId === "grid-container") return "grid";
  if (containerId === "dock-container") return "dock";
  return null;
}

/** Filter terminals to those in a given container and worktree, preserving panelIds order. */
export function filterTerminalsByContainer(
  terminalsById: Record<string, TerminalInstance | undefined>,
  panelIds: readonly string[],
  container: "grid" | "dock",
  worktreeId: string | null | undefined
): TerminalInstance[] {
  const result: TerminalInstance[] = [];
  for (const tid of panelIds) {
    const t = terminalsById[tid];
    if (!t || (t.worktreeId ?? undefined) !== (worktreeId ?? undefined)) continue;
    if (container === "dock") {
      if (t.location === "dock") result.push(t);
    } else {
      if (t.location === "grid" || t.location === undefined) result.push(t);
    }
  }
  return result;
}

/**
 * 4-priority container detection for handleDragEnd.
 * P1: direct container on overData; P2: sortable.containerId via resolveContainerId;
 * P3: tracked dropContainer state; P4: terminal location lookup (unless skipAccordionTarget).
 */
export function detectTargetContainer(
  overData: OverDropData | undefined,
  dropContainer: "grid" | "dock" | null,
  overId: string,
  terminalsById: Record<string, TerminalInstance | undefined>,
  skipAccordionTarget: boolean
): "grid" | "dock" | null {
  if (overData?.container) return overData.container;

  if (overData?.sortable?.containerId) {
    return resolveContainerId(overData.sortable.containerId);
  }

  if (dropContainer) return dropContainer;

  if (!skipAccordionTarget) {
    const overTerminal = terminalsById[overId];
    if (overTerminal) {
      return overTerminal.location === "dock" ? "dock" : "grid";
    }
  }

  return null;
}

/**
 * Compute target insertion index within a container.
 * Falls back: exact terminal match → sortable.index → append-to-end.
 */
export function resolveTargetIndex(
  terminalsById: Record<string, TerminalInstance | undefined>,
  panelIds: readonly string[],
  worktreeId: string | null | undefined,
  targetContainer: "grid" | "dock",
  overId: string,
  sortableIndex: number | undefined,
  skipAccordionOver: boolean
): number {
  const containerTerminals = filterTerminalsByContainer(
    terminalsById,
    panelIds,
    targetContainer,
    worktreeId
  );

  if (!skipAccordionOver) {
    const idx = containerTerminals.findIndex((t) => t.id === overId);
    if (idx !== -1) return idx;
  }

  if (sortableIndex !== undefined) return sortableIndex;

  return containerTerminals.length;
}

/**
 * Check whether the grid container is at capacity for a given worktree.
 * Counts explicit TabGroups + ungrouped terminals against maxGridCapacity.
 */
export function isGridFull(
  terminalsById: Record<string, TerminalInstance | undefined>,
  panelIds: readonly string[],
  worktreeId: string | null | undefined,
  tabGroups: Map<string, TabGroup>,
  maxGridCapacity: number
): boolean {
  const gridTerminals = filterTerminalsByContainer(terminalsById, panelIds, "grid", worktreeId);

  const panelsInGroups = new Set<string>();
  let explicitGroupCount = 0;
  for (const group of tabGroups.values()) {
    if (
      group.location === "grid" &&
      (group.worktreeId ?? undefined) === (worktreeId ?? undefined)
    ) {
      explicitGroupCount++;
      for (const pid of group.panelIds) panelsInGroups.add(pid);
    }
  }

  let ungroupedCount = 0;
  for (const t of gridTerminals) {
    if (!panelsInGroups.has(t.id)) ungroupedCount++;
  }

  return explicitGroupCount + ungroupedCount >= maxGridCapacity;
}

/**
 * Find the insertion index for a group among tabGroups.
 * Linear search for group ID or panel membership; falls back to clamped
 * sortableIndex, then last position.
 */
export function resolveGroupPlacementIndex(
  tabGroups: TabGroup[],
  overId: string,
  sortableIndex: number | undefined
): number {
  for (let i = 0; i < tabGroups.length; i++) {
    if (tabGroups[i]!.id === overId || tabGroups[i]!.panelIds.includes(overId)) {
      return i;
    }
  }

  if (sortableIndex !== undefined) {
    return Math.min(Math.max(0, sortableIndex), tabGroups.length - 1);
  }

  return tabGroups.length - 1;
}

/**
 * Find the source (from) group index by matching groupId then panel membership.
 */
export function findGroupIndex(
  tabGroups: TabGroup[],
  groupId: string | undefined,
  terminalId: string
): number {
  const idx = tabGroups.findIndex((g) => g.id === groupId);
  if (idx !== -1) return idx;
  return tabGroups.findIndex((g) => g.panelIds.includes(terminalId));
}
