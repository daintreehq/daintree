/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";
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
  globalRecipes: [] as TerminalRecipe[],
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
      useRecipePicker({ ...defaultArgs, globalRecipes: recipes, defaultRecipeId: "recipe-1" })
    );
    expect(result.current.selectedRecipeId).toBe("recipe-1");
  });

  it("falls back to CLONE_LAYOUT_ID when defaultRecipeId is not in globalRecipes", () => {
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
        globalRecipes: recipes,
        defaultRecipeId: "recipe-1",
        initialRecipeId: "recipe-2",
      })
    );
    expect(result.current.selectedRecipeId).toBe("recipe-2");
  });

  it("does not invalidate CLONE_LAYOUT_ID as stale", () => {
    const setter = vi.fn();
    const { result, rerender } = renderHook(
      (props) => useRecipePicker(props),
      { initialProps: { ...defaultArgs, setLastSelectedWorktreeRecipeIdByProject: setter } }
    );
    expect(result.current.selectedRecipeId).toBe(CLONE_LAYOUT_ID);
    setter.mockClear();

    // Simulate recipes changing (triggers stale invalidation effect)
    rerender({ ...defaultArgs, setLastSelectedWorktreeRecipeIdByProject: setter, globalRecipes: [makeRecipe("new-recipe")] });
    expect(result.current.selectedRecipeId).toBe(CLONE_LAYOUT_ID);
    expect(setter).not.toHaveBeenCalled();
  });

  it("does not auto-select when dialog is closed", () => {
    const { result } = renderHook(() => useRecipePicker({ ...defaultArgs, isOpen: false }));
    // Default state is null (no auto-selection runs when closed)
    expect(result.current.selectedRecipeId).toBe(null);
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

  it("respects user touch and does not override", () => {
    const { result } = renderHook(() => useRecipePicker({ ...defaultArgs }));
    expect(result.current.selectedRecipeId).toBe(CLONE_LAYOUT_ID);

    act(() => {
      result.current.recipeSelectionTouchedRef.current = true;
      result.current.setSelectedRecipeId(null);
    });
    expect(result.current.selectedRecipeId).toBe(null);
  });

  it("selectedRecipe is undefined for sentinel IDs", () => {
    const recipes = [makeRecipe("recipe-1")];
    const { result } = renderHook(() =>
      useRecipePicker({ ...defaultArgs, globalRecipes: recipes })
    );
    expect(result.current.selectedRecipeId).toBe(CLONE_LAYOUT_ID);
    expect(result.current.selectedRecipe).toBeUndefined();
  });
});
