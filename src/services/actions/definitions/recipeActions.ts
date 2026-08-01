import type { ActionCallbacks, ActionRegistry } from "../actionTypes";
import { defineAction } from "../defineAction";
import { z } from "zod";
import type { ActionContext } from "@shared/types/actions";
import { useRecipeStore } from "@/store/recipeStore";
import { getCurrentViewStore } from "@/store/createWorktreeStore";
import { notifyRecipeSpawnFailures } from "@/utils/recipeNotify";
import {
  TerminalSpawnSourceSchema,
  RecipeSummarySchema,
  AddPanelFocusPolicySchema,
} from "./schemas";

export function registerRecipeActions(actions: ActionRegistry, _callbacks: ActionCallbacks): void {
  actions.set("recipe.list", () =>
    defineAction({
      id: "recipe.list",
      title: "List Recipes",
      description:
        "List the saved recipes for the current project — named multi-terminal setups the user has configured. Use this to discover recipe ids before running one. It never fails; an empty list means the project has no recipes rather than that recipes are unavailable.",
      category: "recipes",
      kind: "query",
      danger: "safe",
      scope: "renderer",
      argsSchema: z.object({ worktreeId: z.string().optional() }).optional(),
      resultSchema: z.object({
        recipes: z.array(RecipeSummarySchema),
        isLoading: z.boolean(),
      }),
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
      description:
        "Launch every terminal a saved recipe defines, in one worktree, as a repeatable multi-pane setup. Launch a single agent or a plain terminal instead when only one pane is wanted. This creates several panels at once and starts their configured commands or agents, so it can consume substantial resources and may partly succeed — check what actually started rather than assuming all of it did.",
      category: "recipes",
      kind: "command",
      danger: "confirm",
      scope: "renderer",
      dangerRationale:
        "Spawns the recipe's terminals, each running shell commands or launching agents. " +
        "Agent-initiated runs are confirmation-gated so a single dispatch can't open many terminals unprompted.",
      argsSchema: z.object({
        recipeId: z.string(),
        worktreeId: z.string().optional(),
        spawnedBy: TerminalSpawnSourceSchema.optional(),
        focusPolicy: AddPanelFocusPolicySchema.optional(),
      }),
      resultSchema: z.object({
        spawnedCount: z.number().int().nonnegative(),
        failedCount: z.number().int().nonnegative(),
        failedTerminals: z.array(
          z.object({ index: z.number().int().nonnegative(), reason: z.string() })
        ),
      }),
      mcpOutputSchema: true,
      run: async ({ recipeId, worktreeId, spawnedBy, focusPolicy }, ctx: ActionContext) => {
        const targetWorktreeId = worktreeId ?? ctx.activeWorktreeId ?? undefined;
        const worktree = targetWorktreeId
          ? getCurrentViewStore().getState().worktrees.get(targetWorktreeId)
          : null;
        const worktreePath = worktree?.path ?? ctx.projectPath;

        if (!worktreePath) {
          throw new Error("No worktree or project path available to run recipe");
        }

        const recipeContext = {
          issueNumber: worktree?.issueNumber,
          prNumber: worktree?.linked?.pr?.ref.number,
          worktreePath,
          branchName: worktree?.branch,
        };
        // Always forward dispatchSource so runRecipeWithResults can apply the
        // agent-source terminal cap. ActionService sets ctx.dispatchSource on
        // every dispatch, so this is the live path for all real invocations.
        const recipeName = useRecipeStore.getState().getRecipeById(recipeId)?.name;
        const results = await useRecipeStore
          .getState()
          .runRecipeWithResults(recipeId, worktreePath, targetWorktreeId, recipeContext, {
            spawnedBy,
            focusPolicy,
            dispatchSource: ctx.dispatchSource,
          });

        // Toast/inbox first so palette users see the failure even though the
        // dispatch below also rejects (the rejection only reaches MCP callers).
        notifyRecipeSpawnFailures(results, {
          recipeName,
          projectId: ctx.projectId,
        });

        if (results.spawned.length === 0 && results.failed.length > 0) {
          const reasons = Array.from(new Set(results.failed.map((f) => f.error))).join("; ");
          throw new Error(`Recipe launch failed: ${reasons}`);
        }

        return {
          spawnedCount: results.spawned.length,
          failedCount: results.failed.length,
          failedTerminals: results.failed.map((f) => ({ index: f.index, reason: f.error })),
        };
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
      danger: "safe",
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

  actions.set("recipe.delete", () =>
    defineAction({
      id: "recipe.delete",
      title: "Delete Recipe",
      description: "Delete a recipe permanently",
      category: "recipes",
      kind: "command",
      danger: "confirm",
      scope: "renderer",
      dangerRationale:
        "Permanently deletes a recipe. The recipe configuration cannot be recovered.",
      argsSchema: z.object({ recipeId: z.string() }),
      run: async ({ recipeId }) => {
        await useRecipeStore.getState().deleteRecipe(recipeId);
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
