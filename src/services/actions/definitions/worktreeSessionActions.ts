import type { ActionCallbacks, ActionRegistry } from "../actionTypes";
import { z } from "zod";
import type { ActionContext } from "@shared/types/actions";
import { terminalInstanceService } from "@/services/terminal/TerminalInstanceService";
import { usePanelStore } from "@/store/panelStore";
import { useTerminalPendingDestructiveActionStore } from "@/store/terminalPendingDestructiveActionStore";
import { collectRunningAgentTerminals } from "@/utils/destructiveSessionConfirm";

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
            t != null && t.worktreeId === targetWorktreeId && t.location !== "trash"
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
            t != null && t.worktreeId === targetWorktreeId && t.location !== "trash"
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
    scope: "renderer",
    dangerRationale: "Permanently ends all sessions for a worktree. All scrollback is lost.",
    argsSchema: z.object({ worktreeId: z.string().optional() }),
    run: async (args: unknown, ctx: ActionContext) => {
      const { worktreeId } = args as { worktreeId?: string };
      const targetWorktreeId = worktreeId ?? ctx.activeWorktreeId;
      if (!targetWorktreeId) return;
      usePanelStore.getState().bulkCloseByWorktree(targetWorktreeId);
    },
  }));
}
