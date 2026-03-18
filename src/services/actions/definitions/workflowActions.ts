import type { ActionRegistry } from "../actionTypes";
import { z } from "zod";
import { worktreeClient, githubClient } from "@/clients";
import { useProjectStore } from "@/store/projectStore";
import { useRecipeStore } from "@/store/recipeStore";
import { useWorktreeDataStore } from "@/store/worktreeDataStore";
import { useGitHubConfigStore } from "@/store/githubConfigStore";

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
      useExistingBranch: z
        .boolean()
        .optional()
        .describe("Use an existing branch instead of creating a new one"),
      issueNumber: z.number().optional().describe("GitHub issue number to link with the worktree"),
      assignToSelf: z
        .boolean()
        .optional()
        .describe("Explicitly assign the linked issue to the current user (default: false)"),
    }),
    resultSchema: z.object({
      worktreeId: z.string(),
      worktreePath: z.string(),
      branch: z.string(),
      recipeLaunched: z.boolean(),
      assignedToSelf: z.boolean(),
    }),
    run: async (args: unknown) => {
      const {
        branchName,
        baseBranch,
        recipeId,
        fromRemote,
        useExistingBranch,
        issueNumber,
        assignToSelf,
      } = args as {
        branchName: string;
        baseBranch?: string;
        recipeId?: string;
        fromRemote?: boolean;
        useExistingBranch?: boolean;
        issueNumber?: number;
        assignToSelf?: boolean;
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
          useExistingBranch: useExistingBranch ?? false,
        },
        rootPath
      );

      if (!worktreeId) {
        throw new Error("Failed to create worktree: no worktreeId returned from backend");
      }

      // Run recipe if specified (already validated above)
      let recipeLaunched = false;
      if (recipeId) {
        await useRecipeStore.getState().runRecipe(recipeId, path, worktreeId, {
          worktreePath: path,
          branchName: availableBranch,
          issueNumber,
        });
        recipeLaunched = true;
      }

      // Auto-assign GitHub issue if explicitly requested
      let assignedToSelf = false;
      if (issueNumber && assignToSelf) {
        const username = useGitHubConfigStore.getState().config?.username;
        if (username) {
          try {
            await githubClient.assignIssue(rootPath, issueNumber, username);
            assignedToSelf = true;
          } catch {
            // Silent failure — assignment is best-effort
          }
        }
      }

      return {
        worktreeId,
        worktreePath: path,
        branch: availableBranch,
        recipeLaunched,
        assignedToSelf,
      };
    },
  }));
}
