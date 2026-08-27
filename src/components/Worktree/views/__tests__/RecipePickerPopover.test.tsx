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
    .filter((row) => row.getAttribute("data-option-kind") === "recipe");
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

describe("RecipePickerPopover — keyboard", () => {
  function renderOpen(overrides: Partial<React.ComponentProps<typeof RecipePickerPopover>> = {}) {
    const props = {
      recipes: [makeRecipe({ id: "a", name: "Alpha" }), makeRecipe({ id: "b", name: "Beta" })],
      selectedRecipeId: null,
      selectedRecipe: undefined,
      open: true,
      onOpenChange: vi.fn(),
      onSelectRecipe: vi.fn(),
      onMarkTouched: vi.fn(),
      listId: "recipe-list",
      ...overrides,
    };
    render(<RecipePickerPopover {...props} />);
    return props;
  }

  /** The one row the cursor is on. Fails loudly if the list ever lights two. */
  function cursorRow() {
    const lit = within(screen.getByRole("listbox"))
      .getAllByRole("option")
      .filter((row) => row.getAttribute("aria-selected") === "true");
    expect(lit).toHaveLength(1);
    return lit[0]!;
  }

  /** The cursor row's position among all rows — the fact the assertions care about. */
  function cursorIndex() {
    const rows = within(screen.getByRole("listbox")).getAllByRole("option");
    return rows.indexOf(cursorRow());
  }

  it("drives the list from the trigger rather than making every row a tab stop", () => {
    renderOpen();

    const rows = within(screen.getByRole("listbox")).getAllByRole("option");
    expect(rows.some((row) => row.hasAttribute("tabindex"))).toBe(false);
    // The announcement and the highlight are one fact, whatever the id scheme.
    expect(screen.getByRole("combobox").getAttribute("aria-activedescendant")).toBe(cursorRow().id);
  });

  it("moves the cursor with the arrow keys and commits it on Enter", () => {
    const props = renderOpen();
    const trigger = screen.getByRole("combobox");

    fireEvent.keyDown(trigger, { key: "ArrowDown" });
    fireEvent.keyDown(trigger, { key: "ArrowDown" });
    expect(cursorIndex()).toBe(2);
    expect(trigger.getAttribute("aria-activedescendant")).toBe(cursorRow().id);

    fireEvent.keyDown(trigger, { key: "Enter" });
    // Row 2 is the first real recipe — the two fixed rows lead the list.
    expect(props.onSelectRecipe).toHaveBeenCalledWith("a");
    expect(props.onMarkTouched).toHaveBeenCalled();
  });

  it("jumps to the ends with Home and End", () => {
    renderOpen();
    const trigger = screen.getByRole("combobox");
    const rowCount = within(screen.getByRole("listbox")).getAllByRole("option").length;

    fireEvent.keyDown(trigger, { key: "End" });
    expect(cursorIndex()).toBe(rowCount - 1);

    fireEvent.keyDown(trigger, { key: "Home" });
    expect(cursorIndex()).toBe(0);
  });

  it("leaves a modified Enter to the dialog's submit shortcut", () => {
    const props = renderOpen();

    fireEvent.keyDown(screen.getByRole("combobox"), { key: "Enter", metaKey: true });

    expect(props.onSelectRecipe).not.toHaveBeenCalled();
    expect(props.onOpenChange).not.toHaveBeenCalled();
  });

  it("closes on Escape without letting it reach the dialog behind the popover", () => {
    const props = renderOpen();
    const trigger = screen.getByRole("combobox");

    // The popover portals out of the dialog that logically contains it, so an
    // Escape left to bubble would dismiss the dialog as well as the list.
    const reachedDocument = vi.fn();
    document.addEventListener("keydown", reachedDocument);
    try {
      fireEvent.keyDown(trigger, { key: "Escape" });
    } finally {
      document.removeEventListener("keydown", reachedDocument);
    }

    expect(props.onOpenChange).toHaveBeenCalledWith(false);
    expect(reachedDocument).not.toHaveBeenCalled();
  });

  it("opens on ArrowDown when closed", () => {
    const props = renderOpen({ open: false });

    fireEvent.keyDown(screen.getByRole("combobox"), { key: "ArrowDown" });
    expect(props.onOpenChange).toHaveBeenCalledWith(true);
  });

  it("marks the committed recipe with aria-current, leaving aria-selected to the cursor", () => {
    renderOpen({ selectedRecipeId: "b" });

    const rows = within(screen.getByRole("listbox")).getAllByRole("option");
    const current = rows.filter((row) => row.getAttribute("aria-current") === "true");
    expect(current).toHaveLength(1);
    expect(current[0]?.textContent).toContain("Beta");
    expect(rows.filter((row) => row.getAttribute("aria-selected") === "true")).toHaveLength(1);
  });
});
