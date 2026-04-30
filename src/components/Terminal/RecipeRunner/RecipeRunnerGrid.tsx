import { Plus } from "lucide-react";
import { RecipeRunnerItem } from "./RecipeRunnerItem";
import type { TerminalRecipe } from "@/types";

interface RecipeRunnerGridProps {
  recipes: TerminalRecipe[];
  focusedIndex: number;
  disabled?: boolean;
  onRun: (id: string) => void;
  onEdit: (id: string) => void;
  onDuplicate: (id: string) => void;
  onPin: (id: string) => void;
  onUnpin: (id: string) => void;
  onDelete: (id: string) => void;
  onCreate: () => void;
  onKeyDown: (e: React.KeyboardEvent) => void;
}

export function RecipeRunnerGrid({
  recipes,
  focusedIndex,
  disabled,
  onRun,
  onEdit,
  onDuplicate,
  onPin,
  onUnpin,
  onDelete,
  onCreate,
  onKeyDown,
}: RecipeRunnerGridProps) {
  const gridCols = recipes.length <= 2 ? "grid-cols-2" : "grid-cols-3";

  return (
    <div onKeyDown={onKeyDown}>
      <div
        role="listbox"
        id="recipe-listbox"
        aria-label="Recipes"
        className={`grid ${gridCols} gap-2`}
      >
        {recipes.map((recipe, i) => (
          <RecipeRunnerItem
            key={recipe.id}
            recipe={recipe}
            isFocused={focusedIndex === i}
            mode="grid"
            disabled={disabled}
            id={`recipe-option-${recipe.id}`}
            onRun={onRun}
            onEdit={onEdit}
            onDuplicate={onDuplicate}
            onPin={onPin}
            onUnpin={onUnpin}
            onDelete={onDelete}
          />
        ))}
        <button
          id="recipe-option-create"
          role="option"
          aria-selected={focusedIndex === recipes.length}
          type="button"
          onClick={onCreate}
          className="group col-span-full flex items-center justify-center gap-2 px-3 py-2 mt-1 rounded-[var(--radius-md)] hover:bg-overlay-medium transition-colors text-left focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-daintree-accent aria-selected:ring-2 aria-selected:ring-daintree-accent/60"
        >
          <Plus
            className="h-3.5 w-3.5 text-text-muted group-hover:text-daintree-text transition-colors shrink-0"
            aria-hidden
          />
          <span className="text-sm text-text-muted group-hover:text-daintree-text transition-colors">
            Create new recipe…
          </span>
        </button>
      </div>
    </div>
  );
}
