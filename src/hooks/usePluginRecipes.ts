import { useEffect } from "react";
import { pluginRecipesClient } from "@/clients";
import { useRecipeStore } from "@/store/recipeStore";
import { logWarn } from "@/utils/logger";

/**
 * Mirror the main process's plugin-contributed recipe registry into the
 * renderer's recipe store as a fourth tier (#11860).
 *
 * Owned here rather than by `recipeStore.loadRecipes` on purpose: plugin
 * recipes are global, so folding them into the per-project load would re-fetch
 * them on every project switch and race the broadcast for no benefit. Keeping
 * them on their own channel also means a project-switch clear can't drop them.
 *
 * Pull-on-mount is a safety net for cached `WebContentsView`s that may have
 * missed a broadcast; push-on-change is authoritative — once a push arrives, a
 * later-resolving mount-time pull is dropped so it can't roll state back
 * (mirrors {@link usePluginAgents}). Every broadcast carries the full effective
 * snapshot, metadata already overlaid, so the renderer replaces wholesale.
 */
export function usePluginRecipes(): void {
  useEffect(() => {
    let disposed = false;
    let pushReceived = false;

    const electron = typeof window !== "undefined" ? window.electron : undefined;
    if (!electron?.plugin) return;

    void pluginRecipesClient
      .getRecipes()
      .then((recipes) => {
        if (disposed || pushReceived) return;
        useRecipeStore.getState().setPluginRecipes(recipes);
      })
      .catch((err: unknown) => {
        logWarn("[PluginRecipes] Failed to fetch initial plugin recipes", { error: err });
      });

    const cleanup = electron.plugin.onRecipesChanged((payload) => {
      if (disposed) return;
      pushReceived = true;
      useRecipeStore.getState().setPluginRecipes(payload.recipes);
    });

    return () => {
      disposed = true;
      cleanup();
      useRecipeStore.getState().setPluginRecipes([]);
    };
  }, []);
}
