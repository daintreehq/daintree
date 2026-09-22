import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { m } from "framer-motion";
import { cn } from "@/lib/utils";
import { useDndPlaceholder } from "./dndPlaceholderContext";
import { PlaceholderContent } from "./PlaceholderContent";
import { DROP_SLOT_FRAME } from "./dropIndicator";
import { deriveTerminalChrome } from "@/utils/terminalChrome";

interface DockPlaceholderProps {
  className?: string;
}

export const DOCK_PLACEHOLDER_ID = "__dock-placeholder__";

export function DockPlaceholder({ className }: DockPlaceholderProps) {
  const { activeTerminal, isDragging } = useDndPlaceholder();

  // When not dragging, render an invisible placeholder that still takes space
  // This maintains the drop target for drag operations without showing a visible artifact
  if (!isDragging || !activeTerminal) {
    return <div className={cn("h-full min-w-25", className)} aria-hidden="true" />;
  }

  const { kind } = activeTerminal;
  const chrome = deriveTerminalChrome(activeTerminal);

  return (
    // Chip geometry — the chips' radius step and height — so the slot reads as
    // the chip that is about to land in it rather than a foreign object in the rail.
    <div
      className={cn(
        "flex h-[var(--dock-item-height)] min-w-30 flex-col justify-center overflow-hidden rounded-md px-3 py-2",
        DROP_SLOT_FRAME,
        className
      )}
      aria-hidden="true"
    >
      <PlaceholderContent kind={kind ?? "terminal"} agentId={chrome.agentId ?? undefined} compact />
    </div>
  );
}

export function SortableDockPlaceholder() {
  // Drop target only — no activator attributes/listeners. Dragging the
  // invisible placeholder itself produced drag data with no `terminal`,
  // which wedged dnd-kit app-wide via a throwing cancelDrop (#11291).
  const { setNodeRef, transform, transition } = useSortable({
    id: DOCK_PLACEHOLDER_ID,
    data: { container: "dock", isPlaceholder: true },
    animateLayoutChanges: () => false,
  });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
  };

  return (
    // No FLIP on the dock path — the placeholder hands off to the first real
    // chip without a shuffle, matching SortableDockItem (#11063).
    <m.div layout={false} className="h-full">
      <div
        ref={setNodeRef}
        style={style}
        className="h-full"
        data-placeholder-id={DOCK_PLACEHOLDER_ID}
      >
        <DockPlaceholder />
      </div>
    </m.div>
  );
}
