import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { cn } from "@/lib/utils";
import { useDndPlaceholder, GRID_PLACEHOLDER_ID } from "./DndProvider";
import { TerminalIcon } from "@/components/Terminal/TerminalIcon";
import { PlaceholderContent } from "./PlaceholderContent";

interface GridPlaceholderProps {
  className?: string;
}

export function GridPlaceholder({ className }: GridPlaceholderProps) {
  const { activeTerminal } = useDndPlaceholder();

  // Fallback: render simple background if terminal data unavailable
  if (!activeTerminal) {
    return <div className={cn("h-full rounded-[var(--radius-lg)] bg-daintree-bg/50", className)} />;
  }

  const { title, kind, agentId, detectedAgentId, detectedProcessId } = activeTerminal;

  return (
    <div
      className={cn(
        "h-full w-full rounded flex flex-col overflow-hidden",
        "border border-daintree-accent/40 bg-daintree-accent/5",
        "animate-in fade-in duration-200",
        className
      )}
      aria-hidden="true"
    >
      {/* Ghost Handle / Header */}
      <div
        className={cn(
          "flex items-center gap-2 px-3 h-7 shrink-0 font-mono text-xs",
          "bg-daintree-accent/10 border-b border-daintree-accent/10"
        )}
      >
        <span className="shrink-0 flex items-center justify-center text-daintree-accent/80">
          <TerminalIcon
            kind={kind}
            agentId={agentId}
            detectedAgentId={detectedAgentId}
            detectedProcessId={detectedProcessId}
            className="w-3.5 h-3.5"
          />
        </span>
        <span className="font-medium text-daintree-accent/80 truncate opacity-80">{title}</span>
      </div>

      {/* Panel-specific placeholder body */}
      <div className="flex-1 w-full p-3">
        <PlaceholderContent kind={kind ?? "terminal"} agentId={agentId} />
      </div>
    </div>
  );
}

export function SortableGridPlaceholder() {
  const { attributes, listeners, setNodeRef, transform, transition } = useSortable({
    id: GRID_PLACEHOLDER_ID,
    data: { container: "grid", isPlaceholder: true },
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
      className="h-full contain-layout contain-style"
      data-placeholder-id={GRID_PLACEHOLDER_ID}
    >
      <GridPlaceholder />
    </div>
  );
}
