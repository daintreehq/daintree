import type { ActionRegistry } from "../actionTypes";
import { z } from "zod";
import type { ActionContext } from "@shared/types/actions";

// Both action IDs carry `danger: "confirm"` so they are excluded from
// `ActionService.repeatLast` and the action-palette MRU rail
// (CLAUDE.md Destructive Action Tiers, rule 2). Execution itself is
// modal-only — the bulk action bar in `WorktreeOverviewModal` wires the
// `ConfirmDialog` and the p-queue orchestrator inline, so these `run`
// bodies stay no-ops. Routing through `actionService.dispatch` would
// bypass the typed-name gate and the per-worktree warning preview that
// the modal renders, which is the whole point of the D3 classification.
export function registerWorktreeBulkActions(actions: ActionRegistry): void {
  actions.set("worktree.bulk.closeSessions", () => ({
    id: "worktree.bulk.closeSessions",
    title: "Close Sessions for Selected Worktrees",
    description: "End all sessions across the selected worktrees in the overview",
    category: "worktree",
    kind: "command",
    danger: "confirm",
    scope: "renderer",
    dangerRationale:
      "Permanently ends every session for each selected worktree. Scrollback is lost for each terminal.",
    argsSchema: z.object({}).optional(),
    run: async (_args: unknown, _ctx: ActionContext) => {
      // Selection-driven — must be invoked from the overview modal's bulk
      // action bar, which holds the live `selectedIds` Set. The action
      // surface exists for classification (danger:"confirm") and palette
      // visibility only.
    },
  }));

  actions.set("worktree.bulk.remove", () => ({
    id: "worktree.bulk.remove",
    title: "Remove Selected Worktrees",
    description: "Delete every selected worktree from disk with a typed-name confirmation",
    category: "worktree",
    kind: "command",
    danger: "confirm",
    scope: "renderer",
    dangerRationale:
      "Permanently removes every selected worktree directory. Untracked work is lost. Main worktrees are excluded inside the confirm step.",
    argsSchema: z.object({}).optional(),
    run: async (_args: unknown, _ctx: ActionContext) => {
      // Selection-driven — see `worktree.bulk.closeSessions` above. The
      // typed-name gate plus per-worktree dirty/unpushed preview lives in
      // the modal-owned `useWorktreeBulkRemove` hook.
    },
  }));
}
