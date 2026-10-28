import type { ActionCallbacks, ActionRegistry } from "../actionTypes";
import { defineAction } from "../defineAction";
import { z } from "zod";
import type { ActionContext } from "@shared/types/actions";
import { WorktreeSetupStateSchema } from "./schemas";
import {
  CreateWithRecipeArgsSchema,
  StartWorkOnIssueArgsSchema,
} from "./workflowCreationActionArgs";
import type { WorkflowCreationActionRunId } from "./workflowCreationActions.impl";

/**
 * Run bodies load on first dispatch (#14275), as the git actions do (#14239).
 * Every view registers these at boot for menus and the MCP manifest, but an
 * empty view runs none of them. A failed chunk load rejects inside `run`, which
 * ActionService turns into an error result like any other failure.
 */
async function runWorkflowCreationAction(
  id: WorkflowCreationActionRunId,
  args: unknown,
  ctx: ActionContext,
  callbacks: Pick<ActionCallbacks, "onLaunchAgent">
): Promise<unknown> {
  const { workflowCreationActionRuns } = await import("./workflowCreationActions.impl");
  return workflowCreationActionRuns[id](args, ctx, callbacks);
}

export function registerWorkflowCreationActions(
  actions: ActionRegistry,
  callbacks: Pick<ActionCallbacks, "onLaunchAgent">
): void {
  actions.set("worktree.createWithRecipe", () =>
    defineAction({
      id: "worktree.createWithRecipe",
      title: "Create managed worktree",
      description:
        "Create a managed git worktree; Daintree's creator also copies project config, initializes submodules and runs setup. Pick one mode: new branch, existing branch as named, or pull request. A recipe is optional, only to launch terminals. Setup runs in the background and can fail after this returns.",
      category: "worktree",
      kind: "command",
      danger: "safe",
      scope: "renderer",
      // Headless/MCP tool: `source` names the creation mode and carries the
      // fields that mode actually needs, so the manifest schema can no longer
      // advertise `{}` as a valid call. Palette picks still redirect to the New
      // Worktree dialog, which collects branch/recipe/PR interactively.
      palette: { mode: "redirect", to: "worktree.createDialog.open" },
      argsSchema: CreateWithRecipeArgsSchema,
      resultSchema: z.object({
        worktreeId: z.string(),
        worktreePath: z.string(),
        /**
         * Kept for compatibility with callers written against the original
         * result shape. Always equal to `effectiveBranch` — read that one.
         */
        branch: z.string(),
        requestedBranch: z
          .string()
          .describe("The branch name this call asked for, before collision handling."),
        effectiveBranch: z
          .string()
          .describe(
            "The branch the worktree is actually on. Differs from requestedBranch only when a newBranch source hit a collision under collisionPolicy 'suffix'."
          ),
        recipeLaunched: z.boolean(),
        spawnedTerminalCount: z.number().int().nonnegative(),
        // The composite's child panels, by id. Without these the terminals this
        // call created are indistinguishable from every other panel in the
        // view, so neither the caller nor the MCP ownership ledger can act on
        // them (#11909).
        spawnedTerminalIds: z
          .array(z.string())
          .describe(
            "The recipe panels this call actually started, in spawn order. Use these ids to read output from or close the terminals it created."
          ),
        failedTerminalCount: z.number().int().nonnegative(),
        setupState: WorktreeSetupStateSchema.describe(
          "Setup state as of the moment git creation finished, which is BEFORE any recipe terminals or issue assignment this call also did — so it is a snapshot, not the state on return, and setup may since have advanced or failed. Re-read it from the worktree listing, or wait on it where a readiness wait is available, before running work that needs a fully initialized tree."
        ),
        assignedToSelf: z.boolean(),
        assignedUsername: z.string().nullable(),
        assignmentError: z.string().nullable(),
      }),
      run: (args, ctx: ActionContext) =>
        runWorkflowCreationAction("worktree.createWithRecipe", args, ctx, callbacks),
    })
  );

  actions.set("workflow.startWorkOnIssue", () =>
    defineAction({
      id: "workflow.startWorkOnIssue",
      title: "Start work on issue",
      description:
        "Start work on an issue in one call: fetch it, create a worktree on a derived branch, launch an agent in a terminal and inject context. An unknown or non-terminal agent id is rejected before the issue lookup, so no worktree is created.",
      category: "worktree",
      kind: "command",
      danger: "safe",
      scope: "renderer",
      argsSchema: StartWorkOnIssueArgsSchema,
      resultSchema: z.object({
        issueNumber: z.number(),
        issueTitle: z.string(),
        issueUrl: z.string(),
        worktreeId: z.string(),
        worktreePath: z.string(),
        branch: z.string(),
        terminalId: z.string().nullable(),
        recipeLaunched: z.boolean(),
        spawnedTerminalCount: z.number().int().nonnegative(),
        failedTerminalCount: z.number().int().nonnegative(),
        assignedToSelf: z.boolean(),
        assignedUsername: z.string().nullable(),
        assignmentError: z.string().nullable(),
        contextInjected: z.boolean(),
      }),
      // Already a top-level object, so the manifest schema passes tierAuth's
      // `type === "object"` gate and the result reaches callers as
      // structuredContent instead of a text blob only (#11547).
      mcpOutputSchema: true,
      run: (args, ctx: ActionContext) =>
        runWorkflowCreationAction("workflow.startWorkOnIssue", args, ctx, callbacks),
    })
  );
}
