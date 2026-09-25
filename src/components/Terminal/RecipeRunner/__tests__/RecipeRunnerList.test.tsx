// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
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

  it("still exposes the filter to the keyboard", () => {
    renderList();
    // Not focusing it is not the same as hiding it: Tab must still reach it.
    // Queried by role and accessible name rather than placeholder text, so a
    // copy change cannot fail a test about keyboard reachability.
    const field = screen.getByRole("combobox", { name: /recipes/i });
    expect(field.hasAttribute("disabled")).toBe(false);
    expect(field.getAttribute("tabindex")).not.toBe("-1");
  });

  it("keeps the whole listbox to a single tab stop", () => {
    renderList();
    // The combobox owns the stop; seven recipes plus Create must not add eight
    // more. Counted, not spot-checked — the failure mode is a count.
    const stops = screen
      .getAllByRole("option")
      .filter((el) => el.getAttribute("tabindex") !== "-1");
    expect(stops).toEqual([]);
  });
});

describe("RecipeRunnerList — the row Enter will act on stays on screen", () => {
  function listWith(focusedItemId: string | undefined) {
    return (
      <RecipeRunnerList
        sections={buildRecipeSections(RECIPES)}
        searchQuery=""
        searchResults={[]}
        focusedIndex={0}
        focusedItemId={focusedItemId}
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

  it("reveals the active option while the filter owns focus, and only then", () => {
    const scrolled: string[] = [];
    const original = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = function (this: Element) {
      scrolled.push(this.id);
    };
    try {
      const { rerender } = render(listWith("recipe-option-a"));
      // A list that merely re-rendered must not scroll the canvas under the user.
      rerender(listWith("recipe-option-g"));
      expect(scrolled).toEqual([]);

      screen.getByRole("combobox", { name: "Filter recipes" }).focus();
      rerender(listWith("recipe-option-f"));
      expect(scrolled).toEqual(["recipe-option-f"]);
    } finally {
      Element.prototype.scrollIntoView = original;
    }
  });
});

describe("RecipeRunnerList — only the filter owns the launch keys", () => {
  it("leaves keys on the band's other controls to those controls", () => {
    const seen: string[] = [];
    render(
      <RecipeRunnerList
        sections={buildRecipeSections(RECIPES)}
        searchQuery=""
        searchResults={[]}
        focusedIndex={0}
        focusedItemId="recipe-option-a"
        showSearch
        onSearchChange={noop}
        onKeyDown={(e) => seen.push(e.key)}
        onRun={noop}
        onEdit={noop}
        onDuplicate={noop}
        onPin={noop}
        onUnpin={noop}
        onDelete={noop}
        onCreate={noop}
        onManage={noop}
      />
    );
    // Enter on Manage must activate Manage, never launch the active recipe.
    fireEvent.keyDown(screen.getByRole("button", { name: "Manage" }), { key: "Enter" });
    expect(seen).toEqual([]);
    fireEvent.keyDown(screen.getByRole("combobox", { name: "Filter recipes" }), { key: "Enter" });
    expect(seen).toEqual(["Enter"]);
  });
});
