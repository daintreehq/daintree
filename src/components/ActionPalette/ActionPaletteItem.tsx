import { cn } from "@/lib/utils";
import type { ActionPaletteItem as ActionPaletteItemType } from "@/hooks/useActionPalette";

interface ActionPaletteItemProps {
  item: ActionPaletteItemType;
  isSelected: boolean;
  onSelect: (item: ActionPaletteItemType) => void;
}

const CATEGORY_COLORS: Record<string, string> = {
  terminal: "bg-blue-500/15 text-blue-400",
  agents: "bg-purple-500/15 text-purple-400",
  panels: "bg-cyan-500/15 text-cyan-400",
  navigation: "bg-green-500/15 text-green-400",
  worktree: "bg-amber-500/15 text-amber-400",
  github: "bg-gray-500/15 text-gray-400",
  git: "bg-orange-500/15 text-orange-400",
  project: "bg-teal-500/15 text-teal-400",
  preferences: "bg-slate-500/15 text-slate-400",
  app: "bg-indigo-500/15 text-indigo-400",
  system: "bg-rose-500/15 text-rose-400",
  logs: "bg-yellow-500/15 text-yellow-400",
  recipes: "bg-pink-500/15 text-pink-400",
  sidecar: "bg-violet-500/15 text-violet-400",
  notes: "bg-lime-500/15 text-lime-400",
  browser: "bg-sky-500/15 text-sky-400",
};

const DEFAULT_CATEGORY_COLOR = "bg-white/[0.06] text-canopy-text/50";

export function ActionPaletteItem({ item, isSelected, onSelect }: ActionPaletteItemProps) {
  const categoryColor = CATEGORY_COLORS[item.category] ?? DEFAULT_CATEGORY_COLOR;

  return (
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
      title={!item.enabled ? item.disabledReason : undefined}
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
}
