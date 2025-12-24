import type { ActionCallbacks, ActionRegistry } from "../actionTypes";
import { z } from "zod";
import type { ActionContext } from "@shared/types/actions";
import { terminalInstanceService } from "@/services/terminal/TerminalInstanceService";
import { useTerminalStore } from "@/store/terminalStore";

export function registerWorktreeSessionActions(
  actions: ActionRegistry,
  _callbacks: ActionCallbacks
): void {
  actions.set("worktree.sessions.minimizeAll", () => ({
    id: "worktree.sessions.minimizeAll",
    title: "Minimize All Sessions",
    description: "Move all grid sessions for a worktree to the dock",
    category: "worktree",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    argsSchema: z.object({ worktreeId: z.string().optional() }),
    run: async (args: unknown, ctx: ActionContext) => {
      const { worktreeId } = args as { worktreeId?: string };
      const targetWorktreeId = worktreeId ?? ctx.activeWorktreeId;
      if (!targetWorktreeId) return;
      useTerminalStore.getState().bulkMoveToDockByWorktree(targetWorktreeId);
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
      useTerminalStore.getState().bulkMoveToGridByWorktree(targetWorktreeId);
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
    argsSchema: z.object({ worktreeId: z.string().optional() }),
    run: async (args: unknown, ctx: ActionContext) => {
      const { worktreeId } = args as { worktreeId?: string };
      const targetWorktreeId = worktreeId ?? ctx.activeWorktreeId;
      if (!targetWorktreeId) return;
      await useTerminalStore.getState().bulkRestartByWorktree(targetWorktreeId);
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
      const terminals = useTerminalStore.getState().terminals;
      terminals
        .filter((t) => t.worktreeId === targetWorktreeId)
        .forEach((t) => terminalInstanceService.resetRenderer(t.id));
    },
  }));

  actions.set("worktree.sessions.closeCompleted", () => ({
    id: "worktree.sessions.closeCompleted",
    title: "Close Completed Sessions",
    description: "Close completed sessions for a worktree",
    category: "worktree",
    kind: "command",
    danger: "confirm",
    scope: "renderer",
    argsSchema: z.object({ worktreeId: z.string().optional() }),
    run: async (args: unknown, ctx: ActionContext) => {
      const { worktreeId } = args as { worktreeId?: string };
      const targetWorktreeId = worktreeId ?? ctx.activeWorktreeId;
      if (!targetWorktreeId) return;
      useTerminalStore.getState().bulkCloseByWorktree(targetWorktreeId, "completed");
    },
  }));

  actions.set("worktree.sessions.closeFailed", () => ({
    id: "worktree.sessions.closeFailed",
    title: "Close Failed Sessions",
    description: "Close failed sessions for a worktree",
    category: "worktree",
    kind: "command",
    danger: "confirm",
    scope: "renderer",
    argsSchema: z.object({ worktreeId: z.string().optional() }),
    run: async (args: unknown, ctx: ActionContext) => {
      const { worktreeId } = args as { worktreeId?: string };
      const targetWorktreeId = worktreeId ?? ctx.activeWorktreeId;
      if (!targetWorktreeId) return;
      useTerminalStore.getState().bulkCloseByWorktree(targetWorktreeId, "failed");
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
    argsSchema: z.object({ worktreeId: z.string().optional() }),
    run: async (args: unknown, ctx: ActionContext) => {
      const { worktreeId } = args as { worktreeId?: string };
      const targetWorktreeId = worktreeId ?? ctx.activeWorktreeId;
      if (!targetWorktreeId) return;
      useTerminalStore.getState().bulkTrashByWorktree(targetWorktreeId);
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
    argsSchema: z.object({ worktreeId: z.string().optional() }),
    run: async (args: unknown, ctx: ActionContext) => {
      const { worktreeId } = args as { worktreeId?: string };
      const targetWorktreeId = worktreeId ?? ctx.activeWorktreeId;
      if (!targetWorktreeId) return;
      useTerminalStore.getState().bulkCloseByWorktree(targetWorktreeId);
    },
  }));
}
