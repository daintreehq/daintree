import type { ActionCallbacks, ActionRegistry } from "../actionTypes";
import { z } from "zod";
import type { ActionContext, ActionId } from "@shared/types/actions";
import { copyTreeClient, githubClient, systemClient, worktreeClient } from "@/clients";
import { useWorktreeDataStore } from "@/store/worktreeDataStore";
import { useWorktreeSelectionStore } from "@/store/worktreeStore";
import { useTerminalStore } from "@/store/terminalStore";
import { getFormatForTerminal } from "@/lib/copyTreeFormat";

export function registerWorktreeActions(actions: ActionRegistry, callbacks: ActionCallbacks): void {
  actions.set("worktree.refresh", () => ({
    id: "worktree.refresh",
    title: "Refresh Worktrees",
    description: "Refresh the worktree list from the backend",
    category: "worktree",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    run: async () => {
      await useWorktreeDataStore.getState().refresh();
    },
  }));

  actions.set("worktree.refreshPullRequests", () => ({
    id: "worktree.refreshPullRequests",
    title: "Refresh Pull Requests",
    description: "Refresh PR information for all worktrees",
    category: "worktree",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    run: async () => {
      await worktreeClient.refreshPullRequests();
    },
  }));

  actions.set("worktree.setActive", () => ({
    id: "worktree.setActive",
    title: "Set Active Worktree",
    description: "Set the active worktree in the backend",
    category: "worktree",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    argsSchema: z.object({ worktreeId: z.string() }),
    run: async (args: unknown) => {
      const { worktreeId } = args as { worktreeId: string };
      await worktreeClient.setActive(worktreeId);
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
    run: async () => {
      useWorktreeSelectionStore.getState().openCreateDialog();
    },
  }));

  actions.set("worktree.create", () => ({
    id: "worktree.create",
    title: "Create Worktree",
    description: "Create a new worktree",
    category: "worktree",
    kind: "command",
    danger: "confirm",
    scope: "renderer",
    argsSchema: z.object({
      rootPath: z.string(),
      options: z.any(),
    }),
    resultSchema: z.string(),
    run: async (args: unknown) => {
      const { rootPath, options } = args as { rootPath: string; options: unknown };
      const worktreeId = await worktreeClient.create(options as any, rootPath);
      if (!worktreeId) {
        throw new Error("Failed to create worktree: no worktreeId returned from backend");
      }
      useWorktreeSelectionStore.getState().selectWorktree(worktreeId);
      return worktreeId;
    },
  }));

  actions.set("worktree.listBranches", () => ({
    id: "worktree.listBranches",
    title: "List Branches",
    description: "List git branches for a repository root",
    category: "worktree",
    kind: "query",
    danger: "safe",
    scope: "renderer",
    argsSchema: z.object({ rootPath: z.string() }),
    run: async (args: unknown) => {
      const { rootPath } = args as { rootPath: string };
      return await worktreeClient.listBranches(rootPath);
    },
  }));

  actions.set("worktree.getDefaultPath", () => ({
    id: "worktree.getDefaultPath",
    title: "Get Default Worktree Path",
    description: "Get the default path for a new worktree based on branch and config",
    category: "worktree",
    kind: "query",
    danger: "safe",
    scope: "renderer",
    argsSchema: z.object({ rootPath: z.string(), branchName: z.string() }),
    run: async (args: unknown) => {
      const { rootPath, branchName } = args as { rootPath: string; branchName: string };
      return await worktreeClient.getDefaultPath(rootPath, branchName);
    },
  }));

  actions.set("worktree.delete", () => ({
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
    run: async (args: unknown) => {
      const { worktreeId, force, deleteBranch } = args as {
        worktreeId: string;
        force?: boolean;
        deleteBranch?: boolean;
      };
      await worktreeClient.delete(worktreeId, force, deleteBranch);
    },
  }));

  actions.set("worktree.select", () => ({
    id: "worktree.select",
    title: "Select Worktree",
    description: "Select a worktree by ID",
    category: "worktree",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    argsSchema: z.object({ worktreeId: z.string().optional() }).optional(),
    run: async (args: unknown, ctx: ActionContext) => {
      const { worktreeId } = (args ?? {}) as { worktreeId?: string };
      const targetWorktreeId = worktreeId ?? ctx.focusedWorktreeId ?? ctx.activeWorktreeId;
      if (!targetWorktreeId) {
        throw new Error("No worktree selected");
      }
      useWorktreeSelectionStore.getState().selectWorktree(targetWorktreeId);
    },
  }));

  actions.set("worktree.next", () => ({
    id: "worktree.next",
    title: "Next Worktree",
    description: "Switch to the next worktree",
    category: "worktree",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    run: async () => {
      const worktrees = callbacks.getWorktrees();
      if (worktrees.length === 0) return;
      const activeWorktreeId = callbacks.getActiveWorktreeId();
      const currentIndex = activeWorktreeId
        ? worktrees.findIndex((w) => w.id === activeWorktreeId)
        : -1;
      const nextIndex = currentIndex === -1 ? 0 : (currentIndex + 1) % worktrees.length;
      useWorktreeSelectionStore.getState().selectWorktree(worktrees[nextIndex].id);
    },
  }));

  actions.set("worktree.previous", () => ({
    id: "worktree.previous",
    title: "Previous Worktree",
    description: "Switch to the previous worktree",
    category: "worktree",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    run: async () => {
      const worktrees = callbacks.getWorktrees();
      if (worktrees.length === 0) return;
      const activeWorktreeId = callbacks.getActiveWorktreeId();
      const currentIndex = activeWorktreeId
        ? worktrees.findIndex((w) => w.id === activeWorktreeId)
        : -1;
      const prevIndex =
        currentIndex === -1 ? 0 : (currentIndex - 1 + worktrees.length) % worktrees.length;
      useWorktreeSelectionStore.getState().selectWorktree(worktrees[prevIndex].id);
    },
  }));

  // Worktree switch by index (parameterized)
  actions.set("worktree.switchIndex", () => ({
    id: "worktree.switchIndex",
    title: "Switch to Worktree by Index",
    description: "Switch to worktree at a specific position (1-9)",
    category: "worktree",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    argsSchema: z.object({ index: z.number().int().min(1).max(9) }),
    run: async (args: unknown) => {
      const { index } = args as { index: number };
      const worktrees = callbacks.getWorktrees();
      if (worktrees.length >= index) {
        useWorktreeSelectionStore.getState().selectWorktree(worktrees[index - 1].id);
      }
    },
  }));

  // Non-parameterized worktree switch actions (for KeyAction/keybinding compatibility)
  for (let index = 1; index <= 9; index++) {
    const actionId = `worktree.switch${index}` as ActionId;
    actions.set(actionId, () => ({
      id: actionId,
      title: `Switch to Worktree ${index}`,
      description: `Switch to worktree at position ${index}`,
      category: "worktree",
      kind: "command",
      danger: "safe",
      scope: "renderer",
      run: async () => {
        const worktrees = callbacks.getWorktrees();
        if (worktrees.length >= index) {
          useWorktreeSelectionStore.getState().selectWorktree(worktrees[index - 1].id);
        }
      },
    }));
  }

  const selectWorktreeByOffset = (offset: number) => {
    const worktrees = callbacks.getWorktrees();
    if (worktrees.length === 0) return;
    const activeWorktreeId = callbacks.getActiveWorktreeId();
    const currentIndex = activeWorktreeId
      ? worktrees.findIndex((w) => w.id === activeWorktreeId)
      : -1;
    const baseIndex = currentIndex === -1 ? 0 : currentIndex;
    const nextIndex = baseIndex + offset;
    if (nextIndex < 0 || nextIndex >= worktrees.length) return;
    useWorktreeSelectionStore.getState().selectWorktree(worktrees[nextIndex].id);
  };

  actions.set("worktree.up", () => ({
    id: "worktree.up",
    title: "Worktree Up",
    description: "Move selection up in the worktree list",
    category: "worktree",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    run: async () => {
      selectWorktreeByOffset(-1);
    },
  }));

  actions.set("worktree.down", () => ({
    id: "worktree.down",
    title: "Worktree Down",
    description: "Move selection down in the worktree list",
    category: "worktree",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    run: async () => {
      selectWorktreeByOffset(1);
    },
  }));

  actions.set("worktree.upVim", () => ({
    id: "worktree.upVim",
    title: "Worktree Up (Vim)",
    description: "Move selection up in the worktree list",
    category: "worktree",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    run: async () => {
      selectWorktreeByOffset(-1);
    },
  }));

  actions.set("worktree.downVim", () => ({
    id: "worktree.downVim",
    title: "Worktree Down (Vim)",
    description: "Move selection down in the worktree list",
    category: "worktree",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    run: async () => {
      selectWorktreeByOffset(1);
    },
  }));

  actions.set("worktree.home", () => ({
    id: "worktree.home",
    title: "Worktree Home",
    description: "Select the first worktree",
    category: "worktree",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    run: async () => {
      const worktrees = callbacks.getWorktrees();
      if (worktrees.length === 0) return;
      useWorktreeSelectionStore.getState().selectWorktree(worktrees[0].id);
    },
  }));

  actions.set("worktree.end", () => ({
    id: "worktree.end",
    title: "Worktree End",
    description: "Select the last worktree",
    category: "worktree",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    run: async () => {
      const worktrees = callbacks.getWorktrees();
      if (worktrees.length === 0) return;
      useWorktreeSelectionStore.getState().selectWorktree(worktrees[worktrees.length - 1].id);
    },
  }));

  actions.set("worktree.selectSpace", () => ({
    id: "worktree.selectSpace",
    title: "Select Worktree (Space)",
    description: "Select the currently focused worktree",
    category: "worktree",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    run: async () => {
      const focused = useWorktreeSelectionStore.getState().focusedWorktreeId;
      if (!focused) return;
      useWorktreeSelectionStore.getState().selectWorktree(focused);
    },
  }));

  actions.set("worktree.openPalette", () => ({
    id: "worktree.openPalette",
    title: "Open Worktree Palette",
    description: "Open the worktree selection palette",
    category: "worktree",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    run: async () => {
      callbacks.onOpenWorktreePalette();
    },
  }));

  actions.set("worktree.overview", () => ({
    id: "worktree.overview",
    title: "Toggle Worktree Overview",
    description: "Open or close the full-screen worktree overview modal",
    category: "worktree",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    run: async () => {
      callbacks.onOpenWorktreeOverview();
    },
  }));

  actions.set("worktree.overview.open", () => ({
    id: "worktree.overview.open",
    title: "Open Worktree Overview",
    description: "Open the full-screen worktree overview modal",
    category: "worktree",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    run: async () => {
      callbacks.onOpenWorktreeOverview();
    },
  }));

  actions.set("worktree.overview.close", () => ({
    id: "worktree.overview.close",
    title: "Close Worktree Overview",
    description: "Close the full-screen worktree overview modal",
    category: "worktree",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    run: async () => {
      callbacks.onCloseWorktreeOverview();
    },
  }));

  actions.set("worktree.panel", () => ({
    id: "worktree.panel",
    title: "Open Worktree Panel",
    description: "Open the worktree panel",
    category: "worktree",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    run: async () => {
      callbacks.onOpenWorktreePalette();
    },
  }));

  actions.set("worktree.copyTree", () => ({
    id: "worktree.copyTree",
    title: "Copy Worktree Context",
    description: "Generate and copy context for a worktree to clipboard",
    category: "worktree",
    kind: "command",
    danger: "confirm",
    scope: "renderer",
    argsSchema: z
      .object({
        worktreeId: z.string().optional(),
        format: z.enum(["xml", "json", "markdown", "tree", "ndjson"]).optional(),
        modified: z.boolean().optional(),
      })
      .optional(),
    run: async (args: unknown, ctx: ActionContext) => {
      const {
        worktreeId,
        format: explicitFormat,
        modified,
      } = (args ?? {}) as {
        worktreeId?: string;
        format?: "xml" | "json" | "markdown" | "tree" | "ndjson";
        modified?: boolean;
      };
      const targetWorktreeId = worktreeId ?? ctx.focusedWorktreeId ?? ctx.activeWorktreeId;
      if (!targetWorktreeId) return null;

      const terminal = ctx.focusedTerminalId
        ? useTerminalStore.getState().terminals.find((t) => t.id === ctx.focusedTerminalId)
        : undefined;
      const format = explicitFormat ?? getFormatForTerminal(terminal);

      const result = await copyTreeClient.generateAndCopyFile(targetWorktreeId, {
        format,
        modified,
      });

      if (result.error) {
        if (modified && result.error.includes("No valid files")) {
          throw new Error("No modified files to copy. Make some changes first.");
        }
        throw new Error(result.error);
      }

      return {
        worktreeId: targetWorktreeId,
        fileCount: result.fileCount,
        stats: result.stats ?? null,
        format,
      };
    },
  }));

  actions.set("worktree.copyContext", () => ({
    id: "worktree.copyContext",
    title: "Copy Worktree Context (Alias)",
    description: "Alias for worktree.copyTree",
    category: "worktree",
    kind: "command",
    danger: "confirm",
    scope: "renderer",
    argsSchema: z
      .object({
        worktreeId: z.string().optional(),
        format: z.enum(["xml", "json", "markdown", "tree", "ndjson"]).optional(),
        modified: z.boolean().optional(),
      })
      .optional(),
    run: async (args: unknown) => {
      const { actionService } = await import("@/services/ActionService");
      const result = await actionService.dispatch("worktree.copyTree", args, { source: "user" });
      if (!result.ok) {
        throw new Error(result.error.message);
      }
      return result.result as unknown;
    },
  }));

  actions.set("worktree.inject", () => ({
    id: "worktree.inject",
    title: "Inject Worktree Context into Focused Terminal",
    description: "Inject this worktree's context into the currently focused terminal",
    category: "worktree",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    argsSchema: z
      .object({
        worktreeId: z.string().optional(),
      })
      .optional(),
    isEnabled: (ctx: ActionContext) => {
      const hasFocusedTerminal = Boolean(ctx.focusedTerminalId);
      return hasFocusedTerminal;
    },
    disabledReason: (ctx: ActionContext) => {
      const hasFocusedTerminal = Boolean(ctx.focusedTerminalId);
      if (!hasFocusedTerminal) {
        return "No focused terminal to inject into";
      }
      return undefined;
    },
    run: async (args: unknown, ctx: ActionContext) => {
      const hasFocusedTerminal = Boolean(ctx.focusedTerminalId);
      if (!hasFocusedTerminal) {
        throw new Error("No focused terminal to inject into");
      }
      const { worktreeId } = (args ?? {}) as { worktreeId?: string };
      const targetWorktreeId = worktreeId ?? ctx.focusedWorktreeId ?? ctx.activeWorktreeId;
      if (!targetWorktreeId) {
        throw new Error("No worktree selected");
      }
      callbacks.onInject(targetWorktreeId);
    },
  }));

  actions.set("worktree.openEditor", () => ({
    id: "worktree.openEditor",
    title: "Open in Editor",
    description: "Open a worktree folder in the OS file manager / editor",
    category: "worktree",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    argsSchema: z.object({ worktreeId: z.string().optional() }).optional(),
    run: async (args: unknown, ctx: ActionContext) => {
      const { worktreeId } = (args ?? {}) as { worktreeId?: string };
      const targetWorktreeId = worktreeId ?? ctx.focusedWorktreeId ?? ctx.activeWorktreeId;
      if (!targetWorktreeId) return;

      const worktree = useWorktreeDataStore.getState().worktrees.get(targetWorktreeId);
      if (!worktree) return;

      await systemClient.openPath(worktree.path);
    },
  }));

  actions.set("worktree.reveal", () => ({
    id: "worktree.reveal",
    title: "Reveal Worktree",
    description: "Reveal a worktree folder in the OS file manager",
    category: "worktree",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    argsSchema: z.object({ worktreeId: z.string().optional() }).optional(),
    run: async (args: unknown, ctx: ActionContext) => {
      const { worktreeId } = (args ?? {}) as { worktreeId?: string };
      const targetWorktreeId = worktreeId ?? ctx.focusedWorktreeId ?? ctx.activeWorktreeId;
      if (!targetWorktreeId) return;
      const worktree = useWorktreeDataStore.getState().worktrees.get(targetWorktreeId);
      if (!worktree) return;
      await systemClient.openPath(worktree.path);
    },
  }));

  actions.set("worktree.openIssue", () => ({
    id: "worktree.openIssue",
    title: "Open Worktree Issue",
    description: "Open the GitHub issue associated with a worktree",
    category: "worktree",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    argsSchema: z.object({ worktreeId: z.string().optional() }).optional(),
    run: async (args: unknown, ctx: ActionContext) => {
      const { worktreeId } = (args ?? {}) as { worktreeId?: string };
      const targetWorktreeId = worktreeId ?? ctx.focusedWorktreeId ?? ctx.activeWorktreeId;
      if (!targetWorktreeId) return;
      const worktree = useWorktreeDataStore.getState().worktrees.get(targetWorktreeId);
      if (!worktree?.issueNumber) return;
      await githubClient.openIssue(worktree.path, worktree.issueNumber);
    },
  }));

  actions.set("worktree.openPR", () => ({
    id: "worktree.openPR",
    title: "Open Worktree Pull Request",
    description: "Open the GitHub pull request associated with a worktree",
    category: "worktree",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    argsSchema: z.object({ worktreeId: z.string().optional() }).optional(),
    run: async (args: unknown, ctx: ActionContext) => {
      const { worktreeId } = (args ?? {}) as { worktreeId?: string };
      const targetWorktreeId = worktreeId ?? ctx.focusedWorktreeId ?? ctx.activeWorktreeId;
      if (!targetWorktreeId) return;
      const worktree = useWorktreeDataStore.getState().worktrees.get(targetWorktreeId);
      if (!worktree?.prUrl) return;
      await githubClient.openPR(worktree.prUrl);
    },
  }));

  actions.set("worktree.openPRInSidecar", () => ({
    id: "worktree.openPRInSidecar",
    title: "Open Worktree PR in Sidecar",
    description: "Open the worktree's GitHub pull request in the integrated browser",
    category: "worktree",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    argsSchema: z.object({ worktreeId: z.string().optional() }).optional(),
    run: async (args: unknown, ctx: ActionContext) => {
      const { worktreeId } = (args ?? {}) as { worktreeId?: string };
      const targetWorktreeId = worktreeId ?? ctx.focusedWorktreeId ?? ctx.activeWorktreeId;
      if (!targetWorktreeId) return;

      const worktree = useWorktreeDataStore.getState().worktrees.get(targetWorktreeId);
      if (!worktree?.prUrl) return;

      try {
        const url = new URL(worktree.prUrl);
        if (!["https:", "http:"].includes(url.protocol)) {
          console.error(`Invalid PR URL protocol: ${url.protocol}`);
          return;
        }
      } catch (error) {
        console.error(`Invalid PR URL: ${worktree.prUrl}`, error);
        return;
      }

      const { actionService } = await import("@/services/ActionService");
      await actionService.dispatch(
        "sidecar.openUrl",
        {
          url: worktree.prUrl,
          title: worktree.prTitle || `PR #${worktree.prNumber}`,
          background: false,
        },
        { source: "user" }
      );
    },
    isEnabled: (ctx: ActionContext) => {
      const worktreeId = ctx.focusedWorktreeId ?? ctx.activeWorktreeId;
      if (!worktreeId) return false;
      const worktree = useWorktreeDataStore.getState().worktrees.get(worktreeId);
      return typeof worktree?.prUrl === "string" && worktree.prUrl.trim().length > 0;
    },
  }));

  actions.set("worktree.openIssueInSidecar", () => ({
    id: "worktree.openIssueInSidecar",
    title: "Open Worktree Issue in Sidecar",
    description: "Open the worktree's GitHub issue in the integrated browser",
    category: "worktree",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    argsSchema: z.object({ worktreeId: z.string().optional() }).optional(),
    run: async (args: unknown, ctx: ActionContext) => {
      const { worktreeId } = (args ?? {}) as { worktreeId?: string };
      const targetWorktreeId = worktreeId ?? ctx.focusedWorktreeId ?? ctx.activeWorktreeId;
      if (!targetWorktreeId) return;

      const worktree = useWorktreeDataStore.getState().worktrees.get(targetWorktreeId);
      if (!worktree?.issueNumber) return;

      const issueUrl = await githubClient.getIssueUrl(worktree.path, worktree.issueNumber);
      if (!issueUrl) return;

      const { actionService } = await import("@/services/ActionService");
      await actionService.dispatch(
        "sidecar.openUrl",
        {
          url: issueUrl,
          title: worktree.issueTitle || `Issue #${worktree.issueNumber}`,
          background: false,
        },
        { source: "user" }
      );
    },
    isEnabled: (ctx: ActionContext) => {
      const worktreeId = ctx.focusedWorktreeId ?? ctx.activeWorktreeId;
      if (!worktreeId) return false;
      const worktree = useWorktreeDataStore.getState().worktrees.get(worktreeId);
      return typeof worktree?.issueNumber === "number" && worktree.issueNumber > 0;
    },
  }));
}
