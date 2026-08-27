// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { RecipeRunnerList } from "../RecipeRunnerList";
import { buildRecipeSections } from "../recipeRunnerUtils";
import type { TerminalRecipe } from "@/types";

function makeRecipe(id: string, name: string, pinned = false): TerminalRecipe {
  return {
    id,
    name,
    terminals: [{ type: "terminal", env: {} }],
    createdAt: 0,
    showInEmptyState: pinned,
  };
}

// Past six recipes the runner swaps its card grid for this searchable list.
const RECIPES = [
  makeRecipe("a", "Review & ship", true),
  makeRecipe("b", "Work an issue", true),
  makeRecipe("c", "Cut a release candidate"),
  makeRecipe("d", "Dev stack"),
  makeRecipe("e", "Docs sweep"),
  makeRecipe("f", "Pair debug"),
  makeRecipe("g", "Perf audit"),
];

const noop = () => {};

function renderList() {
  return render(
    <RecipeRunnerList
      sections={buildRecipeSections(RECIPES)}
      searchQuery=""
      searchResults={[]}
      focusedIndex={0}
      focusedItemId={undefined}
      showSearch
      onSearchChange={noop}
      onKeyDown={noop}
      onRun={noop}
      onEdit={noop}
      onDuplicate={noop}
      onPin={noop}
      onUnpin={noop}
      onDelete={noop}
      onCreate={noop}
    />
  );
}

describe("RecipeRunnerList — the canvas home does not take the caret", () => {
  it("leaves focus where it was when the searchable list mounts", () => {
    renderList();
    // This list renders inside the empty canvas, which a user reaches by
    // closing their last panel or switching worktree — never by asking to
    // search recipes. Taking focus here steals the caret from whatever they
    // were doing, and paints an accent ring on a surface nobody navigated to.
    // Sibling `ProjectPulseStrip` states the same rule for the same reason.
    expect(document.activeElement).toBe(document.body);
  });

  it("still exposes the search field to the keyboard", () => {
    renderList();
    // Not focusing it is not the same as hiding it: Tab must still reach it.
    const field = screen.getByPlaceholderText(/search recipes/i);
    expect(field.hasAttribute("disabled")).toBe(false);
    expect(field.getAttribute("tabindex")).not.toBe("-1");
  });
});
