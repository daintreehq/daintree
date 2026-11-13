// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { useState, type Ref } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TerminalRecipe } from "@/types";
import { _resetForTests } from "@/lib/escapeStack";
import { _resetForTests as _resetBackstopForTests } from "@/lib/dialogEscapeBackstop";

vi.mock("@/store/portalStore", () => ({
  usePortalStore: () => ({ isOpen: false, width: 0 }),
}));

vi.mock("@/hooks/useOverlayState", () => ({
  useOverlayState: () => {},
}));

vi.mock("@/lib/scrollbarGutter", () => ({
  SCROLLBAR_GUTTER_VAR: "--app-scrollbar-gutter",
  measureScrollbarGutter: vi.fn(() => 0),
  publishScrollbarGutter: vi.fn(() => 0),
}));

vi.mock("@/store/projectSettingsStore", () => ({
  useProjectSettingsStore: <T,>(selector: (state: { allDetectedRunners: [] }) => T) =>
    selector({ allDetectedRunners: [] }),
}));

vi.mock("@/store/panelStore", () => ({
  usePanelStore: <T,>(selector: (state: { addPanel: () => Promise<null> }) => T) =>
    selector({ addPanel: async () => null }),
}));

const dispatchMock = vi.hoisted(() => vi.fn());
vi.mock("@/services/ActionService", () => ({
  actionService: { dispatch: dispatchMock },
}));

// The card, with its context menu reduced to the one item: like the real menu,
// it is gone by the time the confirm it opened closes.
vi.mock("../RecipeRunnerItem", () => ({
  RecipeRunnerItem: ({
    recipe,
    id,
    tabIndex,
    disabled,
    buttonRef,
    onFocus,
    onDelete,
  }: {
    recipe: TerminalRecipe;
    id: string;
    tabIndex?: number;
    disabled?: boolean;
    buttonRef?: Ref<HTMLButtonElement>;
    onFocus?: () => void;
    onDelete: (id: string) => void;
  }) => {
    const [menuOpen, setMenuOpen] = useState(true);
    return (
      <>
        <button
          type="button"
          role="option"
          aria-selected={false}
          id={id}
          ref={buttonRef}
          tabIndex={tabIndex}
          disabled={disabled}
          onFocus={onFocus}
        >
          {recipe.name}
        </button>
        {menuOpen && (
          <button
            type="button"
            onClick={() => {
              onDelete(recipe.id);
              setMenuOpen(false);
            }}
          >
            Delete {recipe.name}
          </button>
        )}
      </>
    );
  },
}));

