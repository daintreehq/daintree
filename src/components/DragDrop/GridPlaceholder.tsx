import { Terminal } from "lucide-react";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { ClaudeIcon, GeminiIcon, CodexIcon } from "@/components/icons";
import { cn } from "@/lib/utils";
import { getBrandColorHex } from "@/lib/colorUtils";
import { useDndPlaceholder, GRID_PLACEHOLDER_ID } from "./DndProvider";
import type { TerminalType } from "@/types";

interface GridPlaceholderProps {
  className?: string;
}

function getPlaceholderIcon(type: TerminalType) {
  const brandColor = getBrandColorHex(type);
  const props = {
    className: "w-3.5 h-3.5",
    "aria-hidden": "true" as const,
  };
  const customProps = { ...props, brandColor };

  switch (type) {
    case "claude":
      return <ClaudeIcon {...customProps} />;
    case "gemini":
      return <GeminiIcon {...customProps} />;
    case "codex":
      return <CodexIcon {...customProps} />;
    case "terminal":
    default:
      return <Terminal {...props} />;
  }
}

export function GridPlaceholder({ className }: GridPlaceholderProps) {
  const { activeTerminal } = useDndPlaceholder();

  // Fallback: render simple background if terminal data unavailable
  if (!activeTerminal) {
    return <div className={cn("h-full rounded-lg bg-canopy-bg/50", className)} />;
  }

  const { title, type } = activeTerminal;

  return (
    <div
      className={cn(
        "h-full w-full rounded flex flex-col overflow-hidden",
        "border border-canopy-accent/40 bg-canopy-accent/5",
        "animate-in fade-in duration-200",
        className
      )}
      aria-hidden="true"
    >
      {/* Ghost Handle / Header */}
      <div
        className={cn(
          "flex items-center gap-2 px-3 h-7 shrink-0 font-mono text-xs",
          "bg-canopy-accent/10 border-b border-canopy-accent/10"
        )}
      >
        <span className="shrink-0 flex items-center justify-center text-canopy-accent/80">
          {getPlaceholderIcon(type)}
        </span>
        <span className="font-medium text-canopy-accent/80 truncate opacity-80">{title}</span>
      </div>

      {/* Empty Body */}
      <div className="flex-1 w-full bg-transparent" />
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
      className="h-full"
      data-placeholder-id={GRID_PLACEHOLDER_ID}
    >
      <GridPlaceholder />
    </div>
  );
}
