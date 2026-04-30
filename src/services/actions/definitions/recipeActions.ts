import type { ActionCallbacks, ActionRegistry } from "../actionTypes";
import { defineAction } from "../defineAction";
import { z } from "zod";
import type { ActionContext } from "@shared/types/actions";
import { useRecipeStore } from "@/store/recipeStore";
import { getCurrentViewStore } from "@/store/createWorktreeStore";

export function registerRecipeActions(actions: ActionRegistry, _callbacks: ActionCallbacks): void {
  actions.set("recipe.list", () =>
    defineAction({
      id: "recipe.list",
      title: "List Recipes",
      description: "List all available recipes for the current project",
      category: "recipes",
      kind: "query",
      danger: "safe",
      scope: "renderer",
      argsSchema: z.object({ worktreeId: z.string().optional() }).optional(),
      run: async (args) => {
        const worktreeId = args?.worktreeId;
        const recipeState = useRecipeStore.getState();
        const recipes = recipeState.recipes;

        // Filter by worktree if specified, otherwise return all recipes
        const filtered = worktreeId
          ? recipes.filter((r) => r.worktreeId === worktreeId || r.worktreeId === undefined)
          : recipes;

        return {
          recipes: filtered.map((r) => ({
            id: r.id,
            name: r.name,
            worktreeId: r.worktreeId ?? null,
            terminalCount: r.terminals.length,
            showInEmptyState: r.showInEmptyState ?? false,
          })),
          isLoading: recipeState.isLoading,
        };
      },
    })
  );

  actions.set("recipe.run", () =>
    defineAction({
      id: "recipe.run",
      title: "Run Recipe",
      description: "Run a terminal recipe",
      category: "recipes",
      kind: "command",
      danger: "safe",
      scope: "renderer",
      argsSchema: z.object({ recipeId: z.string(), worktreeId: z.string().optional() }),
      run: async ({ recipeId, worktreeId }, ctx: ActionContext) => {
        const targetWorktreeId = worktreeId ?? ctx.activeWorktreeId ?? undefined;
        const worktree = targetWorktreeId
          ? getCurrentViewStore().getState().worktrees.get(targetWorktreeId)
          : null;
        const worktreePath = worktree?.path ?? ctx.projectPath;

        if (!worktreePath) {
          throw new Error("No worktree or project path available to run recipe");
        }

        await useRecipeStore.getState().runRecipe(recipeId, worktreePath, targetWorktreeId, {
          issueNumber: worktree?.issueNumber,
          prNumber: worktree?.prNumber,
          worktreePath,
          branchName: worktree?.branch,
        });
      },
    })
  );

  actions.set("recipe.editor.open", () =>
    defineAction({
      id: "recipe.editor.open",
      title: "Open Recipe Editor",
      description: "Open the recipe editor for a worktree",
      category: "recipes",
      kind: "command",
      danger: "safe",
      scope: "renderer",
      argsSchema: z.object({
        worktreeId: z.string().optional(),
        recipeId: z.string().optional(),
        initialTerminals: z.any().optional(),
      }),
      run: async ({ worktreeId, recipeId, initialTerminals }) => {
        window.dispatchEvent(
          new CustomEvent("daintree:open-recipe-editor", {
            detail: { worktreeId, recipeId, initialTerminals },
          })
        );
      },
    })
  );

  actions.set("recipe.manager.open", () => ({
    id: "recipe.manager.open",
    title: "Manage Recipes",
    description: "Open the recipe manager to view and manage global and project recipes",
    category: "recipes",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    run: async () => {
      window.dispatchEvent(new CustomEvent("daintree:open-recipe-manager"));
    },
  }));

  actions.set("recipe.saveToRepo", () =>
    defineAction({
      id: "recipe.saveToRepo",
      title: "Save Recipe to Repository",
      description:
        "Promote a recipe to in-repo storage (.daintree/recipes/) for git tracking and team sharing",
      category: "recipes",
      kind: "command",
      danger: "confirm",
      scope: "renderer",
      argsSchema: z.object({
        recipeId: z.string(),
        deleteOriginal: z.boolean().default(false),
      }),
      run: async ({ recipeId, deleteOriginal }) => {
        const store = useRecipeStore.getState();
        if (!store.currentProjectId) throw new Error("No project open");
        await store.saveToRepo(recipeId, deleteOriginal);
      },
    })
  );

  actions.set("recipe.editor.openFromLayout", () =>
    defineAction({
      id: "recipe.editor.openFromLayout",
      title: "Open Recipe Editor From Layout",
      description: "Open the recipe editor with terminals from the current layout",
      category: "recipes",
      kind: "command",
      danger: "safe",
      scope: "renderer",
      argsSchema: z.object({ worktreeId: z.string() }),
      run: async ({ worktreeId }) => {
        const terminals = useRecipeStore.getState().generateRecipeFromActiveTerminals(worktreeId);
        if (terminals.length === 0) {
          throw new Error("No active terminals in this worktree to save");
        }
        window.dispatchEvent(
          new CustomEvent("daintree:open-recipe-editor", {
            detail: { worktreeId, initialTerminals: terminals },
          })
        );
      },
    })
  );
}
