// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup, act, waitFor } from "@testing-library/react";
import { RecipeConflictDialog } from "../RecipeConflictDialog";
import { useRecipeConflictStore, type RecipeConflictRequest } from "@/store/recipeConflictStore";

// No jest-dom in this repo — plain DOM reads only.

function park(overrides: Partial<RecipeConflictRequest> = {}) {
  const request: RecipeConflictRequest = {
    recipeId: "inrepo-1",
    recipeName: "Build",
    updates: { name: "Build" },
    reason: "stale",
    ...overrides,
  };
  let resolution: string | undefined;
  act(() => {
    void useRecipeConflictStore
      .getState()
      .requestConflict(request)
      .then((r) => {
        resolution = r;
      });
  });
  return () => resolution;
}

function footerButton(role: "leading" | "cancel" | "confirm"): HTMLButtonElement {
  const button = document.querySelector<HTMLButtonElement>(`[data-confirm-role="${role}"]`);
  if (!button) throw new Error(`no ${role} footer action`);
  return button;
}

afterEach(() => {
  act(() => {
    if (useRecipeConflictStore.getState().pendingConflict) {
      useRecipeConflictStore.getState().resolveConflict("cancel");
    }
  });
  useRecipeConflictStore.setState({ pendingConflict: null });
  cleanup();
});

describe("RecipeConflictDialog", () => {
  it("renders nothing when no conflict is pending", () => {
    const { container } = render(<RecipeConflictDialog />);
    expect(container.textContent).toBe("");
  });

  it.each(["stale", "forward-compat"] as const)(
    "never arrives on the overwrite (%s)",
    async (reason) => {
      park({ reason, detail: "build.json — terminal #2" });
      render(<RecipeConflictDialog />);

      const dialog = screen.getByRole("dialog");
      await waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true));
      expect(document.activeElement).not.toBe(footerButton("leading"));
    }
  );

  it("explains an external change for the stale reason", () => {
    park({ reason: "stale" });
    render(<RecipeConflictDialog />);

    const text = document.body.textContent ?? "";
    expect(text).toContain("changed on disk");
    expect(text).toContain("git pull");
    expect(text).not.toContain("can't represent");
    expect(footerButton("leading").textContent).toBe("Overwrite recipe");
    expect(document.querySelector('[data-testid="recipe-conflict-detail"]')).toBeNull();
  });

  it("explains unsupported content and shows the detail for the forward-compat reason", () => {
    park({
      reason: "forward-compat",
      detail: 'build.json — terminal #2 (type "future-agent")',
    });
    render(<RecipeConflictDialog />);

    const text = document.body.textContent ?? "";
    expect(text).toContain("uses unsupported content");
    expect(text).toContain("can't represent");
    // The stale explanation must not leak into this branch — it would send the
    // user looking for someone else's edit that never happened.
    expect(text).not.toContain("git pull");
    expect(screen.getByTestId("recipe-conflict-detail").textContent).toBe(
      'build.json — terminal #2 (type "future-agent")'
    );
    // Overwrite is relabelled, because here it discards content rather than
    // just losing a race.
    expect(footerButton("leading").textContent).toBe("Overwrite and discard");
  });

  it("omits the detail block when the main process sent none", () => {
    park({ reason: "forward-compat" });
    render(<RecipeConflictDialog />);
    expect(document.querySelector('[data-testid="recipe-conflict-detail"]')).toBeNull();
    expect(document.body.textContent).toContain("uses unsupported content");
  });

  it("resolves the awaiting promise from either button, in both reasons", async () => {
    for (const reason of ["stale", "forward-compat"] as const) {
      const read = park({ reason });
      render(<RecipeConflictDialog />);

      act(() => {
        footerButton("leading").click();
      });
      await act(async () => {
        await Promise.resolve();
      });
      expect(read()).toBe("overwrite");
      cleanup();
    }
  });

  it("resolves as reload from the reload button", async () => {
    const read = park({ reason: "forward-compat", detail: "x" });
    render(<RecipeConflictDialog />);

    act(() => {
      footerButton("confirm").click();
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(read()).toBe("reload");
  });

  it("resolves as cancel from the footer's Cancel", async () => {
    const read = park({ reason: "stale" });
    render(<RecipeConflictDialog />);

    act(() => {
      footerButton("cancel").click();
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(read()).toBe("cancel");
  });

  // The destructive answer sits on the footer's leading edge, apart from the
  // Cancel / primary pair, and is never the dialog's one filled button.
  it("keeps the overwrite off the primary slot and away from it", () => {
    park({ reason: "stale" });
    render(<RecipeConflictDialog />);

    const buttons = [...document.querySelectorAll<HTMLElement>("[data-confirm-role]")].map(
      (el) => el.dataset.confirmRole
    );
    expect(buttons).toEqual(["leading", "cancel", "confirm"]);
    expect(footerButton("leading").textContent).toContain("Overwrite");
    expect(footerButton("confirm").textContent).toBe("Reload from disk");
  });
});
