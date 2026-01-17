import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { cn } from "@/lib/utils";
import { useDndPlaceholder } from "./DndProvider";
import { PlaceholderContent } from "./PlaceholderContent";

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

  const { kind, agentId } = activeTerminal;

  return (
    <div
      className={cn(
        "flex flex-col gap-1 px-3 py-2 min-w-[120px] h-full",
        "rounded border border-canopy-accent/30 bg-canopy-accent/5",
        className
      )}
      aria-hidden="true"
    >
      <PlaceholderContent kind={kind ?? "terminal"} agentId={agentId} compact />
    </div>
  );
}

export function SortableDockPlaceholder() {
  const { attributes, listeners, setNodeRef, transform, transition } = useSortable({
    id: DOCK_PLACEHOLDER_ID,
    data: { container: "dock", isPlaceholder: true },
  });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
  };

  return (
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
  );
}
