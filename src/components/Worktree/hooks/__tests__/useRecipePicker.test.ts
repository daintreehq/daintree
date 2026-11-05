/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useRecipePicker, CLONE_LAYOUT_ID } from "../useRecipePicker";
import type { TerminalRecipe } from "@/types";

function makeRecipe(id: string, name = id): TerminalRecipe {
  return {
    id,
    name,
    terminals: [{ type: "terminal" }],
    createdAt: Date.now(),
  } as TerminalRecipe;
}

const defaultArgs = {
  isOpen: true,
  defaultRecipeId: undefined as string | undefined,
  startingLayoutRecipes: [] as TerminalRecipe[],
  lastSelectedWorktreeRecipeId: undefined as string | null | undefined,
  projectId: "test-project",
  initialRecipeId: undefined as string | null | undefined,
  setLastSelectedWorktreeRecipeIdByProject: vi.fn(),
};

describe("useRecipePicker", () => {
  it("auto-selects CLONE_LAYOUT_ID when no recipes, no defaults, no last-selected", () => {
    const { result } = renderHook(() => useRecipePicker({ ...defaultArgs }));
    expect(result.current.selectedRecipeId).toBe(CLONE_LAYOUT_ID);
  });

  it("preserves null when lastSelected is null (user chose Empty)", () => {
    const { result } = renderHook(() =>
      useRecipePicker({ ...defaultArgs, lastSelectedWorktreeRecipeId: null })
    );
    expect(result.current.selectedRecipeId).toBe(null);
  });

  it("preserves CLONE_LAYOUT_ID when lastSelected is CLONE_LAYOUT_ID", () => {
    const { result } = renderHook(() =>
      useRecipePicker({ ...defaultArgs, lastSelectedWorktreeRecipeId: CLONE_LAYOUT_ID })
    );
    expect(result.current.selectedRecipeId).toBe(CLONE_LAYOUT_ID);
  });

  it("selects defaultRecipeId when available and no lastSelected", () => {
    const recipes = [makeRecipe("recipe-1")];
    const { result } = renderHook(() =>
      useRecipePicker({
        ...defaultArgs,
        startingLayoutRecipes: recipes,
        defaultRecipeId: "recipe-1",
      })
    );
    expect(result.current.selectedRecipeId).toBe("recipe-1");
  });

  it("falls back to CLONE_LAYOUT_ID when defaultRecipeId is not in startingLayoutRecipes", () => {
    const { result } = renderHook(() =>
      useRecipePicker({ ...defaultArgs, defaultRecipeId: "nonexistent" })
    );
    expect(result.current.selectedRecipeId).toBe(CLONE_LAYOUT_ID);
  });

  it("selects initialRecipeId over everything when valid", () => {
    const recipes = [makeRecipe("recipe-1"), makeRecipe("recipe-2")];
    const { result } = renderHook(() =>
      useRecipePicker({
        ...defaultArgs,
        startingLayoutRecipes: recipes,
        defaultRecipeId: "recipe-1",
        initialRecipeId: "recipe-2",
      })
    );
    expect(result.current.selectedRecipeId).toBe("recipe-2");
  });

  describe("a Retry's recipe", () => {
    const recipes = [makeRecipe("recipe-1"), makeRecipe("recipe-2")];
    const remembered = {
      ...defaultArgs,
      startingLayoutRecipes: recipes,
      defaultRecipeId: "recipe-1",
      lastSelectedWorktreeRecipeId: "recipe-1",
      initialRecipeId: "recipe-1",
    };

    it.each([
      ["No recipe", null],
      ["a cloned layout", CLONE_LAYOUT_ID],
      ["a listed recipe", "recipe-2"],
    ])("keeps %s over the initial, remembered and default recipe", (_label, restoredRecipeId) => {
      const { result } = renderHook(() => useRecipePicker({ ...remembered, restoredRecipeId }));
      expect(result.current.selectedRecipeId).toBe(restoredRecipeId);
    });

    it("waits for its recipe to load rather than settling on the remembered one", () => {
      const { result, rerender } = renderHook(
        (props: { startingLayoutRecipes: TerminalRecipe[] }) =>
          useRecipePicker({ ...remembered, ...props, restoredRecipeId: "recipe-2" }),
        { initialProps: { startingLayoutRecipes: [makeRecipe("recipe-1")] } }
      );
      expect(result.current.selectedRecipeId).toBe("recipe-1");

      rerender({ startingLayoutRecipes: recipes });
      expect(result.current.selectedRecipeId).toBe("recipe-2");
    });

    it("lands on its recipe when the same refresh drops the one it was waiting on", () => {
      const { result, rerender } = renderHook(
        (props: { startingLayoutRecipes: TerminalRecipe[] }) =>
          useRecipePicker({ ...remembered, ...props, restoredRecipeId: "recipe-2" }),
        { initialProps: { startingLayoutRecipes: [makeRecipe("recipe-1")] } }
      );
      expect(result.current.selectedRecipeId).toBe("recipe-1");

      rerender({ startingLayoutRecipes: [makeRecipe("recipe-2")] });
      expect(result.current.selectedRecipeId).toBe("recipe-2");
    });
  });

  it("does not invalidate CLONE_LAYOUT_ID as stale", () => {
    const setter = vi.fn();
    const { result, rerender } = renderHook((props) => useRecipePicker(props), {
      initialProps: { ...defaultArgs, setLastSelectedWorktreeRecipeIdByProject: setter },
    });
    expect(result.current.selectedRecipeId).toBe(CLONE_LAYOUT_ID);
    setter.mockClear();

    // Simulate recipes changing (triggers stale invalidation effect)
    rerender({
      ...defaultArgs,
      setLastSelectedWorktreeRecipeIdByProject: setter,
      startingLayoutRecipes: [makeRecipe("new-recipe")],
    });
    expect(result.current.selectedRecipeId).toBe(CLONE_LAYOUT_ID);
    expect(setter).not.toHaveBeenCalled();
  });

  it("does not auto-select when dialog is closed", () => {
    const { result } = renderHook(() => useRecipePicker({ ...defaultArgs, isOpen: false }));
    // Default state is null (no auto-selection runs when closed)
    expect(result.current.selectedRecipeId).toBe(null);
  });

  it("selects initialRecipeId over a remembered recipe", () => {
    const recipes = [makeRecipe("recipe-1"), makeRecipe("recipe-2")];
    const { result } = renderHook(() =>
      useRecipePicker({
        ...defaultArgs,
        startingLayoutRecipes: recipes,
        lastSelectedWorktreeRecipeId: "recipe-1",
        initialRecipeId: "recipe-2",
      })
    );
    expect(result.current.selectedRecipeId).toBe("recipe-2");
  });

  it("clears a stale remembered recipe and falls back to the project default", () => {
    const setter = vi.fn();
    const { result } = renderHook(() =>
      useRecipePicker({
        ...defaultArgs,
        startingLayoutRecipes: [makeRecipe("project-default")],
        defaultRecipeId: "project-default",
        lastSelectedWorktreeRecipeId: "deleted-recipe",
        setLastSelectedWorktreeRecipeIdByProject: setter,
      })
    );
    expect(setter).toHaveBeenCalledWith("test-project", undefined);
    expect(result.current.selectedRecipeId).toBe("project-default");
  });

  it("reseeds from the memory it is handed when a kept-mounted picker reopens (#16283)", () => {
    const recipes = [makeRecipe("issue-recipe")];
    const bareSetter = vi.fn();
    const issueSetter = vi.fn();
    const { result, rerender } = renderHook((props) => useRecipePicker(props), {
      initialProps: {
        ...defaultArgs,
        startingLayoutRecipes: recipes,
        lastSelectedWorktreeRecipeId: "issue-recipe" as string | null | undefined,
        setLastSelectedWorktreeRecipeIdByProject: issueSetter,
      },
    });
    expect(result.current.selectedRecipeId).toBe("issue-recipe");
    act(() => {
      result.current.recipeSelectionTouchedRef.current = true;
      result.current.setSelectedRecipeId(CLONE_LAYOUT_ID);
    });

    rerender({
      ...defaultArgs,
      isOpen: false,
      startingLayoutRecipes: recipes,
      lastSelectedWorktreeRecipeId: null,
      setLastSelectedWorktreeRecipeIdByProject: bareSetter,
    });
    rerender({
      ...defaultArgs,
      startingLayoutRecipes: recipes,
      lastSelectedWorktreeRecipeId: null,
      setLastSelectedWorktreeRecipeIdByProject: bareSetter,
    });

    expect(result.current.selectedRecipeId).toBeNull();
    expect(bareSetter).not.toHaveBeenCalled();
    expect(issueSetter).not.toHaveBeenCalled();
  });

  it("clears stale lastSelected and falls back to clone", () => {
    const setter = vi.fn();
    const { result } = renderHook(() =>
      useRecipePicker({
        ...defaultArgs,
        lastSelectedWorktreeRecipeId: "deleted-recipe",
        setLastSelectedWorktreeRecipeIdByProject: setter,
      })
    );
    expect(setter).toHaveBeenCalledWith("test-project", undefined);
    expect(result.current.selectedRecipeId).toBe(CLONE_LAYOUT_ID);
  });

  it("keeps a still-valid remembered recipe when an unsaved pick disappears", () => {
    const setter = vi.fn();
    const args = {
      ...defaultArgs,
      startingLayoutRecipes: [makeRecipe("remembered"), makeRecipe("picked")],
      lastSelectedWorktreeRecipeId: "remembered",
      setLastSelectedWorktreeRecipeIdByProject: setter,
    };
    const { result, rerender } = renderHook((props) => useRecipePicker(props), {
      initialProps: args,
    });
    expect(result.current.selectedRecipeId).toBe("remembered");

    act(() => {
      result.current.recipeSelectionTouchedRef.current = true;
      result.current.setSelectedRecipeId("picked");
    });
    rerender({ ...args, startingLayoutRecipes: [makeRecipe("remembered")] });

    expect(result.current.selectedRecipeId).toBe(null);
    expect(setter).not.toHaveBeenCalled();
  });

  it("forgets the remembered recipe when it is the selection that disappears", () => {
    const setter = vi.fn();
    const args = {
      ...defaultArgs,
      startingLayoutRecipes: [makeRecipe("remembered"), makeRecipe("other")],
      lastSelectedWorktreeRecipeId: "remembered",
      setLastSelectedWorktreeRecipeIdByProject: setter,
    };
    const { result, rerender } = renderHook((props) => useRecipePicker(props), {
      initialProps: args,
    });
    expect(result.current.selectedRecipeId).toBe("remembered");

    // Touched, so the auto-select effect stands aside and only invalidation runs.
    result.current.recipeSelectionTouchedRef.current = true;
    rerender({ ...args, startingLayoutRecipes: [makeRecipe("other")] });

    expect(result.current.selectedRecipeId).toBe(null);
    expect(setter).toHaveBeenCalledWith("test-project", undefined);
  });
});
