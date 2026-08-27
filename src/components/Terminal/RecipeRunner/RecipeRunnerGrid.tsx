import { Plus } from "lucide-react";
import { useRef, useCallback } from "react";
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
  setFocusedIndex: (i: number) => void;
}

function moveFocus(current: number, total: number, key: string): number {
  switch (key) {
    case "ArrowDown":
    case "ArrowRight":
      return (current + 1) % total;
    case "ArrowUp":
    case "ArrowLeft":
      return (current - 1 + total) % total;
    case "Home":
      return 0;
    case "End":
      return total - 1;
    default:
      return current;
  }
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
  setFocusedIndex,
}: RecipeRunnerGridProps) {
  // A lone recipe renders as one full-width hero card — a half-empty two-column
  // grid reads as a mistake when there's a single pinned recipe (the common
  // fresh-worktree case).
  //
  // The container-query overrides drop columns as the CANVAS narrows, not the
  // window: this grid sits beside a sidebar, so a viewport breakpoint measures
  // the wrong box. Held at three columns, a 550px canvas gave each card ~148px
  // and truncated every name to an unreadable stub ("Review & s…", "Work an
  // is…") while each card still reserved a full line for its scope label. Three
  // names nobody can read is worse than one column of names they can.
  const gridCols =
    recipes.length === 1
      ? "grid-cols-1"
      : recipes.length === 2
        ? "grid-cols-2 @max-[26rem]/launcher:grid-cols-1"
        : "grid-cols-3 @max-[34rem]/launcher:grid-cols-2 @max-[26rem]/launcher:grid-cols-1";
  const createIndex = recipes.length;
  const focusableCount = recipes.length + 1;
  const buttonRefs = useRef<Array<HTMLButtonElement | null>>([]);

  const setButtonRef = useCallback(
    (index: number) => (el: HTMLButtonElement | null) => {
      buttonRefs.current[index] = el;
    },
    []
  );

  const handleOptionKeyDown = (index: number) => (e: React.KeyboardEvent<HTMLButtonElement>) => {
    if (e.altKey || e.ctrlKey || e.metaKey) return;
    const next = moveFocus(index, focusableCount, e.key);
    if (next === index) return;
    e.preventDefault();
    setFocusedIndex(next);
    buttonRefs.current[next]?.focus();
  };

  return (
    <div
      role="listbox"
      id="recipe-listbox"
      aria-label="Recipes"
      className={`group/recipes grid ${gridCols} gap-2`}
    >
      {recipes.map((recipe, i) => (
        <RecipeRunnerItem
          key={recipe.id}
          recipe={recipe}
          isFocused={focusedIndex === i}
          mode="grid"
          disabled={disabled}
          id={`recipe-option-${recipe.id}`}
          tabIndex={focusedIndex === i ? 0 : -1}
          buttonRef={setButtonRef(i)}
          onFocus={() => setFocusedIndex(i)}
          onKeyDown={handleOptionKeyDown(i)}
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
        ref={setButtonRef(createIndex)}
        role="option"
        aria-selected={focusedIndex === createIndex}
        type="button"
        onClick={onCreate}
        onFocus={() => setFocusedIndex(createIndex)}
        onKeyDown={handleOptionKeyDown(createIndex)}
        tabIndex={disabled || focusedIndex === createIndex ? 0 : -1}
        className="group col-span-full flex items-center justify-center gap-2 px-3 py-2 mt-1 rounded-[var(--radius-md)] hover:bg-overlay-medium transition-colors text-left focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-accent-primary group-focus-within/recipes:aria-selected:ring-2 group-focus-within/recipes:aria-selected:ring-daintree-accent/60"
      >
        <Plus
          className="h-3.5 w-3.5 text-text-secondary group-hover:text-text-primary transition-colors shrink-0"
          aria-hidden
        />
        <span className="text-sm text-text-secondary group-hover:text-text-primary transition-colors">
          Create new recipe…
        </span>
      </button>
    </div>
  );
}
