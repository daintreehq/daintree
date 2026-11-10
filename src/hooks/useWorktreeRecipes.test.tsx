// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { useRecipeStore } from "@/store/recipeStore";
import type { TerminalRecipe } from "@/types";
import { useWorktreeRecipes } from "./useWorktreeRecipes";

const recipe = (id: string, name: string, worktreeId?: string): TerminalRecipe =>
  ({ id, name, worktreeId, terminals: [], createdAt: 0 }) as unknown as TerminalRecipe;

describe("useWorktreeRecipes", () => {
  const initial = useRecipeStore.getState().recipes;
  afterEach(() => useRecipeStore.setState({ recipes: initial }));

  it("follows recipe adds, renames and deletes on a mounted consumer", () => {
    useRecipeStore.setState({ recipes: [recipe("a", "A"), recipe("x", "Other", "wt-2")] });
    const { result } = renderHook(() => useWorktreeRecipes("wt-1"));
    expect(result.current.map((r) => r.id)).toEqual(["a"]);

    act(() => {
      useRecipeStore.setState({
        recipes: [recipe("a", "A"), recipe("b", "B", "wt-1"), recipe("x", "Other", "wt-2")],
      });
    });
    expect(result.current.map((r) => r.id)).toEqual(["a", "b"]);

    act(() => {
      useRecipeStore.setState({ recipes: [recipe("a", "Renamed"), recipe("b", "B", "wt-1")] });
    });
    expect(result.current[0]?.name).toBe("Renamed");

    act(() => {
      useRecipeStore.setState({ recipes: [recipe("b", "B", "wt-1")] });
    });
    expect(result.current.map((r) => r.id)).toEqual(["b"]);
  });
});
