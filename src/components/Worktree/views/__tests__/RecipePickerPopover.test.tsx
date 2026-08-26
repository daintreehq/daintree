// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, within, fireEvent } from "@testing-library/react";
import { RecipePickerPopover } from "../RecipePickerPopover";
import type { TerminalRecipe } from "@/types";

vi.stubGlobal(
  "ResizeObserver",
  class {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
);

function makeRecipe(overrides: Partial<TerminalRecipe> = {}): TerminalRecipe {
  return {
    id: "recipe-1",
    name: "Work",
    terminals: [{ type: "terminal", env: {} }],
    createdAt: 0,
    ...overrides,
  } as TerminalRecipe;
}

function renderPicker(recipes: TerminalRecipe[], props?: { defaultRecipeId?: string }) {
  return render(
    <RecipePickerPopover
      recipes={recipes}
      selectedRecipeId={null}
      selectedRecipe={undefined}
      open={true}
      onOpenChange={vi.fn()}
      onSelectRecipe={vi.fn()}
      onMarkTouched={vi.fn()}
      listId="recipe-list"
      {...props}
    />
  );
}

/** The rows for real recipes, minus the fixed "Clone current layout" / "No recipe" entries. */
function recipeRows() {
  return within(screen.getByRole("listbox"))
    .getAllByRole("option")
    .filter((row) => !/Clone current layout|^No recipe$/.test(row.textContent ?? ""));
}

afterEach(cleanup);

describe("RecipePickerPopover — scope indicator (#11510)", () => {
  it("distinguishes same-named recipes from different scopes", () => {
    renderPicker([
      makeRecipe({ id: "g", name: "Work", projectId: undefined }),
      makeRecipe({ id: "p", name: "Work", projectId: "proj-1" }),
    ]);

    const rows = recipeRows();
    expect(rows).toHaveLength(2);
    expect(rows[0]?.textContent).not.toBe(rows[1]?.textContent);
    expect(rows[0]?.textContent).toContain("Global");
    expect(rows[1]?.textContent).toContain("Project-wide");
  });

  it("labels every row, not just the ones in a name collision", () => {
    renderPicker([
      makeRecipe({ id: "a", name: "Alpha", projectId: "proj-1" }),
      makeRecipe({ id: "b", name: "Beta", projectId: "proj-1", scope: "inrepo" }),
    ]);

    const labels = recipeRows().map((row) => row.textContent ?? "");
    expect(labels[0]).toContain("Project-wide");
    expect(labels[1]).toContain("Team");
  });

  it("carries the scope in the option's accessible name so it reaches assistive tech", () => {
    renderPicker([makeRecipe({ id: "g", name: "Work", projectId: undefined })]);

    expect(screen.getByRole("option", { name: /Work.*Global/ })).toBeTruthy();
  });

  it("lists a shadowed recipe as selectable and marked rather than hiding it", () => {
    const onSelectRecipe = vi.fn<(id: string | null) => void>();
    render(
      <RecipePickerPopover
        recipes={[makeRecipe({ id: "shadowed", name: "Work", shadowedBy: "Work" })]}
        selectedRecipeId={null}
        selectedRecipe={undefined}
        open={true}
        onOpenChange={vi.fn()}
        onSelectRecipe={onSelectRecipe}
        onMarkTouched={vi.fn()}
        listId="recipe-list"
      />
    );

    const row = recipeRows()[0];
    expect(row?.textContent).toContain("Overridden by Team");

    fireEvent.click(row!);
    expect(onSelectRecipe).toHaveBeenCalledWith("shadowed");
  });

  it("marks only the recipe the caller pinned as default", () => {
    renderPicker(
      [
        makeRecipe({ id: "a", name: "Alpha", projectId: "proj-1" }),
        makeRecipe({ id: "b", name: "Beta", projectId: "proj-1" }),
      ],
      { defaultRecipeId: "b" }
    );

    const labels = recipeRows().map((row) => row.textContent ?? "");
    expect(labels.filter((t) => t.includes("(default)"))).toHaveLength(1);
    expect(labels[1]).toContain("(default)");
  });
});