vi.stubGlobal(
  "ResizeObserver",
  class {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
);

import { useRecipeStore } from "@/store/recipeStore";
import { RecipeRunner } from "../RecipeRunner";

function recipe(id: string, name: string): TerminalRecipe {
  return { id, name, terminals: [{ type: "terminal", env: {} }], createdAt: 0 };
}

describe("RecipeRunner delete confirm (#16906)", () => {
  let root: HTMLElement;

  beforeEach(() => {
    _resetForTests();
    _resetBackstopForTests();
    vi.useFakeTimers();
    vi.stubGlobal("matchMedia", vi.fn().mockReturnValue({ matches: false }));
    dispatchMock.mockReset().mockImplementation(async (id: string, args: { recipeId: string }) => {
      if (id === "recipe.delete") {
        useRecipeStore.setState((state) => ({
          recipes: state.recipes.filter((r) => r.id !== args.recipeId),
        }));
      }
      return { ok: true, result: undefined };
    });
    root = document.createElement("div");
    root.id = "root";
    document.body.appendChild(root);
  });

  afterEach(() => {
    cleanup();
    root.remove();
    vi.useRealTimers();
    useRecipeStore.setState({ recipes: [] });
    _resetForTests();
    _resetBackstopForTests();
  });

  // In steps finer than a frame, each its own act, so exits and first-frame
  // focus land in the order they would on screen.
  const settle = async (ms = 500) => {
    for (let elapsed = 0; elapsed < ms; elapsed += 4) {
      await act(() => vi.advanceTimersByTimeAsync(4));
    }
  };

  async function askToDelete(recipes: TerminalRecipe[], name: string) {
    useRecipeStore.setState({ recipes });
    const view = render(<RecipeRunner activeWorktreeId="wt-1" defaultCwd="/repo" />, {
      container: root,
    });
    await settle();
    const trigger = screen.getByRole("button", { name: `Delete ${name}` });
    trigger.focus();
    fireEvent.click(trigger);
    await settle();
    const dialog = screen.getByRole("alertdialog");
    expect(within(dialog).getByText(`Delete '${name}'?`)).toBeTruthy();
    return Object.assign(dialog, { rerender: view.rerender });
  }

  const three = () => [recipe("r1", "Dev server"), recipe("r2", "Docs"), recipe("r3", "Lint")];

  it("returns focus to the recipe's card when the delete is cancelled", async () => {
    const dialog = await askToDelete(
      [recipe("r1", "Dev server"), recipe("r2", "Docs")],
      "Dev server"
    );

    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await settle(40);
    expect(within(dialog).getByText("Delete 'Dev server'?")).toBeTruthy();
    await settle();

    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(document.activeElement?.id).toBe("recipe-option-r1");
  });

  it("names the deleted recipe through the exit, then focuses the card in its place", async () => {
    const dialog = await askToDelete(
      [recipe("r1", "Dev server"), recipe("r2", "Docs")],
      "Dev server"
    );

    fireEvent.click(within(dialog).getByRole("button", { name: "Delete recipe" }));
    await settle(40);
    expect(useRecipeStore.getState().recipes.map((r) => r.id)).toEqual(["r2"]);
    expect(within(dialog).getByText("Delete 'Dev server'?")).toBeTruthy();
    await settle();

    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(document.activeElement?.id).toBe("recipe-option-r2");
  });

  it("focuses the card before the last one when the last is deleted", async () => {
    const dialog = await askToDelete(three(), "Lint");

    fireEvent.click(within(dialog).getByRole("button", { name: "Delete recipe" }));
    await settle();

    expect(dispatchMock).toHaveBeenCalledWith(
      "recipe.delete",
      { recipeId: "r3" },
      { source: "user", confirmed: true }
    );
    expect(document.activeElement?.id).toBe("recipe-option-r2");
  });

  it("passes over cards that can't take focus, to Create", async () => {
    const dialog = await askToDelete(three(), "Docs");

    // The worktree's folder went away while the confirm was open.
    dialog.rerender(<RecipeRunner activeWorktreeId="wt-1" defaultCwd={undefined} />);
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await settle();

    expect(document.activeElement).toBe(screen.getByRole("button", { name: /Create new recipe/ }));
  });

  it("returns focus to the filter, on the recipe's row, in search mode", async () => {
    const many = Array.from({ length: 7 }, (_, i) => recipe(`r${i + 1}`, `Recipe ${i + 1}`));
    const dialog = await askToDelete(many, "Recipe 4");

    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await settle();

    const filter = screen.getByRole("combobox", { name: "Filter recipes" });
    expect(document.activeElement).toBe(filter);
    expect(filter.getAttribute("aria-activedescendant")).toBe("recipe-option-r4");
  });

  it("keeps the dialog through the switch to the empty state, then focuses Create", async () => {
    const dialog = await askToDelete([recipe("r1", "Dev server")], "Dev server");

    fireEvent.click(within(dialog).getByRole("button", { name: "Delete recipe" }));
    await settle(40);
    expect(screen.getByTestId("recipe-runner-empty")).toBeTruthy();
    expect(screen.getByRole("alertdialog")).toBe(dialog);
    expect(within(dialog).getByText("Delete 'Dev server'?")).toBeTruthy();
    await settle();

    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: /Create your first recipe/ })
    );
  });

  it("locks the confirm while the delete runs", async () => {
    let finish: (value: { ok: true; result: undefined }) => void = () => {};
    dispatchMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        })
    );
    const dialog = await askToDelete(
      [recipe("r1", "Dev server"), recipe("r2", "Docs")],
      "Dev server"
    );

    fireEvent.click(within(dialog).getByRole("button", { name: "Delete recipe" }));
    await settle(40);
    // Footer actions say they're unavailable with aria-disabled, and stay focusable.
    const cancel = within(dialog).getByRole("button", { name: "Cancel" });
    expect(cancel.getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(cancel);
    await settle(40);
    expect(screen.getByRole("alertdialog")).toBe(dialog);

    await act(async () => {
      finish({ ok: true, result: undefined });
    });
    await settle();
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });
});
