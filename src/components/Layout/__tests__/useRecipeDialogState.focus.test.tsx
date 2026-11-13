// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { Component, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppDialog } from "@/components/ui/AppDialog";
import { _resetForTests } from "@/lib/escapeStack";
import { _resetForTests as _resetBackstopForTests } from "@/lib/dialogEscapeBackstop";
import { useRecipeEditorActivityStore } from "@/store/recipeEditorActivityStore";
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

// Stands in for the host's boundary, which reports the failure the same way.
class Boundary extends Component<
  { onError: () => void; children: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch() {
    this.props.onError();
  }
  render() {
    return this.state.failed ? null : this.props.children;
  }
}

const fault = { onClose: false };

function FailsOnClose({ isOpen }: { isOpen: boolean }) {
  if (!isOpen && fault.onClose) throw new Error("manager failed while closing");
  return null;
}

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
      <Boundary onError={recipes.handleRecipeManagerCloseComplete}>
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
            <FailsOnClose isOpen={recipes.isRecipeManagerOpen} />
          </AppDialog.Body>
        </AppDialog>
      </Boundary>
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
    fault.onClose = false;
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

  it("opens the editor, with focus, when the manager fails on its way out", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      render(<Harness />, { container: root });
      const opener = screen.getByRole("button", { name: "Recipes" });
      opener.focus();
      fireEvent.click(opener);
      await settle();

      fault.onClose = true;
      fireEvent.click(screen.getByRole("button", { name: "Edit Dev" }));
      await settle();

      expect(screen.queryByTestId("manager")).toBeNull();
      expect(screen.getByTestId("editor").contains(document.activeElement)).toBe(true);

      fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
      await settle();
      expect(document.activeElement).toBe(opener);
    } finally {
      consoleError.mockRestore();
    }
  });

  it("opens a request kept through a manager reopen once that manager closes", async () => {
    render(<Harness />, { container: root });
    const opener = screen.getByRole("button", { name: "Recipes" });
    opener.focus();
    fireEvent.click(opener);
    await settle();
    fireEvent.click(screen.getByRole("button", { name: "Edit Dev" }));
    act(() => {
      window.dispatchEvent(new CustomEvent("daintree:open-recipe-editor", { detail: {} }));
      window.dispatchEvent(new CustomEvent("daintree:open-recipe-manager"));
    });
    await settle();
    expect(screen.queryByTestId("editor")).toBeNull();

    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    await settle();
    expect(screen.getByTestId("editor").contains(document.activeElement)).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await settle();
    expect(document.activeElement).toBe(opener);
    expect(useRecipeEditorActivityStore.getState().openCount).toBe(0);
  });

  it("keeps focus in the editor for a request that arrives while the manager closes", async () => {
    render(<Harness />, { container: root });
    const opener = screen.getByRole("button", { name: "Recipes" });
    opener.focus();
    fireEvent.click(opener);
    await settle();

    fireEvent.click(screen.getByRole("button", { name: "Edit Dev" }));
    act(() => {
      window.dispatchEvent(
        new CustomEvent("daintree:open-recipe-editor", { detail: { worktreeId: "wt-9" } })
      );
    });
    await settle();

    expect(screen.queryByTestId("manager")).toBeNull();
    expect(screen.getByTestId("editor").contains(document.activeElement)).toBe(true);
  });
});
