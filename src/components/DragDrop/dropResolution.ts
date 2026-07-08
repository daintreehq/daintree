import type { TabGroup } from "@shared/types";
import { getNarrowPanel } from "@/store/slices/panelRegistry/selectors";

type CarrierPanel = Parameters<typeof getNarrowPanel>[0][string];

export interface OverDropData {
  container?: "grid" | "dock";
  sortable?: { containerId?: string; index?: number };
  type?: string;
  worktreeId?: string;
}

/** Minimal shape of a dnd-kit `ClientRect` — the fields the geometry math reads. */
export interface ClientRectLike {
  top: number;
  left: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
}

/**
 * Dead-zone (px) around a slot's horizontal midpoint where the before/after
 * decision holds its previous value. Inserting the placeholder shifts the
 * hovered panel's rect under MeasuringStrategy.Always, which would otherwise
 * flip the verdict frame-to-frame and flicker the placeholder.
 */
export const GRID_INSERTION_HYSTERESIS_PX = 8;

function isUsableRect(rect: ClientRectLike | null | undefined): rect is ClientRectLike {
  return (
    !!rect &&
    Number.isFinite(rect.left) &&
    Number.isFinite(rect.top) &&
    Number.isFinite(rect.bottom) &&
    Number.isFinite(rect.width) &&
    Number.isFinite(rect.height) &&
    rect.width > 0 &&
    rect.height > 0
  );
}

/**
 * Decide whether a dragged item lands before or after the slot it hovers,
 * returning `baseIndex` (before) or `baseIndex + 1` (after). Reading-order
 * geometry for a 2-D grid: a drag center above the target row inserts before,
 * below the row inserts after, and within the row the horizontal midpoint
 * splits before/after. Missing/degenerate geometry and exact horizontal ties
 * bias toward after (append) so a dock→grid drop with no clear slot lands last,
 * not first.
 *
 * `previousIndex` (the last resolved index for the same hover target) engages a
 * hysteresis dead-zone at the horizontal midpoint so the verdict does not
 * oscillate as the placeholder reflows the target's rect. It is honored only
 * when it belongs to this target (adjacent to `baseIndex`).
 */
export function resolveGridInsertionIndexFromRects(
  baseIndex: number,
  activeRect: ClientRectLike | null | undefined,
  overRect: ClientRectLike | null | undefined,
  previousIndex?: number,
  hysteresisPx: number = GRID_INSERTION_HYSTERESIS_PX
): number {
  const before = baseIndex;
  const after = baseIndex + 1;

  if (!isUsableRect(activeRect) || !isUsableRect(overRect)) return after;

  const centerX = activeRect.left + activeRect.width / 2;
  const centerY = activeRect.top + activeRect.height / 2;

  // Different row than the target: reading order decides outright.
  if (centerY < overRect.top) return before;
  if (centerY >= overRect.bottom) return after;

  // Same row: split on the horizontal midpoint, exact ties bias after.
  const midX = overRect.left + overRect.width / 2;
  const raw = centerX >= midX ? after : before;

  if (
    (previousIndex === before || previousIndex === after) &&
    Math.abs(centerX - midX) < hysteresisPx
  ) {
    return previousIndex;
  }

  return raw;
}

/** Map dnd-kit container ID strings ("grid-container", "dock-container") to containers. */
export function resolveContainerId(containerId: string): "grid" | "dock" | null {
  if (containerId === "grid-container") return "grid";
  if (containerId === "dock-container") return "dock";
  return null;
}

/** Filter terminals to those in a given container and worktree, preserving panelIds order. */
export function filterTerminalsByContainer(
  terminalsById: Record<string, CarrierPanel | undefined>,
  panelIds: readonly string[],
  container: "grid" | "dock",
  worktreeId: string | null | undefined
): CarrierPanel[] {
  const result: CarrierPanel[] = [];
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
  terminalsById: Record<string, CarrierPanel | undefined>,
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
 *
 * When `geometry` is supplied (dock→grid single-terminal drops), an exact
 * terminal match resolves before/after the hovered panel via rect geometry
 * instead of always landing before it, so any slot — including after a single
 * existing panel — is reachable in one drag.
 */
export function resolveTargetIndex(
  terminalsById: Record<string, CarrierPanel | undefined>,
  panelIds: readonly string[],
  worktreeId: string | null | undefined,
  targetContainer: "grid" | "dock",
  overId: string,
  sortableIndex: number | undefined,
  skipAccordionOver: boolean,
  geometry?: {
    activeRect?: ClientRectLike | null;
    overRect?: ClientRectLike | null;
    /**
     * The drag-over hysteresis verdict (after vs before the hovered target),
     * space-agnostic so it reconstructs against this terminal-space index. Kept
     * as a boolean rather than an absolute index because the placeholder preview
     * resolves in group-space, which diverges from terminal-space when an
     * earlier multi-panel group shifts the flat indices.
     */
    previousAfter?: boolean;
  }
): number {
  const containerTerminals = filterTerminalsByContainer(
    terminalsById,
    panelIds,
    targetContainer,
    worktreeId
  );

  if (!skipAccordionOver) {
    const idx = containerTerminals.findIndex((t) => t.id === overId);
    if (idx !== -1) {
      if (geometry) {
        const previousIndex =
          geometry.previousAfter === undefined ? undefined : geometry.previousAfter ? idx + 1 : idx;
        return resolveGridInsertionIndexFromRects(
          idx,
          geometry.activeRect,
          geometry.overRect,
          previousIndex
        );
      }
      return idx;
    }
  }

  if (sortableIndex !== undefined) return sortableIndex;

  return containerTerminals.length;
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
