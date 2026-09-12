import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { m } from "framer-motion";
import { cn } from "@/lib/utils";
import { useDndPlaceholder, GRID_PLACEHOLDER_ID } from "./dndPlaceholderContext";
import { TerminalIcon } from "@/components/Terminal/TerminalIcon";
import { PlaceholderContent } from "./PlaceholderContent";
import { DROP_SLOT_FRAME } from "./dropIndicator";
import { deriveTerminalChrome } from "@/utils/terminalChrome";

interface GridPlaceholderProps {
  className?: string;
}

export function GridPlaceholder({ className }: GridPlaceholderProps) {
  const { activeTerminal } = useDndPlaceholder();

  // Drag visuals mirror chrome: live detection only. A demoted shell dragged
  // across the grid shows plain-terminal styling even though it was launched
  // as an agent — matches what the tab looks like right now.
  const chrome = activeTerminal ? deriveTerminalChrome(activeTerminal) : null;

  return (
    <div
      className={cn(
        "flex h-full w-full flex-col overflow-hidden rounded-lg",
        DROP_SLOT_FRAME,
        "animate-in fade-in duration-200",
        className
      )}
      aria-hidden="true"
    >
      {/* Ghost header — the panel header's own recipe (h-8, sans, medium) so the
          slot reads as the panel that is about to land in it. When the active
          panel is unknown the bar stays, empty: the destination boundary never
          depends on identity data. */}
      <div className="flex h-8 shrink-0 items-center gap-2 border-b border-border-strong/30 bg-overlay-medium px-3 text-xs">
        {activeTerminal && chrome && (
          <>
            <TerminalIcon
              kind={activeTerminal.kind}
              chrome={chrome}
              className="h-3.5 w-3.5 shrink-0"
            />
            <span className="truncate font-medium text-text-secondary">{activeTerminal.title}</span>
          </>
        )}
      </div>

      <div className="flex w-full flex-1 flex-col p-3">
        <PlaceholderContent
          kind={activeTerminal?.kind ?? "unknown"}
          agentId={chrome?.agentId ?? undefined}
        />
      </div>
    </div>
  );
}

export function SortableGridPlaceholder() {
  const { attributes, listeners, setNodeRef, transform, transition } = useSortable({
    id: GRID_PLACEHOLDER_ID,
    data: { container: "grid", isPlaceholder: true },
    animateLayoutChanges: () => false,
  });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
  };

  return (
    <m.div layout="position" className="h-full">
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
    </m.div>
  );
}
