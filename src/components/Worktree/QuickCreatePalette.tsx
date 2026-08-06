import { useCallback } from "react";
import { cn } from "@/lib/utils";
import { PALETTE_ROW_CLASS } from "@/components/ui/paletteRowStyles";
import { SearchablePalette } from "@/components/ui/SearchablePalette";
import { PaletteFooterHints } from "@/components/ui/AppPaletteDialog";
import type { QuickCreateItem, UseQuickCreatePaletteReturn } from "@/hooks/useQuickCreatePalette";
import { getAutoAssign } from "@shared/types/project";
import type { TerminalRecipe } from "@/types";
import { getRecipeScope, worktreeDisplayName } from "@/utils/recipeScope";
import { Settings2 } from "lucide-react";
import { useWorktreeStore } from "@/hooks/useWorktreeStore";
import { useWorktreeSelectionStore } from "@/store/worktreeStore";
import { actionService } from "@/services/ActionService";
import { Button } from "@/components/ui/button";

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
  // The palette lists recipes from every worktree, so two same-named
  // worktree-scoped recipes need their worktree names to tell them apart.
  const worktreeId = item._kind === "recipe" ? item.worktreeId : undefined;
  const worktreeName = useWorktreeStore((s) =>
    worktreeId ? worktreeDisplayName(s.worktrees.get(worktreeId)) : undefined
  );

  if (item._kind === "customize") {
    return (
      <button
        type="button"
        tabIndex={-1}
        onPointerDown={(e) => e.preventDefault()}
        id={`quick-create-option-${item.id}`}
        onClick={onClick}
        className={cn(
          // Was a hand-rolled copy of the shared row and drifted out of step
          // with it; takes the selected treatment from the family now.
          PALETTE_ROW_CLASS,
          "w-full text-left px-3 py-2 rounded-[var(--radius-lg)] flex items-center gap-2",
          "bg-daintree-bg hover:bg-surface"
        )}
        aria-selected={isSelected}
        role="option"
      >
        <Settings2 className="w-4 h-4 text-daintree-text/50" />
        <span className="text-sm text-daintree-text/70">Customize…</span>
      </button>
    );
  }

  const recipe = item as TerminalRecipe & { _kind: "recipe" };
  const terminalTypes = recipe.terminals.map((t) => TYPE_BADGES[t.type] ?? t.type);
  const uniqueTypes = [...new Set(terminalTypes)];

  return (
    <button
      type="button"
      tabIndex={-1}
      onPointerDown={(e) => e.preventDefault()}
      id={`quick-create-option-${recipe.id}`}
      onClick={onClick}
      className={cn(
        PALETTE_ROW_CLASS,
        "w-full text-left px-3 py-2 rounded-[var(--radius-lg)] flex flex-col gap-0.5",
        "bg-daintree-bg hover:bg-surface",
        recipe.shadowedBy && "opacity-60"
      )}
      aria-selected={isSelected}
      role="option"
    >
      <div className="flex items-center justify-between gap-2 text-sm">
        <span className="font-medium text-daintree-text truncate">{recipe.name}</span>
        <div className="flex items-center gap-1 shrink-0">
          {uniqueTypes.map((type) => (
            <span
              key={type}
              className="px-1.5 py-0.5 rounded-[var(--radius-md)] bg-overlay-medium text-daintree-text/70 text-[11px]"
            >
              {type}
            </span>
          ))}
        </div>
      </div>
      <div className="flex items-center gap-2 text-[11px] text-daintree-text/50">
        <span className="truncate">{getRecipeScope(recipe, () => worktreeName).label}</span>
        {recipe.shadowedBy && <span className="shrink-0">Overridden by Team</span>}
        <span className="ml-auto shrink-0">
          {recipe.terminals.length} terminal{recipe.terminals.length !== 1 ? "s" : ""}
        </span>
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

  const handleOpenRecipeEditor = useCallback(() => {
    closeQuickCreate();
    palette.close();
    void actionService.dispatch("recipe.manager.open", undefined, { source: "user" });
  }, [closeQuickCreate, palette]);

  const showAssignToggle =
    palette.selectedRecipe && getAutoAssign(palette.selectedRecipe) === "prompt";

  return (
    <SearchablePalette<QuickCreateItem>
      tier="anchored"
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
      searchPlaceholder="Search recipes"
      searchAriaLabel="Search recipes"
      listId="quick-create-palette-list"
      itemIdPrefix="quick-create-option"
      emptyMessage="No recipes yet"
      emptyContent={
        <div className="flex flex-col items-center gap-3 mt-4">
          <p className="text-xs text-daintree-text/40">
            Create a recipe in the recipe editor to get started.
          </p>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={handleOpenRecipeEditor}
            className="gap-1.5"
          >
            <Settings2 className="w-3.5 h-3.5" />
            <span>Open recipe editor</span>
          </Button>
        </div>
      }
      totalResults={palette.totalResults}
      afterList={
        showAssignToggle ? (
          <div className="px-3 py-2 border-t border-daintree-border/40">
            <label className="flex items-center gap-2 cursor-pointer text-sm text-daintree-text/70">
              <input
                type="checkbox"
                checked={palette.assignToSelf}
                onChange={(e) => palette.setAssignToSelf(e.target.checked)}
                className="w-3.5 h-3.5 rounded border-daintree-border bg-daintree-bg checked:bg-daintree-accent"
              />
              Assign issue to me
            </label>
          </div>
        ) : undefined
      }
      footer={
        <PaletteFooterHints
          primaryHint={{ keys: ["↵"], label: palette.isPending ? "creating…" : "to create" }}
          hints={[{ keys: ["Esc"], label: "cancel" }]}
        />
      }
    />
  );
}
