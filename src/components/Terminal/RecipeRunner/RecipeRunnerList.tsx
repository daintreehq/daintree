import React, { useRef } from "react";
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

  // Deliberately NOT focused on mount. This list is not a palette — it renders
  // inside the canvas home, which a user reaches by closing their last panel or
  // switching worktree, never by asking to search recipes. Focusing here stole
  // the caret from whatever the user was doing every time a project with more
  // than six recipes showed its empty canvas, and painted an accent ring on a
  // surface nobody had navigated to. `ProjectPulseStrip` states the same rule
  // for the same reason: "the empty grid must not steal focus just by
  // rendering". Tab and the arrow keys still reach the field normally.

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
        // The combobox above owns the only tab stop in this composite; every
        // option is reached with the arrow keys and named through
        // `aria-activedescendant`. Left at the default, eight recipes plus
        // Create put nine extra stops between the user and whatever follows
        // the recipe band — the same uncapped tab run the quick-launch chips
        // were fixed for, and what WAI-ARIA's composite-widget contract
        // exists to prevent.
        tabIndex={-1}
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
    // group/recipes scopes the roving aria-selected ring to keyboard use: in
    // list mode focus lives in the combobox input (not the listbox), so the
    // group must wrap both. At rest no ring shows — see RecipeRunnerItem.
    <div className="group/recipes" onKeyDown={onKeyDown}>
      {showSearch && (
        // A labelled header row, not a second full-width search field. Once
        // every band shared one measure this input became the same width and
        // shape as the palette button four bands above it, so the surface
        // showed two equal search anchors and the lower one looked like
        // another way to launch anything. Naming the band and shrinking the
        // input to a filter says what its scope actually is.
        <div className="mb-2 flex items-baseline gap-3 px-1">
          <span
            id="recipe-band-label"
            className="shrink-0 text-[11px] font-medium uppercase tracking-wide text-text-muted"
          >
            Recipes
          </span>
          <div className="relative min-w-0 flex-1">
            <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3 w-3 text-text-muted pointer-events-none" />
            <input
              ref={inputRef}
              type="text"
              role="combobox"
              aria-expanded={isSearchActive}
              aria-controls="recipe-listbox"
              aria-activedescendant={focusedItemId}
              aria-label="Filter recipes"
              value={searchQuery}
              onChange={(e) => onSearchChange(e.target.value)}
              placeholder="Filter recipes…"
              className="w-full rounded-[var(--radius-md)] border border-border-subtle bg-transparent py-1 pl-7 pr-2 text-xs text-daintree-text placeholder:text-text-placeholder focus:border-daintree-accent/40 focus:outline-hidden focus:ring-1 focus:ring-daintree-accent/40"
            />
          </div>
        </div>
      )}

      <div role="status" aria-live="polite" className="sr-only">
        {isSearchActive ? `${flatRecipes.length} recipes found` : ""}
      </div>

      <div
        role="listbox"
        id="recipe-listbox"
        aria-labelledby="recipe-band-label"
        className="flex flex-col gap-1"
      >
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
                <div role="presentation">{sections.pinned.map(renderItem)}</div>
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
                <div role="presentation">{sections.recent.map(renderItem)}</div>
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
                <div role="presentation">{sections.all.map(renderItem)}</div>
              </>
            )}
          </>
        )}

        <button
          id="recipe-option-create"
          role="option"
          aria-selected={focusedIndex === createIndex}
          type="button"
          tabIndex={-1}
          onClick={onCreate}
          className="group w-full flex items-center gap-2 px-3 py-2 rounded-[var(--radius-md)] hover:bg-overlay-medium transition-colors text-left focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-daintree-accent group-focus-within/recipes:aria-selected:ring-2 group-focus-within/recipes:aria-selected:ring-daintree-accent/60"
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
