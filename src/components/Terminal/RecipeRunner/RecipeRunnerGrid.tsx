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
  setFocusedIndex: (i: number) => void;
}

// Arrow keys follow the grid as it is drawn. Left/Right walk reading order;
// Up/Down move a whole row, by however many columns the container query has
// left — Down from the first card in a two-column grid lands on the card
// under it, not the one beside it. A move off the top or bottom stays put.
function moveFocus(current: number, total: number, key: string, columns: number): number {
  switch (key) {
    case "ArrowRight":
      return (current + 1) % total;
    case "ArrowLeft":
      return (current - 1 + total) % total;
    case "ArrowDown":
      return current + columns < total ? current + columns : current;
    case "ArrowUp":
      return current - columns >= 0 ? current - columns : current;
    case "Home":
      return 0;
    case "End":
      return total - 1;
    default:
      return current;
  }
}

const NAVIGATION_KEYS = new Set(["ArrowRight", "ArrowLeft", "ArrowDown", "ArrowUp", "Home", "End"]);

/** Cards sharing the first card's row: the column count the layout resolved to. */
function renderedColumns(buttons: Array<HTMLButtonElement | null>): number {
  const first = buttons[0];
  if (!first) return 1;
  let columns = 0;
  for (const button of buttons) {
    if (!button || button.offsetTop !== first.offsetTop) break;
    columns++;
  }
  return Math.max(1, columns);
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
        : // At two columns an odd last card spans the row, the same call the
          // lone-recipe case makes, instead of sitting half-width beside a hole.
          "grid-cols-3 @max-[34rem]/launcher:grid-cols-2 @max-[34rem]/launcher:[&>:last-child:nth-child(odd)]:col-span-full @max-[26rem]/launcher:grid-cols-1";
  const focusableCount = recipes.length;
  // The hook's cursor also counts list mode's Create row, one past the last
  // recipe. Clamped here, or a cursor left there would give no card the tab
  // stop and the grid would be unreachable by Tab.
  const activeIndex = Math.min(focusedIndex, Math.max(0, focusableCount - 1));
  const buttonRefs = useRef<Array<HTMLButtonElement | null>>([]);

  const setButtonRef = useCallback(
    (index: number) => (el: HTMLButtonElement | null) => {
      buttonRefs.current[index] = el;
    },
    []
  );

  const handleOptionKeyDown = (index: number) => (e: React.KeyboardEvent<HTMLButtonElement>) => {
    if (e.altKey || e.ctrlKey || e.metaKey) return;
    if (!NAVIGATION_KEYS.has(e.key)) return;
    // Claimed even when the cursor cannot move (Down on the bottom row, any
    // arrow with one recipe): otherwise the key falls through and scrolls the
    // canvas while focus stays put.
    e.preventDefault();
    const next = moveFocus(
      index,
      focusableCount,
      e.key,
      renderedColumns(buttonRefs.current.slice(0, focusableCount))
    );
    if (next === index) return;
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
          isFocused={activeIndex === i}
          mode="grid"
          disabled={disabled}
          id={`recipe-option-${recipe.id}`}
          tabIndex={activeIndex === i ? 0 : -1}
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
    </div>
  );
}
