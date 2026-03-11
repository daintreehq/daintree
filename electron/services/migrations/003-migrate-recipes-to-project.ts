import type { Migration } from "../StoreMigrations.js";
import { projectStore } from "../ProjectStore.js";
import type { TerminalRecipe, RecipeTerminal } from "../../types/index.js";

export const migration003: Migration = {
  version: 3,
  description: "Migrate global recipes to project-scoped storage",
  up: async (store) => {
    const appState = store.get("appState");
    if (!appState?.recipes || !Array.isArray(appState.recipes) || appState.recipes.length === 0) {
      console.log("[Migration 003] No global recipes to migrate");
      return;
    }

    const currentProjectId = projectStore.getCurrentProjectId();

    if (!currentProjectId) {
      console.log(
        "[Migration 003] No current project set, preserving legacy recipes for later migration"
      );
      // Keep recipes in global store for now - they'll be migrated when a project is selected
      return;
    }

    // Verify the project exists in the project list
    const projectExists = projectStore.getProjectById(currentProjectId) !== null;
    if (!projectExists) {
      console.warn(
        `[Migration 003] Current project ID ${currentProjectId} not found in project list, skipping migration`
      );
      return;
    }

    console.log(
      `[Migration 003] Migrating ${appState.recipes.length} recipe(s) to project ${currentProjectId}`
    );

    try {
      // Load existing project recipes to merge (avoid overwriting)
      const existingRecipes = await projectStore.getRecipes(currentProjectId);
      const existingIds = new Set(existingRecipes.map((r) => r.id));

      console.log(`[Migration 003] Found ${existingRecipes.length} existing recipe(s) in project`);

      // Convert legacy recipes to new format with projectId, filtering out duplicates
      const migratedRecipes: TerminalRecipe[] = appState.recipes
        .filter((legacyRecipe) => {
          if (existingIds.has(legacyRecipe.id)) {
            console.log(`[Migration 003] Skipping duplicate recipe: ${legacyRecipe.id}`);
            return false;
          }
          return true;
        })
        .map((legacyRecipe) => {
          const terminals: RecipeTerminal[] = (legacyRecipe.terminals || []).map(
            (t: {
              type: string;
              title?: string;
              command?: string;
              env?: Record<string, string>;
              initialPrompt?: string;
              devCommand?: string;
            }) => ({
              type: t.type as RecipeTerminal["type"],
              title: t.title,
              command: t.command,
              env: t.env,
              initialPrompt: t.initialPrompt,
              devCommand: t.devCommand,
            })
          );

          return {
            id: legacyRecipe.id,
            name: legacyRecipe.name,
            projectId: currentProjectId,
            worktreeId: legacyRecipe.worktreeId,
            terminals,
            createdAt: legacyRecipe.createdAt || Date.now(),
            showInEmptyState: legacyRecipe.showInEmptyState,
            lastUsedAt: legacyRecipe.lastUsedAt,
          };
        });

      if (migratedRecipes.length === 0) {
        console.log("[Migration 003] No new recipes to migrate (all already exist)");
      } else {
        // Merge with existing recipes
        const mergedRecipes = [...existingRecipes, ...migratedRecipes];

        // Save merged recipes to project-scoped storage
        await projectStore.saveRecipes(currentProjectId, mergedRecipes);

        console.log(
          `[Migration 003] Successfully migrated ${migratedRecipes.length} new recipe(s), total now ${mergedRecipes.length}`
        );
      }

      // Clear global recipes only after successful migration
      store.set("appState", { ...appState, recipes: [] });
    } catch (error) {
      console.error("[Migration 003] Failed to migrate recipes:", error);
      // Don't throw and don't clear global recipes - let the app continue
      // The global recipes will remain and can be manually migrated later
    }
  },
};
