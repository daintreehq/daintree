import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { m } from "framer-motion";
import { cn } from "@/lib/utils";
import { useDndPlaceholder } from "./DndProvider";
import { PlaceholderContent } from "./PlaceholderContent";
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
    return <div className={cn("min-w-[100px] h-full", className)} aria-hidden="true" />;
  }

  const { kind } = activeTerminal;
  const chrome = deriveTerminalChrome(activeTerminal);

  return (
    <div
      className={cn(
        "flex flex-col gap-1 px-3 py-2 min-w-[120px] h-[var(--dock-item-height)] overflow-hidden",
        "rounded border border-border-strong bg-overlay-subtle",
        className
      )}
      aria-hidden="true"
    >
      <PlaceholderContent kind={kind ?? "terminal"} agentId={chrome.agentId ?? undefined} compact />
    </div>
  );
}

export function SortableDockPlaceholder() {
  const { attributes, listeners, setNodeRef, transform, transition } = useSortable({
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
        {...attributes}
        {...listeners}
        className="h-full"
        data-placeholder-id={DOCK_PLACEHOLDER_ID}
      >
        <DockPlaceholder />
      </div>
    </m.div>
  );
}
