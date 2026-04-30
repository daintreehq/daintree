import React, { useRef, useEffect } from "react";
import { Search, Plus } from "lucide-react";
import { RecipeRunnerItem } from "./RecipeRunnerItem";
import type { RecipeSections, RankedRecipe } from "./recipeRunnerUtils";
import type { TerminalRecipe } from "@/types";

interface RecipeRunnerListProps {
  sections: RecipeSections;
  searchQuery: string;
  searchResults: RankedRecipe[];
  focusedIndex: number;
  focusedItemId: string | undefined;
  showSearch: boolean;
  disabled?: boolean;
  onSearchChange: (query: string) => void;
  onKeyDown: (e: React.KeyboardEvent) => void;
  onRun: (id: string) => void;
  onEdit: (id: string) => void;
  onDuplicate: (id: string) => void;
  onPin: (id: string) => void;
  onUnpin: (id: string) => void;
  onDelete: (id: string) => void;
  onCreate: () => void;
}

export function RecipeRunnerList({
  sections,
  searchQuery,
  searchResults,
  focusedIndex,
  focusedItemId,
  showSearch,
  disabled,
  onSearchChange,
  onKeyDown,
  onRun,
  onEdit,
  onDuplicate,
  onPin,
  onUnpin,
  onDelete,
  onCreate,
}: RecipeRunnerListProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const isSearchActive = searchQuery.trim().length > 0;

  useEffect(() => {
    if (showSearch) {
      inputRef.current?.focus();
    }
  }, [showSearch]);

  // Build flat list for index computation
  let flatRecipes: TerminalRecipe[];
  let currentIndex = 0;

  if (isSearchActive) {
    flatRecipes = searchResults.map((r) => r.recipe);
  } else {
    flatRecipes = [...sections.pinned, ...sections.recent, ...sections.all];
  }

  const totalRecipes = flatRecipes.length;
  const createIndex = totalRecipes;

  const renderItem = (recipe: TerminalRecipe) => {
    const itemIndex = currentIndex++;
    return (
      <RecipeRunnerItem
        key={recipe.id}
        recipe={recipe}
        isFocused={focusedIndex === itemIndex}
        mode="list"
        disabled={disabled}
        id={`recipe-option-${recipe.id}`}
        onRun={onRun}
        onEdit={onEdit}
        onDuplicate={onDuplicate}
        onPin={onPin}
        onUnpin={onUnpin}
        onDelete={onDelete}
      />
    );
  };

  return (
    <div onKeyDown={onKeyDown}>
      {showSearch && (
        <div className="mb-2 px-1">
          <div className="relative">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-text-muted pointer-events-none" />
            <input
              ref={inputRef}
              type="text"
              role="combobox"
              aria-expanded={isSearchActive}
              aria-controls="recipe-listbox"
              aria-activedescendant={focusedItemId}
              aria-label="Search recipes"
              value={searchQuery}
              onChange={(e) => onSearchChange(e.target.value)}
              placeholder="Search recipes…"
              className="w-full pl-8 pr-3 py-2 text-sm bg-daintree-sidebar border border-daintree-border rounded-[var(--radius-md)] text-daintree-text placeholder:text-text-muted focus:outline-hidden focus:ring-1 focus:ring-daintree-accent/40 focus:border-daintree-accent/40"
            />
          </div>
        </div>
      )}

      <div role="status" aria-live="polite" className="sr-only">
        {isSearchActive ? `${flatRecipes.length} recipes found` : ""}
      </div>

      <div role="listbox" id="recipe-listbox" aria-label="Recipes" className="flex flex-col gap-1">
        {isSearchActive ? (
          <>
            {flatRecipes.length > 0 ? (
              flatRecipes.map(renderItem)
            ) : (
              <div className="px-3 py-2 text-sm text-text-muted">
                No recipes match &ldquo;{searchQuery}&rdquo;
              </div>
            )}
          </>
        ) : (
          <>
            {sections.pinned.length > 0 && (
              <>
                <div
                  id="section-pinned"
                  className="px-3 pt-1 pb-0.5 text-xs font-medium text-text-muted uppercase tracking-wide"
                  role="presentation"
                >
                  Pinned
                </div>
                <div role="group" aria-labelledby="section-pinned">
                  {sections.pinned.map(renderItem)}
                </div>
              </>
            )}
            {sections.recent.length > 0 && (
              <>
                <div
                  id="section-recent"
                  className="px-3 pt-2 pb-0.5 text-xs font-medium text-text-muted uppercase tracking-wide"
                  role="presentation"
                >
                  Recent
                </div>
                <div role="group" aria-labelledby="section-recent">
                  {sections.recent.map(renderItem)}
                </div>
              </>
            )}
            {sections.all.length > 0 && (
              <>
                <div
                  id="section-all"
                  className="px-3 pt-2 pb-0.5 text-xs font-medium text-text-muted uppercase tracking-wide"
                  role="presentation"
                >
                  All
                </div>
                <div role="group" aria-labelledby="section-all">
                  {sections.all.map(renderItem)}
                </div>
              </>
            )}
          </>
        )}

        <button
          id="recipe-option-create"
          role="option"
          aria-selected={focusedIndex === createIndex}
          type="button"
          onClick={onCreate}
          className="group w-full flex items-center gap-2 px-3 py-2 rounded-[var(--radius-md)] hover:bg-overlay-medium transition-colors text-left focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-daintree-accent aria-selected:ring-2 aria-selected:ring-daintree-accent/60"
        >
          <Plus
            className="h-3.5 w-3.5 text-text-muted group-hover:text-daintree-text transition-colors shrink-0"
            aria-hidden
          />
          <span className="flex-1 text-sm text-text-muted group-hover:text-daintree-text transition-colors">
            {isSearchActive && flatRecipes.length === 0
              ? `Create recipe: "${searchQuery}"`
              : "Create new recipe…"}
          </span>
        </button>
      </div>
    </div>
  );
}
