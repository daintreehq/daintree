import { useRef, useCallback } from "react";
import { RecipeRunnerItem } from "./RecipeRunnerItem";
import type { TerminalRecipe } from "@/types";

interface RecipeRunnerGridProps {
  recipes: TerminalRecipe[];
  focusedIndex: number;
  showScope?: boolean;
  disabled?: boolean;
  onRun: (id: string) => void;
  onEdit: (id: string) => void;
  onDuplicate: (id: string) => void;
  onPin: (id: string) => void;
  onUnpin: (id: string) => void;
  onDelete: (id: string) => void;
  setFocusedIndex: (i: number) => void;
}

// Arrow keys follow the grid as it is drawn. Left/Right walk reading order.
// Up/Down are spatial: they land on the card in the next rendered row that sits
// under a remembered column line, so a card spanning the row (the odd last card
// at two columns) is reachable by Down from either card above it, and Up from it
// returns to the column the user came down. A move off the top or bottom stays.
function moveHorizontal(current: number, total: number, key: string): number {
  switch (key) {
    case "ArrowRight":
      return (current + 1) % total;
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

function moveVertical(
  buttons: Array<HTMLButtonElement | null>,
  current: number,
  direction: 1 | -1,
  columnX: number
): number {
  const origin = buttons[current];
  if (!origin) return current;
  const rows = [...new Set(buttons.map((b) => b?.offsetTop).filter((t) => t !== undefined))].sort(
    (a, b) => a - b
  );
  const targetRow = rows[rows.indexOf(origin.offsetTop) + direction];
  if (targetRow === undefined) return current;
  let best = current;
  let bestDistance = Infinity;
  buttons.forEach((button, index) => {
    if (!button || button.offsetTop !== targetRow) return;
    const left = button.offsetLeft;
    const right = left + button.offsetWidth;
    const distance = columnX < left ? left - columnX : columnX > right ? columnX - right : 0;
    if (distance < bestDistance) {
      best = index;
      bestDistance = distance;
    }
  });
  return best;
}

const NAVIGATION_KEYS = new Set(["ArrowRight", "ArrowLeft", "ArrowDown", "ArrowUp", "Home", "End"]);

export function RecipeRunnerGrid({
  recipes,
  focusedIndex,
  showScope,
  disabled,
  onRun,
  onEdit,
  onDuplicate,
  onPin,
  onUnpin,
  onDelete,
  setFocusedIndex,
}: RecipeRunnerGridProps) {
  // A lone recipe spans the measure as one row — a half-empty two-column grid
  // reads as a mistake when there's a single pinned recipe (the common
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
  // The column line a run of Up/Down presses keeps to, and the card that run
  // last landed on. Pressed from anywhere else (a horizontal move, a click, a
  // fresh Tab in), the run starts over from the focused card's centre.
  const columnRunRef = useRef<{ x: number; at: number } | null>(null);

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
    const buttons = buttonRefs.current.slice(0, focusableCount);
    let next: number;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      const origin = buttons[index];
      const x =
        columnRunRef.current?.at === index
          ? columnRunRef.current.x
          : origin
            ? origin.offsetLeft + origin.offsetWidth / 2
            : 0;
      next = moveVertical(buttons, index, e.key === "ArrowDown" ? 1 : -1, x);
      columnRunRef.current = { x, at: next };
    } else {
      next = moveHorizontal(index, focusableCount, e.key);
    }
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
          // A lone recipe is one full-width row in the list's single-line form:
          // as a two-line card stretched across the measure it was a frame
          // around mostly air, and outweighed the resume row above it.
          mode={recipes.length === 1 ? "list" : "grid"}
          showScope={showScope}
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
