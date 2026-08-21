import type { ActionCallbacks, ActionRegistry } from "../actionTypes";
import { defineAction } from "../defineAction";
import { z } from "zod";
import { worktreeClient } from "@/clients";
import { withWorktreeLocation, requireWorktreePath } from "./locationArgs";
import { useWorktreeSelectionStore } from "@/store/worktreeStore";
import {
  captureWorktreeTerminalSnapshot,
  closeTerminalsForWorktree,
  restoreClosedTerminals,
  type WorktreeTerminalRestoreSnapshot,
} from "@/components/Worktree/worktreeDeleteHelper";

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
      description:
        "Create a git worktree with its branch, without launching terminals. Prefer the recipe-backed path when it should also track a pull request or start a recipe's terminals. It writes to disk, may branch from a remote base or reuse a branch, and can provision a configured resource. Creation anchors on the repository root, not the active worktree; setup can still fail after the worktree exists.",
      category: "worktree",
      kind: "command",
      danger: "safe",
      scope: "renderer",
      argsSchema: withWorktreeLocation(
        {
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
        },
        { legacy: ["rootPath"], requireSelector: true }
      ),
      resultSchema: z.string(),
      run: async ({ options, ...location }, ctx) => {
        const worktreeId = await worktreeClient.create(options, requireWorktreePath(location, ctx));
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
      description:
        "Delete a linked worktree and remove its directory from disk. By default it refuses when the worktree has uncommitted or untracked changes; forcing it past that destroys them irreversibly. The main worktree cannot be deleted. Confirm the target and make sure anything worth keeping is committed or pushed first.",
      category: "worktree",
      kind: "command",
      danger: "confirm",
      scope: "renderer",
      dangerRationale:
        "Deletes the working tree and optionally the branch from disk. Recovery requires re-creating the worktree.",
      argsSchema: z.object({
        worktreeId: z.string(),
        force: z.boolean().optional(),
        deleteBranch: z.boolean().optional(),
        closeTerminals: z.boolean().optional(),
      }),
      run: async ({ worktreeId, force, deleteBranch, closeTerminals }) => {
        // Capture BEFORE closing so a close-wait timeout (or a stop-dev-preview
        // failure) still leaves a snapshot to restore from (#11344).
        const restoreSnapshot: WorktreeTerminalRestoreSnapshot[] = closeTerminals
          ? captureWorktreeTerminalSnapshot(worktreeId)
          : [];
        try {
          if (closeTerminals) {
            await closeTerminalsForWorktree(worktreeId);
          }
          // Stop any running dev preview BEFORE `git worktree remove` (#9084).
          // Windows holds a directory lock while the dev server runs; removal
          // fails outright if the server is still alive. `stopByWorktree` is
          // a safe no-op when no session matches, so it's called
          // unconditionally rather than gated on `getByWorktree` — that gate
          // would miss multi-panel sessions sharing the same worktreeId.
          await window.electron.devPreview.stopByWorktree({ worktreeId });
          await worktreeClient.delete(worktreeId, force, deleteBranch);
        } catch (error) {
          // This action path has no outbox retry, so a throw here ends the
          // delete. Bring the closed terminals back rather than losing them to a
          // delete that didn't happen — but only if the worktree still exists: a
          // branch-delete failure lands after `git worktree remove` succeeded, so
          // relaunching then would strand terminals on a deleted worktree.
          const stillExists = await worktreeClient
            .getAll()
            .then((worktrees) => worktrees.some((worktree) => worktree.id === worktreeId))
            .catch(() => true);
          if (stillExists) void restoreClosedTerminals(restoreSnapshot);
          throw error;
        }
      },
    })
  );

  // Manifest-only, executed in the MCP main process (see the note on
  // `terminal.closeOwned`): the ownership ledger is keyed by MCP session id,
  // which the renderer has no access to. Main verifies ownership, then
  // dispatches `worktree.delete` itself — so the D2 confirmation the user sees
  // is the real one, with the real file-count preview
  // (`resolveMcpConfirmPreviewTarget` keys off that action id), rather than a
  // second approval path a headless caller could talk its way through (#11909).
  //
  // `danger: "confirm"` is load-bearing beyond the dialog: `isWithheldFromBoundSession`
  // derives its refusal from this field alone, so a workspace-bound external
  // session — one routed at a background view where no human is watching for a
  // dialog — is refused this tool at discovery AND at dispatch, with no
  // hand-written id list to keep in sync (#11789).
  //
  // `force`, `deleteBranch` and `closeTerminals` are deliberately absent from
  // the schema rather than defaulted. Owning the worktree is not authority to
  // destroy uncommitted work, to delete a branch the session never created, or
  // to close every terminal in the worktree — `closeTerminals` is a blunt
  // boolean over all of them, so it cannot be narrowed to the owned ones. A
  // caller cleaning up after itself closes its own panels through
  // `terminal.closeOwned` first, then deletes a clean worktree.
  actions.set("worktree.deleteOwned", () =>
    defineAction({
      id: "worktree.deleteOwned",
      title: "Delete Owned Worktree",
      description:
        "Delete a worktree this session itself created, removing its directory from disk after the user confirms. Only worktrees created by this connection can be deleted; anything else is refused. It will not force past uncommitted or untracked changes, delete the branch, or close terminals it does not own — commit or close those first.",
      category: "worktree",
      kind: "command",
      danger: "confirm",
      scope: "renderer",
      dangerRationale:
        "Deletes the working tree from disk. Recovery requires re-creating the worktree, so the session's own ownership record is a precondition rather than the approval.",
      // Hidden from the palette for the same reason as `terminal.closeOwned`:
      // there is no ownership record for a user dispatch to check, so the only
      // outcome here would be the `run()` throw. The palette's worktree delete
      // is `worktree.delete`, via `WorktreeDeleteDialog`.
      palette: { mode: "hidden" },
      argsSchema: z.object({
        worktreeId: z
          .string()
          .min(1)
          .describe(
            "The worktree to delete, as the `worktreeId` this session received when it created the worktree."
          ),
      }),
      run: async () => {
        throw new Error(
          "worktree.deleteOwned must be invoked through the MCP main-process path, not renderer dispatch."
        );
      },
    })
  );
}
