import type { ActionCallbacks, ActionRegistry } from "../actionTypes";
import { z } from "zod";
import type { ActionContext } from "@shared/types/actions";
import { useProjectStore } from "@/store/projectStore";
import { useRecipeStore } from "@/store/recipeStore";
import { useWorktreeDataStore } from "@/store/worktreeDataStore";

export function registerRecipeActions(actions: ActionRegistry, _callbacks: ActionCallbacks): void {
  actions.set("recipe.list", () => ({
    id: "recipe.list",
    title: "List Recipes",
    description: "List all available recipes for the current project",
    category: "recipes",
    kind: "query",
    danger: "safe",
    scope: "renderer",
    argsSchema: z.object({ worktreeId: z.string().optional() }).optional(),
    run: async (args: unknown) => {
      const { worktreeId } = (args ?? {}) as { worktreeId?: string };
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
  }));

  actions.set("recipe.run", () => ({
    id: "recipe.run",
    title: "Run Recipe",
    description: "Run a terminal recipe",
    category: "recipes",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    argsSchema: z.object({ recipeId: z.string(), worktreeId: z.string().optional() }),
    run: async (args: unknown, ctx: ActionContext) => {
      const { recipeId, worktreeId } = args as { recipeId: string; worktreeId?: string };
      const targetWorktreeId = worktreeId ?? ctx.activeWorktreeId ?? undefined;
      const worktree = targetWorktreeId
        ? useWorktreeDataStore.getState().worktrees.get(targetWorktreeId)
        : null;
      const worktreePath =
        worktree?.path ?? useProjectStore.getState().currentProject?.path ?? undefined;

      if (!worktreePath) {
        throw new Error("No worktree or project path available to run recipe");
      }

      await useRecipeStore.getState().runRecipe(recipeId, worktreePath, targetWorktreeId);
    },
  }));

  actions.set("recipe.editor.open", () => ({
    id: "recipe.editor.open",
    title: "Open Recipe Editor",
    description: "Open the recipe editor for a worktree",
    category: "recipes",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    argsSchema: z.object({
      worktreeId: z.string(),
      initialTerminals: z.any().optional(),
    }),
    run: async (args: unknown) => {
      const { worktreeId, initialTerminals } = args as {
        worktreeId: string;
        initialTerminals?: unknown;
      };
      window.dispatchEvent(
        new CustomEvent("canopy:open-recipe-editor", { detail: { worktreeId, initialTerminals } })
      );
    },
  }));

  actions.set("recipe.editor.openFromLayout", () => ({
    id: "recipe.editor.openFromLayout",
    title: "Open Recipe Editor From Layout",
    description: "Open the recipe editor with terminals from the current layout",
    category: "recipes",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    argsSchema: z.object({ worktreeId: z.string() }),
    run: async (args: unknown) => {
      const { worktreeId } = args as { worktreeId: string };
      const terminals = useRecipeStore.getState().generateRecipeFromActiveTerminals(worktreeId);
      if (terminals.length === 0) {
        throw new Error("No active terminals in this worktree to save");
      }
      window.dispatchEvent(
        new CustomEvent("canopy:open-recipe-editor", {
          detail: { worktreeId, initialTerminals: terminals },
        })
      );
    },
  }));
}
