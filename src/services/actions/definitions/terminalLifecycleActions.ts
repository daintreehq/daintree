import type { ActionCallbacks, ActionRegistry } from "../actionTypes";
import { z } from "zod";
import { terminalClient } from "@/clients";
import { terminalInstanceService } from "@/services/terminal/TerminalInstanceService";
import { fireWatchNotification } from "@/lib/watchNotification";
import { usePanelStore } from "@/store/panelStore";
export function registerTerminalLifecycleActions(
  actions: ActionRegistry,
  callbacks: ActionCallbacks
): void {
  actions.set("terminal.close", () => ({
    id: "terminal.close",
    title: "Close Terminal",
    description:
      "Close a terminal (move to trash). Targets the specified terminal, or the focused terminal if omitted.",
    category: "terminal",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    argsSchema: z.object({ terminalId: z.string().optional() }).optional(),
    run: async (args: unknown) => {
      const { terminalId } = (args as { terminalId?: string } | undefined) ?? {};
      const state = usePanelStore.getState();
      const targetId =
        terminalId ??
        state.focusedId ??
        state.panelIds.find((id) => state.panelsById[id]?.location !== "trash");
      if (targetId) {
        state.trashPanel(targetId);
      }
    },
  }));

  actions.set("terminal.trash", () => ({
    id: "terminal.trash",
    title: "Trash Terminal",
    description: "Move terminal to trash",
    category: "terminal",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    argsSchema: z.object({ terminalId: z.string().optional() }),
    run: async (args: unknown) => {
      const { terminalId } = args as { terminalId?: string };
      const state = usePanelStore.getState();
      const targetId = terminalId ?? state.focusedId;
      if (targetId) {
        state.trashPanel(targetId);
      }
    },
  }));

  actions.set("terminal.background", () => ({
    id: "terminal.background",
    title: "Send to Background",
    description: "Hide terminal from view while keeping its process alive",
    category: "terminal",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    argsSchema: z.object({ terminalId: z.string().optional() }).optional(),
    run: async (args: unknown) => {
      const { terminalId } = (args as { terminalId?: string } | undefined) ?? {};
      const state = usePanelStore.getState();
      const targetId = terminalId ?? state.focusedId;
      if (targetId) {
        const group = state.getPanelGroup(targetId);
        if (group) {
          state.backgroundPanelGroup(targetId);
        } else {
          state.backgroundTerminal(targetId);
        }
      }
    },
  }));

  actions.set("terminal.kill", () => ({
    id: "terminal.kill",
    title: "Kill Terminal",
    description: "Permanently kill and remove terminal",
    category: "terminal",
    kind: "command",
    danger: "confirm",
    scope: "renderer",
    argsSchema: z.object({ terminalId: z.string().optional() }),
    run: async (args: unknown) => {
      const { terminalId } = args as { terminalId?: string };
      const state = usePanelStore.getState();
      const targetId = terminalId ?? state.focusedId;
      if (targetId) {
        state.removePanel(targetId);
      }
    },
  }));

  actions.set("terminal.restart", () => ({
    id: "terminal.restart",
    title: "Restart Terminal",
    description: "Restart the terminal process",
    category: "terminal",
    kind: "command",
    danger: "confirm",
    scope: "renderer",
    argsSchema: z.object({ terminalId: z.string().optional() }),
    run: async (args: unknown) => {
      const { terminalId } = args as { terminalId?: string };
      const state = usePanelStore.getState();
      const targetId = terminalId ?? state.focusedId;
      if (targetId) {
        state.restartTerminal(targetId);
      }
    },
  }));

  actions.set("terminal.redraw", () => ({
    id: "terminal.redraw",
    title: "Redraw Terminal",
    description: "Redraw terminal display to fix visual corruption",
    category: "terminal",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    argsSchema: z.object({ terminalId: z.string().optional() }).optional(),
    run: async (args: unknown) => {
      const { terminalId } = (args as { terminalId?: string } | undefined) ?? {};
      const state = usePanelStore.getState();
      const targetId = terminalId ?? state.focusedId;
      if (targetId) {
        terminalInstanceService.resetRenderer(targetId);
      }
    },
  }));

  actions.set("terminal.rename", () => ({
    id: "terminal.rename",
    title: "Rename Terminal",
    description:
      "Rename the terminal tab. If name is provided, renames programmatically. Otherwise opens the rename dialog.",
    category: "terminal",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    argsSchema: z.object({
      terminalId: z.string().optional(),
      name: z
        .string()
        .optional()
        .describe("New name for the terminal. If omitted, opens the rename dialog."),
    }),
    run: async (args: unknown) => {
      const { terminalId, name } = args as { terminalId?: string; name?: string };
      const targetId = terminalId ?? usePanelStore.getState().focusedId;
      if (!targetId) return;

      if (name !== undefined) {
        usePanelStore.getState().updateTitle(targetId, name);
      } else {
        window.dispatchEvent(
          new CustomEvent("daintree:rename-terminal", { detail: { id: targetId } })
        );
      }
    },
  }));

  actions.set("terminal.viewInfo", () => ({
    id: "terminal.viewInfo",
    title: "View Terminal Info",
    description: "View detailed terminal information",
    category: "terminal",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    argsSchema: z.object({ terminalId: z.string().optional() }),
    run: async (args: unknown) => {
      const { terminalId } = args as { terminalId?: string };
      const targetId = terminalId ?? usePanelStore.getState().focusedId;
      if (targetId) {
        window.dispatchEvent(
          new CustomEvent("daintree:open-terminal-info", { detail: { id: targetId } })
        );
      }
    },
  }));

  actions.set("terminal.info.open", () => ({
    id: "terminal.info.open",
    title: "Open Terminal Info",
    description: "Open terminal info dialog",
    category: "terminal",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    argsSchema: z.object({ terminalId: z.string().optional() }),
    run: async (args: unknown) => {
      const { terminalId } = args as { terminalId?: string };
      const targetId = terminalId ?? usePanelStore.getState().focusedId;
      if (targetId) {
        window.dispatchEvent(
          new CustomEvent("daintree:open-terminal-info", { detail: { id: targetId } })
        );
      }
    },
  }));

  actions.set("terminal.info.get", () => ({
    id: "terminal.info.get",
    title: "Get Terminal Info",
    description: "Get detailed terminal information for a terminal",
    category: "terminal",
    kind: "query",
    danger: "safe",
    scope: "renderer",
    argsSchema: z.object({ terminalId: z.string().optional() }).optional(),
    run: async (args: unknown) => {
      const { terminalId } = (args as { terminalId?: string } | undefined) ?? {};
      const targetId = terminalId ?? usePanelStore.getState().focusedId;
      if (!targetId) {
        throw new Error("No terminal selected");
      }
      return await window.electron.terminal.getInfo(targetId);
    },
  }));

  actions.set("terminal.toggleInputLock", () => ({
    id: "terminal.toggleInputLock",
    title: "Toggle Input Lock",
    description: "Toggle terminal input lock",
    category: "terminal",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    argsSchema: z.object({ terminalId: z.string().optional() }),
    run: async (args: unknown) => {
      const { terminalId } = args as { terminalId?: string };
      const state = usePanelStore.getState();
      const targetId = terminalId ?? state.focusedId;
      if (targetId) {
        state.toggleInputLocked(targetId);
      }
    },
  }));

  actions.set("terminal.forceResume", () => ({
    id: "terminal.forceResume",
    title: "Force Resume",
    description: "Force resume an agent terminal",
    category: "terminal",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    argsSchema: z.object({ terminalId: z.string().optional() }),
    run: async (args: unknown) => {
      const { terminalId } = args as { terminalId?: string };
      const targetId = terminalId ?? usePanelStore.getState().focusedId;
      if (targetId) {
        await terminalClient.forceResume(targetId);
      }
    },
  }));

  actions.set("terminal.closeAll", () => ({
    id: "terminal.closeAll",
    title: "Close All Terminals",
    description: "Move all terminals in the active worktree to trash",
    category: "terminal",
    kind: "command",
    danger: "confirm",
    scope: "renderer",
    run: async () => {
      const state = usePanelStore.getState();
      const activeWorktreeId = callbacks.getActiveWorktreeId();
      const idsToClose = state.panelIds.filter((id) => {
        const t = state.panelsById[id];
        return (
          t &&
          t.location !== "trash" &&
          (t.worktreeId ?? undefined) === (activeWorktreeId ?? undefined)
        );
      });
      idsToClose.forEach((id) => state.trashPanel(id));
    },
  }));

  actions.set("terminal.killAll", () => ({
    id: "terminal.killAll",
    title: "Kill All Terminals",
    description: "Permanently remove all terminals (cannot be undone)",
    category: "terminal",
    kind: "command",
    danger: "confirm",
    scope: "renderer",
    run: async () => {
      usePanelStore.getState().bulkCloseAll();
    },
  }));

  actions.set("terminal.restartAll", () => ({
    id: "terminal.restartAll",
    title: "Restart All Terminals",
    description: "Restart all terminals in the active worktree",
    category: "terminal",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    run: async () => {
      usePanelStore.getState().bulkRestartAll();
    },
  }));

  actions.set("terminal.restartService", () => ({
    id: "terminal.restartService",
    title: "Restart Terminal Service",
    description: "Restart the PTY host. Available only when the terminal backend is disconnected.",
    category: "terminal",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    isEnabled: () => usePanelStore.getState().backendStatus === "disconnected",
    run: async () => {
      await terminalClient.restartService();
    },
  }));

  actions.set("terminal.watch", () => ({
    id: "terminal.watch",
    title: "Watch This Terminal",
    description:
      "Toggle a one-shot watch — notifies when the agent completes, exits, or waits for input.",
    category: "terminal",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    keywords: ["monitor", "observe", "notify", "alert"],
    argsSchema: z.object({ terminalId: z.string().optional() }).optional(),
    isEnabled: (ctx) => !!ctx.focusedTerminalId,
    run: async (args: unknown, ctx) => {
      const { terminalId } = (args as { terminalId?: string } | undefined) ?? {};
      const state = usePanelStore.getState();
      const targetId = terminalId ?? ctx.focusedTerminalId ?? state.focusedId;
      if (!targetId) return;

      if (state.watchedPanels.has(targetId)) {
        state.unwatchPanel(targetId);
      } else {
        const terminal = state.panelsById[targetId];
        if (
          terminal?.agentState === "completed" ||
          terminal?.agentState === "waiting" ||
          terminal?.agentState === "exited"
        ) {
          fireWatchNotification(targetId, terminal.title ?? targetId, terminal.agentState);
        } else {
          state.watchPanel(targetId);
        }
      }
    },
  }));
}
