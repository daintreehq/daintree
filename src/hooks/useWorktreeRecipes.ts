import { useMemo } from "react";
import { useRecipeStore } from "@/store/recipeStore";

// Subscribes to the recipe list itself: selecting the store's getRecipesForWorktree
// getter instead leaves the caller blind to recipe changes (stable reference, and the
// React Compiler caches the call).
export function useWorktreeRecipes(worktreeId: string) {
  const recipes = useRecipeStore((state) => state.recipes);
  return useMemo(
    () => recipes.filter((r) => r.worktreeId === worktreeId || r.worktreeId === undefined),
    [recipes, worktreeId]
  );
}
