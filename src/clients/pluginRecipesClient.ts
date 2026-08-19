import type { PluginRecipeMetadataPatch, TerminalRecipe } from "@shared/types";

/**
 * Renderer surface for the plugin-contributed recipe tier (#11860).
 *
 * Content is read-only: a plugin's recipes are replaced wholesale on every
 * load, so there is no update/delete here. The two writes are the user-owned
 * half — a run's frecency and the empty-state / auto-assign preferences — which
 * main persists to its sidecar rather than to `GlobalFileStore`.
 *
 * `recordUse` sends only the timestamp, never the whole history array: two
 * windows running the same recipe at once would otherwise each post their own
 * stale copy and one would win.
 */
export const pluginRecipesClient = {
  getRecipes: (): Promise<TerminalRecipe[]> => window.electron.plugin.getRecipes(),

  recordUse: (recipeId: string, timestamp: number): Promise<TerminalRecipe> =>
    window.electron.plugin.recordRecipeUse(recipeId, timestamp),

  updateMetadata: (recipeId: string, updates: PluginRecipeMetadataPatch): Promise<TerminalRecipe> =>
    window.electron.plugin.updateRecipeMetadata(recipeId, updates),
} as const;
