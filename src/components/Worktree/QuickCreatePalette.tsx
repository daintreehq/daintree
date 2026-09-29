import { useCallback, useState } from "react";
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
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { pluralize } from "@/lib/pluralize";

const TYPE_BADGES: Record<string, string> = {
  terminal: "Terminal",
  claude: "Claude",
  gemini: "Gemini",
  codex: "Codex",
  opencode: "OpenCode",
  "dev-preview": "Dev server",
};

function RecipeListItem({
  item,
  isSelected,
  onClick,
  onHover,
}: {
  item: QuickCreateItem;
  isSelected: boolean;
  onClick: () => void;
  onHover: () => void;
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
        onPointerMove={isSelected ? undefined : onHover}
        onClick={onClick}
        className={cn(
          // Was a hand-rolled copy of the shared row and drifted out of step
          // with it; takes the selected treatment from the family now.
          PALETTE_ROW_CLASS,
          // No resting fill and no hover fill — see the recipe row below.
          "w-full text-left px-3 py-2 rounded-[var(--radius-lg)] flex items-center gap-2"
        )}
        aria-selected={isSelected}
        role="option"
      >
        <Settings2 className="w-4 h-4 text-daintree-text/50" />
        <span className="text-sm text-text-secondary">Customize…</span>
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
      onPointerMove={isSelected ? undefined : onHover}
      onClick={onClick}
      className={cn(
        PALETTE_ROW_CLASS,
        // No resting fill. A backplate on every row made three recipes read as
        // three stacked cards, so the selected one had to out-shout two
        // neighbours instead of being the only lit row. No hover fill either:
        // the pointer moves the cursor, so a hover fill would be a second lit
        // row beside the one Enter acts on.
        "w-full text-left px-3 py-2 rounded-[var(--radius-lg)] flex flex-col gap-0.5"
      )}
      aria-selected={isSelected}
      role="option"
    >
      <div className="flex items-center justify-between gap-2 text-sm">
        {/* Overridden steps the name down the ramp instead of fading the row,
            which took the "Overridden by Team" reason down with it. */}
        <span
          className={cn(
            "font-medium truncate",
            recipe.shadowedBy ? "text-text-secondary" : "text-text-primary"
          )}
        >
          {recipe.name}
        </span>
        <div className="flex items-center gap-1 shrink-0">
          {uniqueTypes.map((type) => (
            <Badge size="xs" key={type}>
              {type}
            </Badge>
          ))}
        </div>
      </div>
      <div className="flex items-center gap-2 text-2xs text-text-secondary">
        <span className="truncate">{getRecipeScope(recipe, () => worktreeName).label}</span>
        {recipe.shadowedBy && <span className="shrink-0">Overridden by Team</span>}
        <span className="ml-auto shrink-0">{pluralize(recipe.terminals.length, "terminal")}</span>
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

  // The assign-to-me toggle under the list belongs to the last recipe the
  // cursor was on, not to whatever the cursor is on now: reaching it with the
  // pointer crosses the Customize row, and a toggle that vanished mid-trip
  // could never be clicked. Adjusted during render, so it never lags a frame.
  const [footerRecipe, setFooterRecipe] = useState(palette.selectedRecipe);
  if (!palette.isOpen && footerRecipe !== null) {
    setFooterRecipe(null);
  } else if (palette.isOpen && palette.selectedRecipe && palette.selectedRecipe !== footerRecipe) {
    setFooterRecipe(palette.selectedRecipe);
  }
  const showAssignToggle = footerRecipe && getAutoAssign(footerRecipe) === "prompt";

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
      onSelectIndex={palette.setSelectedIndex}
      onConfirm={palette.confirmSelection}
      onClose={handleClose}
      getItemId={(item) => item.id}
      // Pointer and keys move one cursor, as in every palette. The assign
      // toggle below stays pinned to the last recipe (`footerRecipe`), so
      // crossing the Customize row on the way to it doesn't hide it.
      onHoverIndex={palette.setSelectedIndex}
      renderItem={(item, index, isSelected, onHover) => (
        <RecipeListItem
          key={item.id}
          item={item}
          isSelected={isSelected}
          onClick={() => {
            palette.confirmItem(item);
          }}
          onHover={() => onHover(index)}
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
          <p className="text-xs text-text-secondary">
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
            <label className="flex w-fit cursor-pointer items-center gap-2 text-xs text-text-secondary hover:text-text-primary">
              <Checkbox
                checked={palette.assignToSelf}
                onCheckedChange={(checked) => palette.setAssignToSelf(checked === true)}
              />
              Assign issue to me
            </label>
          </div>
        ) : undefined
      }
      footer={
        // No `Esc cancel` chip. Escape closes the palette but the pending
        // `worktree.createWithRecipe` keeps running — there is no abort path —
        // so naming it "cancel" promised something the key doesn't do.
        <PaletteFooterHints
          primaryHint={{ keys: ["↵"], label: palette.isPending ? "creating…" : "to create" }}
        />
      }
    />
  );
}
