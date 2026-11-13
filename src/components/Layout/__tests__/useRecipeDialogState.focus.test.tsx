// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppDialog } from "@/components/ui/AppDialog";
import { _resetForTests } from "@/lib/escapeStack";
import { _resetForTests as _resetBackstopForTests } from "@/lib/dialogEscapeBackstop";
import type { TerminalRecipe } from "@/types";
import { useRecipeDialogState } from "../useRecipeDialogState";

vi.mock("zustand/react/shallow", () => ({
  useShallow: (fn: unknown) => fn,
}));

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

vi.stubGlobal(
  "ResizeObserver",
  class {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
);

const RECIPE: TerminalRecipe = {
  id: "recipe-dev",
  name: "Dev",
  projectId: "project-1",
  terminals: [],
  createdAt: 0,
};

// The real dialogs and their real exits: the manager's runs 120ms, longer than
// the 100ms the editor used to wait before opening.
function Harness() {
  const recipes = useRecipeDialogState();
  return (
    <>
      <button
        type="button"
        onClick={() => window.dispatchEvent(new CustomEvent("daintree:open-recipe-manager"))}
      >
        Recipes
      </button>
      <AppDialog
        isOpen={recipes.isRecipeManagerOpen}
        onClose={recipes.handleCloseRecipeManager}
        onCloseComplete={recipes.handleRecipeManagerCloseComplete}
        data-testid="manager"
      >
        <AppDialog.Body>
          <button type="button" onClick={() => recipes.handleRecipeManagerEdit(RECIPE)}>
            Edit Dev
          </button>
          <button type="button" onClick={() => recipes.handleRecipeManagerCreate("project")}>
            New project recipe
          </button>
        </AppDialog.Body>
      </AppDialog>
      <AppDialog
        isOpen={recipes.isRecipeEditorOpen}
        onClose={recipes.handleCloseRecipeEditor}
        data-testid="editor"
      >
        <AppDialog.Body>
          <input aria-label="Recipe name" />
          <button type="button" onClick={recipes.handleCloseRecipeEditor}>
            Cancel
          </button>
        </AppDialog.Body>
      </AppDialog>
    </>
  );
}

describe("recipe manager → editor focus (#16906)", () => {
  let root: HTMLElement;

  beforeEach(() => {
    _resetForTests();
    _resetBackstopForTests();
    vi.useFakeTimers();
    vi.stubGlobal("matchMedia", vi.fn().mockReturnValue({ matches: false }));
    root = document.createElement("div");
    root.id = "root";
    document.body.appendChild(root);
  });

  afterEach(() => {
    cleanup();
    root.remove();
    vi.useRealTimers();
    _resetForTests();
    _resetBackstopForTests();
  });

  // In steps finer than a frame, each its own act: one act around the whole
  // span holds every commit to its end, and coarse steps do the same in small,
  // either way putting a timer-opened dialog's first-frame focus after a restore
  // that really runs later.
  const settle = async () => {
    for (let elapsed = 0; elapsed < 500; elapsed += 4) {
      await act(() => vi.advanceTimersByTimeAsync(4));
    }
  };

  it.each(["Edit Dev", "New project recipe"])(
    "keeps focus in the editor after %s, and returns it to the manager's opener",
    async (pick) => {
      render(<Harness />, { container: root });
      const opener = screen.getByRole("button", { name: "Recipes" });
      opener.focus();
      fireEvent.click(opener);
      await settle();
      expect(screen.getByTestId("manager").contains(document.activeElement)).toBe(true);

      fireEvent.click(screen.getByRole("button", { name: pick }));
      await settle();

      expect(screen.queryByTestId("manager")).toBeNull();
      expect(screen.getByTestId("editor").contains(document.activeElement)).toBe(true);

      fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
      await settle();

      expect(screen.queryByTestId("editor")).toBeNull();
      expect(document.activeElement).toBe(opener);
    }
  );
});
