import { useRef, useState } from "react";
import { useDndMonitor, type Active, type Over, type UniqueIdentifier } from "@dnd-kit/core";

/**
 * True when `over` is the container itself or an item sorted inside it. dnd-kit's
 * own `isOver` matches the container's id only, so on its own the frame went
 * out the moment the pointer crossed one of the container's children.
 */
export function isOverContainer(over: Over | null, containerId: UniqueIdentifier): boolean {
  if (!over) return false;
  if (over.id === containerId) return true;
  const data = over.data.current as { sortable?: { containerId?: UniqueIdentifier } } | undefined;
  return data?.sortable?.containerId === containerId;
}

interface ArmedDropTargetOptions {
  /** Whether a drop over `over` would land in this container. */
  accepts: (over: Over) => boolean;
  /** Whether the drag started in this container, read once at pickup. */
  isOrigin: (active: Active) => boolean;
  /** A drag this container refuses never arms it. */
  disabled?: boolean;
}

/**
 * Whether a container should draw DROP_TARGET_FRAME: the drop would land in it
 * and move something in from elsewhere. A reorder inside the container arms
 * nothing, because the insertion line or slot already says where it lands.
 * Monitor-driven, so it adds a render to its host only when the answer flips,
 * not on every change of `over`.
 */
export function useArmedDropTarget({
  accepts,
  isOrigin,
  disabled = false,
}: ArmedDropTargetOptions): boolean {
  const [armed, setArmed] = useState(false);
  // Read at pickup and held: a host that relocates the item mid-drag (the
  // toolbar columns do) would otherwise start calling itself the origin.
  const originRef = useRef(false);

  useDndMonitor({
    onDragStart: ({ active }) => {
      originRef.current = isOrigin(active);
      setArmed(false);
    },
    onDragOver: ({ over }) => {
      setArmed(over !== null && !originRef.current && accepts(over));
    },
    onDragEnd: () => setArmed(false),
    onDragCancel: () => setArmed(false),
  });

  return armed && !disabled;
}

/**
 * Which panel container a drag left, or null for anything that is not a panel
 * moving between the grid and the dock (a worktree session dragged out of the
 * sidebar accordion, a worktree card).
 */
export function panelDragOrigin(active: Active): "grid" | "dock" | null {
  const data = active.data.current as
    { sourceLocation?: "grid" | "dock"; origin?: string } | undefined;
  if (!data || data.origin === "accordion") return null;
  return data.sourceLocation ?? null;
}
