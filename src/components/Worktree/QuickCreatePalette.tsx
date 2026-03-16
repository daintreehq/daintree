import { useCallback } from "react";
import { cn } from "@/lib/utils";
import { SearchablePalette } from "@/components/ui/SearchablePalette";
import type { QuickCreateItem, UseQuickCreatePaletteReturn } from "@/hooks/useQuickCreatePalette";
import { getAutoAssign } from "@shared/types/project";
import type { TerminalRecipe } from "@/types";
import { Settings2 } from "lucide-react";
import { useWorktreeSelectionStore } from "@/store/worktreeStore";

const TYPE_BADGES: Record<string, string> = {
  terminal: "Terminal",
  claude: "Claude",
  gemini: "Gemini",
  codex: "Codex",
  opencode: "OpenCode",
  "dev-preview": "Dev Server",
};

function RecipeListItem({
  item,
  isSelected,
  onClick,
}: {
  item: QuickCreateItem;
  isSelected: boolean;
  onClick: () => void;
}) {
  if (item._kind === "customize") {
    return (
      <button
        type="button"
        id={`quick-create-option-${item.id}`}
        onClick={onClick}
        className={cn(
          "w-full text-left px-3 py-2 rounded-[var(--radius-lg)] border flex items-center gap-2",
          "border-canopy-border/40 hover:border-canopy-border/60",
          "bg-canopy-bg hover:bg-surface transition-colors",
          isSelected && "border-canopy-accent/60 bg-canopy-accent/10"
        )}
        aria-selected={isSelected}
        role="option"
      >
        <Settings2 className="w-4 h-4 text-canopy-text/50" />
        <span className="text-sm text-canopy-text/70">Customize…</span>
      </button>
    );
  }

  const recipe = item as TerminalRecipe & { _kind: "recipe" };
  const terminalTypes = recipe.terminals.map((t) => TYPE_BADGES[t.type] ?? t.type);
  const uniqueTypes = [...new Set(terminalTypes)];

  return (
    <button
      type="button"
      id={`quick-create-option-${recipe.id}`}
      onClick={onClick}
      className={cn(
        "w-full text-left px-3 py-2 rounded-[var(--radius-lg)] border flex flex-col gap-0.5",
        "border-canopy-border/40 hover:border-canopy-border/60",
        "bg-canopy-bg hover:bg-surface transition-colors",
        isSelected && "border-canopy-accent/60 bg-canopy-accent/10"
      )}
      aria-selected={isSelected}
      role="option"
    >
      <div className="flex items-center justify-between text-sm">
        <span className="font-medium text-canopy-text">{recipe.name}</span>
        <div className="flex items-center gap-1">
          {uniqueTypes.map((type) => (
            <span
              key={type}
              className="px-1.5 py-0.5 rounded-[var(--radius-md)] bg-canopy-accent/10 text-canopy-text/60 text-[11px]"
            >
              {type}
            </span>
          ))}
        </div>
      </div>
      <div className="text-[11px] text-canopy-text/50">
        {recipe.terminals.length} terminal{recipe.terminals.length !== 1 ? "s" : ""}
      </div>
    </button>
  );
}

export interface QuickCreatePaletteProps {
  palette: UseQuickCreatePaletteReturn;
}

export function QuickCreatePalette({ palette }: QuickCreatePaletteProps) {
  const closeQuickCreate = useWorktreeSelectionStore((s) => s.closeQuickCreate);
  const handleClose = useCallback(() => {
    closeQuickCreate();
    palette.close();
  }, [closeQuickCreate, palette]);

  const showAssignToggle =
    palette.selectedRecipe && getAutoAssign(palette.selectedRecipe) === "prompt";

  return (
    <SearchablePalette<QuickCreateItem>
      isOpen={palette.isOpen}
      query={palette.query}
      results={palette.results}
      selectedIndex={palette.selectedIndex}
      onQueryChange={palette.setQuery}
      onSelectPrevious={palette.selectPrevious}
      onSelectNext={palette.selectNext}
      onConfirm={palette.confirmSelection}
      onClose={handleClose}
      getItemId={(item) => item.id}
      renderItem={(item, _index, isSelected) => (
        <RecipeListItem
          key={item.id}
          item={item}
          isSelected={isSelected}
          onClick={() => {
            palette.confirmItem(item);
          }}
        />
      )}
      label="Quick create worktree"
      ariaLabel="Quick create worktree palette"
      searchPlaceholder="Search recipes..."
      searchAriaLabel="Search recipes"
      listId="quick-create-palette-list"
      itemIdPrefix="quick-create-option"
      emptyMessage="No recipes yet — create one in the recipe editor"
      noMatchMessage={`No recipes match "${palette.query}"`}
      totalResults={palette.totalResults}
      afterList={
        showAssignToggle ? (
          <div className="px-3 py-2 border-t border-canopy-border/40">
            <label className="flex items-center gap-2 cursor-pointer text-sm text-canopy-text/70">
              <input
                type="checkbox"
                checked={palette.assignToSelf}
                onChange={(e) => palette.setAssignToSelf(e.target.checked)}
                className="w-3.5 h-3.5 rounded border-canopy-border bg-canopy-bg checked:bg-canopy-accent"
              />
              Assign issue to me
            </label>
          </div>
        ) : undefined
      }
      footer={
        <div className="flex items-center gap-3 text-xs text-canopy-text/40">
          <span>
            <kbd className="px-1 py-0.5 rounded bg-canopy-bg border border-canopy-border/40 text-[11px]">
              ↵
            </kbd>{" "}
            {palette.isPending ? "Creating…" : "Create"}
          </span>
          <span>
            <kbd className="px-1 py-0.5 rounded bg-canopy-bg border border-canopy-border/40 text-[11px]">
              Esc
            </kbd>{" "}
            Cancel
          </span>
        </div>
      }
    />
  );
}
