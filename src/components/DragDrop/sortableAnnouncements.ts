import type { Announcements, UniqueIdentifier } from "@dnd-kit/core";

export type SortableLabelResolver = (id: UniqueIdentifier) => string | null | undefined;

/**
 * Build a stable `Announcements` object for a sortable list whose items are
 * looked up by `id`. Designed for nested `DndContext` instances inside a
 * surface that doesn't share the global DndProvider's data model.
 *
 * The returned object is pure — wrap the call in `useMemo` so dnd-kit's
 * accessibility live region isn't torn down on every render.
 */
export function makeSortableAnnouncements(
  getLabel: SortableLabelResolver,
  itemNoun: string
): Announcements {
  const resolve = (id: UniqueIdentifier): string => {
    const label = getLabel(id);
    return label != null && label.trim() !== "" ? label : `${itemNoun} ${String(id)}`;
  };

  // Pin the list size at pickup so filter/reorder mutations mid-drag don't
  // churn the denominator the drop string reads. Reset on end/cancel so the
  // next drag pins a fresh size.
  let pinnedTotal: number | null = null;

  return {
    onDragStart({ active }) {
      const data = active.data.current as { sortable?: { items?: unknown[] } } | undefined;
      const total = data?.sortable?.items?.length;
      pinnedTotal = typeof total === "number" ? total : null;
      return `Picked up ${resolve(active.id)}. Press arrow keys to move, Space to drop, Escape to cancel.`;
    },
    onDragOver({ active, over }) {
      const label = resolve(active.id);
      if (over) {
        return `${label} is over ${resolve(over.id)}`;
      }
      return `${label} is no longer over a droppable area`;
    },
    onDragEnd({ active, over }) {
      const label = resolve(active.id);
      if (!over) {
        pinnedTotal = null;
        return `${label} returned to its original position`;
      }
      const overData = over.data.current as { sortable?: { index?: number } } | undefined;
      const destIndex = overData?.sortable?.index;
      const total = pinnedTotal;
      pinnedTotal = null;
      if (typeof destIndex === "number" && total !== null && total > 0) {
        return `Dropped ${label} at position ${destIndex + 1} of ${total}`;
      }
      return `Dropped ${label}`;
    },
    onDragCancel({ active }) {
      pinnedTotal = null;
      const label = resolve(active.id);
      return `Drag cancelled. ${label} returned to its original position`;
    },
  };
}
