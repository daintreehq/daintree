import type { ActionCallbacks, ActionRegistry } from "../actionTypes";
import { z } from "zod";
import { appClient, terminalClient } from "@/clients";
import { useTerminalStore } from "@/store/terminalStore";
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
      const state = useTerminalStore.getState();
      const targetId =
        terminalId ?? state.focusedId ?? state.terminals.find((t) => t.location !== "trash")?.id;
      if (targetId) {
        state.trashTerminal(targetId);
        const remaining = useTerminalStore
          .getState()
          .terminals.filter((t) => t.location !== "trash");
        if (remaining.length === 0) {
          await appClient.quit();
        }
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
      const state = useTerminalStore.getState();
      const targetId = terminalId ?? state.focusedId;
      if (targetId) {
        state.trashTerminal(targetId);
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
      const state = useTerminalStore.getState();
      const targetId = terminalId ?? state.focusedId;
      if (targetId) {
        state.backgroundTerminal(targetId);
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
      const state = useTerminalStore.getState();
      const targetId = terminalId ?? state.focusedId;
      if (targetId) {
        state.removeTerminal(targetId);
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
      const state = useTerminalStore.getState();
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
      const state = useTerminalStore.getState();
      const targetId = terminalId ?? state.focusedId;
      if (targetId) {
        const { terminalInstanceService } =
          await import("@/services/terminal/TerminalInstanceService");
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
      const targetId = terminalId ?? useTerminalStore.getState().focusedId;
      if (!targetId) return;

      if (name !== undefined) {
        useTerminalStore.getState().updateTitle(targetId, name);
      } else {
        window.dispatchEvent(
          new CustomEvent("canopy:rename-terminal", { detail: { id: targetId } })
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
      const targetId = terminalId ?? useTerminalStore.getState().focusedId;
      if (targetId) {
        window.dispatchEvent(
          new CustomEvent("canopy:open-terminal-info", { detail: { id: targetId } })
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
      const targetId = terminalId ?? useTerminalStore.getState().focusedId;
      if (targetId) {
        window.dispatchEvent(
          new CustomEvent("canopy:open-terminal-info", { detail: { id: targetId } })
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
      const targetId = terminalId ?? useTerminalStore.getState().focusedId;
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
      const state = useTerminalStore.getState();
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
      const targetId = terminalId ?? useTerminalStore.getState().focusedId;
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
      const state = useTerminalStore.getState();
      const activeWorktreeId = callbacks.getActiveWorktreeId();
      const terminalsToClose = state.terminals.filter(
        (t) =>
          t.location !== "trash" && (t.worktreeId ?? undefined) === (activeWorktreeId ?? undefined)
      );
      terminalsToClose.forEach((t) => state.trashTerminal(t.id));
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
      useTerminalStore.getState().bulkCloseAll();
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
      useTerminalStore.getState().bulkRestartAll();
    },
  }));

  actions.set("terminal.watch", () => ({
    id: "terminal.watch",
    title: "Watch This Terminal",
    description:
      "Toggle a one-shot watch on the focused terminal — fires a high-priority notification when the agent completes or waits for input",
    category: "terminal",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    isEnabled: (ctx) => !!ctx.focusedTerminalId,
    run: async (_args, ctx) => {
      const state = useTerminalStore.getState();
      const targetId = ctx.focusedTerminalId ?? state.focusedId;
      if (!targetId) return;

      if (state.watchedPanels.has(targetId)) {
        state.unwatchPanel(targetId);
      } else {
        const terminal = state.terminals.find((t) => t.id === targetId);
        // Fire immediately if agent is already in a terminal attention state
        if (terminal?.agentState === "completed" || terminal?.agentState === "waiting") {
          const { fireWatchNotification } = await import("@/lib/watchNotification");
          fireWatchNotification(
            targetId,
            terminal.title ?? targetId,
            terminal.agentState,
            terminal.worktreeId ?? undefined
          );
        } else {
          state.watchPanel(targetId);
        }
      }
    },
  }));
}
