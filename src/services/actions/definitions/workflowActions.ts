import type { ActionRegistry } from "../actionTypes";
import { z } from "zod";
import { worktreeClient } from "@/clients";
import { useProjectStore } from "@/store/projectStore";
import { useRecipeStore } from "@/store/recipeStore";
import { useWorktreeSelectionStore } from "@/store/worktreeStore";
import { useWorktreeDataStore } from "@/store/worktreeDataStore";

export function registerWorkflowActions(actions: ActionRegistry): void {
  actions.set("worktree.createWithRecipe", () => ({
    id: "worktree.createWithRecipe",
    title: "Create Worktree with Recipe",
    description:
      "Create a new worktree and optionally run a recipe. Handles branch name collision, path generation, worktree activation, and recipe execution in one atomic operation.",
    category: "worktree",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    argsSchema: z.object({
      branchName: z
        .string()
        .trim()
        .min(1)
        .describe("Name for the new branch (will be sanitized for git compatibility)"),
      baseBranch: z
        .string()
        .trim()
        .min(1)
        .optional()
        .describe("Branch to base the worktree on (defaults to main worktree's branch)"),
      recipeId: z.string().optional().describe("Recipe ID to run after creation"),
      fromRemote: z.boolean().optional().describe("Set true if baseBranch is a remote branch"),
    }),
    resultSchema: z.object({
      worktreeId: z.string(),
      worktreePath: z.string(),
      branch: z.string(),
      recipeLaunched: z.boolean(),
    }),
    run: async (args: unknown) => {
      const { branchName, baseBranch, recipeId, fromRemote } = args as {
        branchName: string;
        baseBranch?: string;
        recipeId?: string;
        fromRemote?: boolean;
      };

      const currentProject = useProjectStore.getState().currentProject;
      if (!currentProject) {
        throw new Error("No active project");
      }

      const rootPath = currentProject.path;

      // Determine base branch - default to main worktree's branch if not specified
      let baseRef = baseBranch;
      if (!baseRef) {
        const mainWorktree = Array.from(useWorktreeDataStore.getState().worktrees.values()).find(
          (w) => w.isMainWorktree
        );
        if (!mainWorktree) {
          throw new Error(
            "No base branch specified and no main worktree found. Please specify baseBranch parameter."
          );
        }
        baseRef = mainWorktree.branch;
      }

      // Validate recipe exists before creating worktree (if specified)
      if (recipeId) {
        const recipe = useRecipeStore.getState().getRecipeById(recipeId);
        if (!recipe) {
          throw new Error(
            `Recipe ${recipeId} not found. Use recipe_list to see available recipes.`
          );
        }
      }

      // Get collision-safe branch name
      const availableBranch = await worktreeClient.getAvailableBranch(rootPath, branchName);

      // Get default path for the worktree
      const path = await worktreeClient.getDefaultPath(rootPath, availableBranch);

      // Create worktree (baseRef is guaranteed to be string here due to validation above)
      if (!baseRef) {
        throw new Error("Base branch is required but was not determined");
      }

      const worktreeId = await worktreeClient.create(
        {
          baseBranch: baseRef,
          newBranch: availableBranch,
          path,
          fromRemote: fromRemote ?? false,
        },
        rootPath
      );

      if (!worktreeId) {
        throw new Error("Failed to create worktree: no worktreeId returned from backend");
      }

      // Set as active worktree
      useWorktreeSelectionStore.getState().selectWorktree(worktreeId);

      // Run recipe if specified (already validated above)
      let recipeLaunched = false;
      if (recipeId) {
        await useRecipeStore.getState().runRecipe(recipeId, path, worktreeId);
        recipeLaunched = true;
      }

      return {
        worktreeId,
        worktreePath: path,
        branch: availableBranch,
        recipeLaunched,
      };
    },
  }));
}
