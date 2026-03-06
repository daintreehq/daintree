import { cn } from "@/lib/utils";
import type { ActionPaletteItem as ActionPaletteItemType } from "@/hooks/useActionPalette";
import { Tooltip, TooltipContent, TooltipTrigger, TooltipProvider } from "@/components/ui/tooltip";

interface ActionPaletteItemProps {
  item: ActionPaletteItemType;
  isSelected: boolean;
  onSelect: (item: ActionPaletteItemType) => void;
}

const CATEGORY_COLORS: Record<string, string> = {
  terminal: "bg-status-info/15 text-status-info",
  agents: "bg-canopy-accent/15 text-canopy-accent",
  panels: "bg-status-info/15 text-status-info",
  navigation: "bg-status-success/15 text-status-success",
  worktree: "bg-status-warning/15 text-status-warning",
  github: "bg-canopy-text/[0.06] text-canopy-text/50",
  git: "bg-status-warning/15 text-status-warning",
  project: "bg-status-success/15 text-status-success",
  preferences: "bg-canopy-text/[0.06] text-canopy-text/50",
  app: "bg-github-merged/15 text-github-merged",
  system: "bg-status-error/15 text-status-error",
  logs: "bg-status-warning/15 text-status-warning",
  recipes: "bg-canopy-accent/15 text-canopy-accent",
  sidecar: "bg-github-merged/15 text-github-merged",
  notes: "bg-status-success/15 text-status-success",
  browser: "bg-status-info/15 text-status-info",
};

const DEFAULT_CATEGORY_COLOR = "bg-white/[0.06] text-canopy-text/50";

export function ActionPaletteItem({ item, isSelected, onSelect }: ActionPaletteItemProps) {
  const categoryColor = CATEGORY_COLORS[item.category] ?? DEFAULT_CATEGORY_COLOR;

  const buttonContent = (
    <button
      id={`action-option-${item.id}`}
      role="option"
      aria-selected={isSelected}
      aria-disabled={!item.enabled}
      className={cn(
        "relative w-full flex items-center gap-3 px-3 py-2 rounded-[var(--radius-md)] text-left transition-colors border",
        !item.enabled && "opacity-40 cursor-not-allowed",
        isSelected
          ? "bg-white/[0.03] border-overlay text-canopy-text before:absolute before:left-0 before:top-2 before:bottom-2 before:w-[2px] before:rounded-r before:bg-canopy-accent before:content-['']"
          : "border-transparent text-canopy-text/70 hover:bg-white/[0.02] hover:text-canopy-text"
      )}
      onClick={() => onSelect(item)}
    >
      <span
        className={cn(
          "shrink-0 px-1.5 py-0.5 rounded text-[10px] font-medium leading-tight",
          categoryColor
        )}
      >
        {item.category}
      </span>

      <div className="flex-1 min-w-0">
        <div className="text-sm font-medium truncate">{item.title}</div>
        {item.description && (
          <div className="text-xs text-canopy-text/50 truncate">{item.description}</div>
        )}
      </div>

      {item.keybinding && (
        <span className="shrink-0 text-[11px] font-mono text-canopy-text/40">
          {item.keybinding}
        </span>
      )}
    </button>
  );

  if (!item.enabled && item.disabledReason) {
    return (
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="inline-flex w-full">{buttonContent}</span>
          </TooltipTrigger>
          <TooltipContent side="bottom">{item.disabledReason}</TooltipContent>
        </Tooltip>
      </TooltipProvider>
    );
  }

  return buttonContent;
}
