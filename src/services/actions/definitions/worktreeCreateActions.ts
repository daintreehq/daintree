import type { ActionCallbacks, ActionRegistry } from "../actionTypes";
import { defineAction } from "../defineAction";
import { z } from "zod";
import { worktreeClient } from "@/clients";
import { useWorktreeSelectionStore } from "@/store/worktreeStore";

export function registerWorktreeCreateActions(
  actions: ActionRegistry,
  _callbacks: ActionCallbacks
): void {
  actions.set("worktree.quickCreate", () => ({
    id: "worktree.quickCreate",
    title: "Quick Create Worktree",
    description: "Open recipe picker for quick worktree creation",
    category: "worktree",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    keywords: ["new", "branch", "checkout", "recipe"],
    run: async () => {
      useWorktreeSelectionStore.getState().openQuickCreate();
    },
  }));

  actions.set("worktree.createDialog.open", () => ({
    id: "worktree.createDialog.open",
    title: "New Worktree",
    description: "Open dialog to create a new worktree",
    category: "worktree",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    keywords: ["create", "branch", "checkout", "add"],
    run: async () => {
      useWorktreeSelectionStore.getState().openCreateDialog();
    },
  }));

  actions.set("worktree.create", () =>
    defineAction({
      id: "worktree.create",
      title: "Create Worktree",
      description: "Create a new worktree",
      category: "worktree",
      kind: "command",
      danger: "safe",
      scope: "renderer",
      argsSchema: z.object({
        rootPath: z.string().describe("Root path of the git repository"),
        options: z
          .object({
            baseBranch: z.string().describe("Branch to base the worktree on"),
            newBranch: z.string().describe("Name for the new branch"),
            path: z.string().describe("Filesystem path for the new worktree"),
            fromRemote: z.boolean().optional().describe("Whether baseBranch is a remote branch"),
            useExistingBranch: z
              .boolean()
              .optional()
              .describe("Use an existing branch instead of creating a new one"),
            provisionResource: z
              .boolean()
              .optional()
              .describe("Run resource.provision after setup"),
            worktreeMode: z
              .string()
              .optional()
              .describe('Worktree environment mode ("local" or an environment key)'),
          })
          .describe("Worktree creation options"),
      }),
      resultSchema: z.string(),
      run: async ({ rootPath, options }) => {
        const worktreeId = await worktreeClient.create(options, rootPath);
        if (!worktreeId) {
          throw new Error("Failed to create worktree: no worktreeId returned from backend");
        }
        return worktreeId;
      },
    })
  );

  actions.set("worktree.delete", () =>
    defineAction({
      id: "worktree.delete",
      title: "Delete Worktree",
      description: "Delete a worktree",
      category: "worktree",
      kind: "command",
      danger: "confirm",
      scope: "renderer",
      argsSchema: z.object({
        worktreeId: z.string(),
        force: z.boolean().optional(),
        deleteBranch: z.boolean().optional(),
      }),
      run: async ({ worktreeId, force, deleteBranch }) => {
        await worktreeClient.delete(worktreeId, force, deleteBranch);
      },
    })
  );
}
