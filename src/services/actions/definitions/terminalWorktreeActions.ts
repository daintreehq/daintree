import type { ActionCallbacks, ActionRegistry } from "../actionTypes";
import type { ActionContext } from "@shared/types/actions";
import { usePanelStore } from "@/store/panelStore";
import { getCurrentViewStore } from "@/store/createWorktreeStore";
export function registerTerminalWorktreeActions(
  actions: ActionRegistry,
  _callbacks: ActionCallbacks
): void {
  const getTerminalWorktree = (ctx: ActionContext) => {
    const { focusedTerminalId } = ctx;
    if (!focusedTerminalId) return null;

    const terminal = usePanelStore.getState().panelsById[focusedTerminalId];
    if (!terminal?.worktreeId) return null;

    const worktree = getCurrentViewStore().getState().worktrees.get(terminal.worktreeId);
    if (!worktree) return null;

    return { terminal, worktree };
  };

  actions.set("terminal.openWorktreeEditor", () => ({
    id: "terminal.openWorktreeEditor",
    title: "Open Focused Terminal's Worktree Folder",
    description: "Open the folder for the focused terminal's worktree in your editor",
    category: "terminal",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    isEnabled: (ctx: ActionContext) => {
      return getTerminalWorktree(ctx) !== null;
    },
    disabledReason: (ctx: ActionContext) => {
      if (!ctx.focusedTerminalId) return "No focused terminal";
      const terminal = usePanelStore.getState().panelsById[ctx.focusedTerminalId!];
      if (!terminal) return "Focused terminal no longer exists";
      if (!terminal.worktreeId) return "Terminal has no associated worktree";
      const worktree = getCurrentViewStore().getState().worktrees.get(terminal.worktreeId);
      if (!worktree) return "Worktree no longer exists";
      return undefined;
    },
    run: async (_args: unknown, ctx: ActionContext) => {
      const data = getTerminalWorktree(ctx);
      if (!data) return;

      const { actionService } = await import("@/services/ActionService");
      const result = await actionService.dispatch(
        "worktree.openEditor",
        { worktreeId: data.worktree.id },
        { source: "user" }
      );
      if (!result.ok) {
        throw new Error(result.error.message);
      }
    },
  }));

  actions.set("terminal.openWorktreeIssue", () => ({
    id: "terminal.openWorktreeIssue",
    title: "Open Focused Terminal's Worktree Issue",
    description: "Open the GitHub issue for the focused terminal's worktree",
    category: "terminal",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    isEnabled: (ctx: ActionContext) => {
      const data = getTerminalWorktree(ctx);
      return data !== null && !!data.worktree.issueNumber;
    },
    disabledReason: (ctx: ActionContext) => {
      if (!ctx.focusedTerminalId) return "No focused terminal";
      const terminal = usePanelStore.getState().panelsById[ctx.focusedTerminalId!];
      if (!terminal) return "Focused terminal no longer exists";
      if (!terminal.worktreeId) return "Terminal has no associated worktree";
      const worktree = getCurrentViewStore().getState().worktrees.get(terminal.worktreeId);
      if (!worktree) return "Worktree no longer exists";
      if (!worktree.issueNumber) return "Worktree has no associated issue";
      return undefined;
    },
    run: async (_args: unknown, ctx: ActionContext) => {
      const data = getTerminalWorktree(ctx);
      if (!data || !data.worktree.issueNumber) return;

      const { actionService } = await import("@/services/ActionService");
      const result = await actionService.dispatch(
        "worktree.openIssue",
        { worktreeId: data.worktree.id },
        { source: "user" }
      );
      if (!result.ok) {
        throw new Error(result.error.message);
      }
    },
  }));

  actions.set("terminal.openWorktreePR", () => ({
    id: "terminal.openWorktreePR",
    title: "Open Focused Terminal's Worktree Pull Request",
    description: "Open the GitHub pull request for the focused terminal's worktree",
    category: "terminal",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    isEnabled: (ctx: ActionContext) => {
      const data = getTerminalWorktree(ctx);
      return data !== null && !!data.worktree.prUrl;
    },
    disabledReason: (ctx: ActionContext) => {
      if (!ctx.focusedTerminalId) return "No focused terminal";
      const terminal = usePanelStore.getState().panelsById[ctx.focusedTerminalId!];
      if (!terminal) return "Focused terminal no longer exists";
      if (!terminal.worktreeId) return "Terminal has no associated worktree";
      const worktree = getCurrentViewStore().getState().worktrees.get(terminal.worktreeId);
      if (!worktree) return "Worktree no longer exists";
      if (!worktree.prUrl) return "Worktree has no associated pull request";
      return undefined;
    },
    run: async (_args: unknown, ctx: ActionContext) => {
      const data = getTerminalWorktree(ctx);
      if (!data || !data.worktree.prUrl) return;

      const { actionService } = await import("@/services/ActionService");
      const result = await actionService.dispatch(
        "worktree.openPR",
        { worktreeId: data.worktree.id },
        { source: "user" }
      );
      if (!result.ok) {
        throw new Error(result.error.message);
      }
    },
  }));
}
