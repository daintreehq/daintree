import type { TerminalRecipe } from "@shared/types";

export const globalRecipesClient = {
  getRecipes: (): Promise<TerminalRecipe[]> => window.electron.globalRecipes.getRecipes(),

  addRecipe: (recipe: TerminalRecipe): Promise<void> =>
    window.electron.globalRecipes.addRecipe(recipe),

  updateRecipe: (
    recipeId: string,
    updates: Partial<Omit<TerminalRecipe, "id" | "projectId" | "createdAt">>
  ): Promise<void> => window.electron.globalRecipes.updateRecipe(recipeId, updates),

  deleteRecipe: (recipeId: string): Promise<void> =>
    window.electron.globalRecipes.deleteRecipe(recipeId),
} as const;
