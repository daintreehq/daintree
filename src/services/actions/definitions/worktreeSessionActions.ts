import type { ActionCallbacks, ActionRegistry } from "../actionTypes";
import { z } from "zod";
import type { ActionContext } from "@shared/types/actions";
import { terminalInstanceService } from "@/services/terminal/TerminalInstanceService";
import { usePanelStore } from "@/store/panelStore";
import { useTerminalPendingDestructiveActionStore } from "@/store/terminalPendingDestructiveActionStore";
import { collectRunningAgentTerminals } from "@/utils/destructiveSessionConfirm";

// Shared by argsSchema + run() so the worktree id is extracted via a validated
// parse rather than an unchecked `as` cast (keeps the lint ratchet green).
const clearHistoryArgsSchema = z.object({
  worktreeId: z.string().optional(),
  confirmed: z.boolean().optional(),
});

export function registerWorktreeSessionActions(
  actions: ActionRegistry,
  _callbacks: ActionCallbacks
): void {
  actions.set("worktree.sessions.minimizeAll", () => ({
    id: "worktree.sessions.minimizeAll",
    title: "Dock All Sessions",
    description: "Move all grid sessions for a worktree to the dock",
    category: "worktree",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    keywords: ["collapse", "hide", "zen", "dock"],
    argsSchema: z.object({ worktreeId: z.string().optional() }),
    run: async (args: unknown, ctx: ActionContext) => {
      const { worktreeId } = args as { worktreeId?: string };
      const targetWorktreeId = worktreeId ?? ctx.activeWorktreeId;
      if (!targetWorktreeId) return;
      usePanelStore.getState().bulkMoveToDockByWorktree(targetWorktreeId);
    },
  }));

  actions.set("worktree.sessions.maximizeAll", () => ({
    id: "worktree.sessions.maximizeAll",
    title: "Maximize All Sessions",
    description: "Move all dock sessions for a worktree into the grid",
    category: "worktree",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    argsSchema: z.object({ worktreeId: z.string().optional() }),
    run: async (args: unknown, ctx: ActionContext) => {
      const { worktreeId } = args as { worktreeId?: string };
      const targetWorktreeId = worktreeId ?? ctx.activeWorktreeId;
      if (!targetWorktreeId) return;
      usePanelStore.getState().bulkMoveToGridByWorktree(targetWorktreeId);
    },
  }));

  actions.set("worktree.sessions.restartAll", () => ({
    id: "worktree.sessions.restartAll",
    title: "Restart All Sessions",
    description: "Restart all sessions for a worktree",
    category: "worktree",
    kind: "command",
    danger: "confirm",
    scope: "renderer",
    dangerRationale:
      "Restarts all sessions for a worktree. Scrollback is lost for every restarted terminal.",
    argsSchema: z
      .object({
        worktreeId: z.string().optional(),
        confirmed: z.boolean().optional(),
      })
      .optional(),
    run: async (args: unknown, ctx: ActionContext) => {
      const { worktreeId, confirmed } =
        (args as { worktreeId?: string; confirmed?: boolean } | undefined) ?? {};
      const targetWorktreeId = worktreeId ?? ctx.activeWorktreeId;
      if (!targetWorktreeId) return;
      const state = usePanelStore.getState();
      const targets = state.panelIds
        .map((id) => state.panelsById[id])
        .filter(
          (t): t is NonNullable<typeof t> =>
            t != null &&
            t.worktreeId === targetWorktreeId &&
            t.location !== "trash" &&
            t.location !== "overlay" &&
            // Dialog panels are ephemeral modal content, not worktree sessions —
            // including one inflates the confirmation count while the bulk
            // action that follows correctly skips it.
            t.location !== "dialog"
        );
      if (targets.length === 0) return;
      const runningAgents = collectRunningAgentTerminals(targets);
      if (confirmed !== true && runningAgents.length > 0) {
        useTerminalPendingDestructiveActionStore.getState().request({
          kind: "worktreeRestartAll",
          targetCount: targets.length,
          runningAgentCount: runningAgents.length,
          worktreeId: targetWorktreeId,
        });
        return;
      }
      const pending = useTerminalPendingDestructiveActionStore.getState().pending;
      if (pending && pending.kind === "worktreeRestartAll") {
        useTerminalPendingDestructiveActionStore.getState().clear();
      }
      await state.bulkRestartByWorktree(targetWorktreeId);
    },
  }));

  actions.set("worktree.sessions.resetRenderers", () => ({
    id: "worktree.sessions.resetRenderers",
    title: "Reset Session Renderers",
    description: "Reset all xterm renderers for a worktree",
    category: "worktree",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    argsSchema: z.object({ worktreeId: z.string().optional() }),
    run: async (args: unknown, ctx: ActionContext) => {
      const { worktreeId } = args as { worktreeId?: string };
      const targetWorktreeId = worktreeId ?? ctx.activeWorktreeId;
      if (!targetWorktreeId) return;
      const { panelsById, panelIds } = usePanelStore.getState();
      for (const id of panelIds) {
        const t = panelsById[id];
        if (t && t.worktreeId === targetWorktreeId) {
          terminalInstanceService.resetRenderer(t.id);
        }
      }
    },
  }));

  actions.set("worktree.sessions.closeCompleted", () => ({
    id: "worktree.sessions.closeCompleted",
    title: "Close Completed Sessions",
    description: "Close completed sessions for a worktree",
    category: "worktree",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    argsSchema: z.object({ worktreeId: z.string().optional() }),
    run: async (args: unknown, ctx: ActionContext) => {
      const { worktreeId } = args as { worktreeId?: string };
      const targetWorktreeId = worktreeId ?? ctx.activeWorktreeId;
      if (!targetWorktreeId) return;
      const store = usePanelStore.getState();
      store.bulkCloseByWorktree(targetWorktreeId, "completed");
      store.bulkCloseByWorktree(targetWorktreeId, "exited");
    },
  }));

  actions.set("worktree.sessions.trashAll", () => ({
    id: "worktree.sessions.trashAll",
    title: "Trash All Sessions",
    description: "Move all sessions for a worktree to trash",
    category: "worktree",
    kind: "command",
    danger: "confirm",
    scope: "renderer",
    dangerRationale:
      "Moves all sessions for a worktree to trash. Scrollback is lost for each trashed terminal.",
    argsSchema: z
      .object({
        worktreeId: z.string().optional(),
        confirmed: z.boolean().optional(),
      })
      .optional(),
    run: async (args: unknown, ctx: ActionContext) => {
      const { worktreeId, confirmed } =
        (args as { worktreeId?: string; confirmed?: boolean } | undefined) ?? {};
      const targetWorktreeId = worktreeId ?? ctx.activeWorktreeId;
      if (!targetWorktreeId) return;
      const state = usePanelStore.getState();
      const targets = state.panelIds
        .map((id) => state.panelsById[id])
        .filter(
          (t): t is NonNullable<typeof t> =>
            t != null &&
            t.worktreeId === targetWorktreeId &&
            t.location !== "trash" &&
            t.location !== "overlay" &&
            // Dialog panels are ephemeral modal content, not worktree sessions —
            // including one inflates the confirmation count while the bulk
            // action that follows correctly skips it.
            t.location !== "dialog"
        );
      if (targets.length === 0) return;
      if (confirmed !== true) {
        // Classification leads wiring (CLAUDE.md hard rule 2): the action
        // body must gate even though `useWorktreeActions.handleCloseAll`
        // already wires a call-site dialog. Without this guard, action-palette
        // and keybinding dispatches would silently fire `bulkTrashByWorktree`.
        useTerminalPendingDestructiveActionStore.getState().request({
          kind: "worktreeTrashAll",
          targetCount: targets.length,
          runningAgentCount: collectRunningAgentTerminals(targets).length,
          worktreeId: targetWorktreeId,
        });
        return;
      }
      const pending = useTerminalPendingDestructiveActionStore.getState().pending;
      if (pending && pending.kind === "worktreeTrashAll") {
        useTerminalPendingDestructiveActionStore.getState().clear();
      }
      state.bulkTrashByWorktree(targetWorktreeId);
    },
  }));

  actions.set("worktree.sessions.endAll", () => ({
    id: "worktree.sessions.endAll",
    title: "End All Sessions",
    description: "Permanently end all sessions for a worktree",
    category: "worktree",
    kind: "command",
    danger: "confirm",
    // danger:"confirm" gated in run() (like `trashAll`), NOT only at the
    // WorktreeCard call site: ActionService lets user/keybinding/menu dispatch
    // through ungated, and `endAll` is a `BuiltInKeyAction` (keybinding-bindable),
    // so a bound key or menu pick would otherwise end every session with no
    // confirm (#11345). Palette-hidden is retained as a discoverability choice,
    // not the safety mechanism.
    palette: { mode: "hidden" },
    scope: "renderer",
    dangerRationale: "Permanently ends all sessions for a worktree. All scrollback is lost.",
    argsSchema: z
      .object({
        worktreeId: z.string().optional(),
        confirmed: z.boolean().optional(),
      })
      .optional(),
    run: async (args: unknown, ctx: ActionContext) => {
      const { worktreeId, confirmed } =
        (args as { worktreeId?: string; confirmed?: boolean } | undefined) ?? {};
      const targetWorktreeId = worktreeId ?? ctx.activeWorktreeId;
      if (!targetWorktreeId) return;
      const state = usePanelStore.getState();
      // Mirror `bulkCloseByWorktree`'s executor (isBulkActionTarget): it removes
      // every panel for the worktree except ephemeral dialog panels — including
      // trash/overlay — so the confirm count must use the same `!== "dialog"`
      // filter rather than `trashAll`'s narrower grid+dock one, or it undercounts.
      const targets = state.panelIds
        .map((id) => state.panelsById[id])
        .filter(
          (t): t is NonNullable<typeof t> =>
            t != null && t.worktreeId === targetWorktreeId && t.location !== "dialog"
        );
      if (targets.length === 0) return;
      // An agent dispatch that reaches run() has already cleared ActionService's
      // confirm gate via the host-attested `options.confirmed` (never in args),
      // so `dispatchSource === "agent"` means confirmed too — re-requesting would
      // double-prompt the MCP approval.
      if (confirmed !== true && ctx.dispatchSource !== "agent") {
        useTerminalPendingDestructiveActionStore.getState().request({
          kind: "worktreeEndAll",
          targetCount: targets.length,
          runningAgentCount: collectRunningAgentTerminals(targets).length,
          worktreeId: targetWorktreeId,
        });
        return;
      }
      const pending = useTerminalPendingDestructiveActionStore.getState().pending;
      // Scope the cleanup to THIS worktree's pending entry (tighter than
      // trashAll's kind-only clear) so a confirmed end-all for one worktree can't
      // dismiss another worktree's still-open end-all confirmation.
      if (
        pending &&
        pending.kind === "worktreeEndAll" &&
        pending.worktreeId === targetWorktreeId
      ) {
        useTerminalPendingDestructiveActionStore.getState().clear();
      }
      state.bulkCloseByWorktree(targetWorktreeId);
    },
  }));

  actions.set("worktree.sessions.clearHistory", () => ({
    id: "worktree.sessions.clearHistory",
    title: "Clear Session History",
    description:
      "Permanently delete this worktree's recorded resumable-session history so those sessions no longer appear when resuming agents. Open sessions are unaffected.",
    category: "worktree",
    kind: "command",
    danger: "confirm",
    // danger:"confirm" gated in run() (like `endAll`), NOT only at the
    // WorktreeCard call site: ActionService lets user/menu dispatch through
    // ungated, so any present or future non-agent caller would otherwise clear
    // the journal with no confirm (#11345). It carries no live panels, so the
    // pending snapshot uses `targetCount: 0` and the dialog copy ignores counts.
    // Palette-hidden is retained as a discoverability choice, not the safety
    // mechanism.
    palette: { mode: "hidden" },
    scope: "renderer",
    dangerRationale:
      "Permanently deletes this worktree's recorded resumable-session history. Records can't be recovered.",
    argsSchema: clearHistoryArgsSchema,
    run: async (args: unknown, ctx: ActionContext) => {
      const parsed = clearHistoryArgsSchema.safeParse(args ?? {});
      const worktreeId = parsed.success ? parsed.data.worktreeId : undefined;
      const confirmed = parsed.success ? parsed.data.confirmed : undefined;
      const targetWorktreeId = worktreeId ?? ctx.activeWorktreeId;
      if (!targetWorktreeId) return;
      // See `endAll`: `dispatchSource === "agent"` is already host-attested by
      // ActionService's confirm gate, so it counts as confirmed here too.
      if (confirmed !== true && ctx.dispatchSource !== "agent") {
        useTerminalPendingDestructiveActionStore.getState().request({
          kind: "worktreeClearHistory",
          targetCount: 0,
          runningAgentCount: 0,
          worktreeId: targetWorktreeId,
        });
        return;
      }
      const pending = useTerminalPendingDestructiveActionStore.getState().pending;
      // Scoped to this worktree's entry (see endAll) so a confirmed clear for one
      // worktree can't dismiss another's open clear-history confirmation.
      if (
        pending &&
        pending.kind === "worktreeClearHistory" &&
        pending.worktreeId === targetWorktreeId
      ) {
        useTerminalPendingDestructiveActionStore.getState().clear();
      }
      await window.electron.agentSessionHistory.clear(targetWorktreeId);
    },
  }));
}
