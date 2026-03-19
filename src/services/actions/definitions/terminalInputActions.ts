import type { ActionCallbacks, ActionRegistry } from "../actionTypes";
import { z } from "zod";
import type { ActionId } from "@shared/types/actions";
import { openPanelContextMenu } from "@/lib/panelContextMenu";
import { useTerminalStore } from "@/store/terminalStore";
import { panelKindHasPty } from "@shared/config/panelKindRegistry";
export function registerTerminalInputActions(
  actions: ActionRegistry,
  callbacks: ActionCallbacks
): void {
  actions.set("terminal.inject", () => ({
    id: "terminal.inject",
    title: "Inject Context",
    description: "Inject worktree context into terminal",
    category: "terminal",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    run: async () => {
      const activeWorktreeId = callbacks.getActiveWorktreeId();
      if (activeWorktreeId) {
        callbacks.onInject(activeWorktreeId);
      }
    },
  }));

  actions.set("terminal.contextMenu", () => ({
    id: "terminal.contextMenu",
    title: "Open Context Menu",
    description: "Open the context menu for the focused panel",
    category: "terminal",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    argsSchema: z.object({ terminalId: z.string().optional() }),
    run: async (args: unknown) => {
      const { terminalId } = (args ?? {}) as { terminalId?: string };
      const state = useTerminalStore.getState();
      const targetId = terminalId ?? state.focusedId;
      if (targetId) {
        openPanelContextMenu(targetId);
      }
    },
  }));

  actions.set("terminal.stashInput", () => ({
    id: "terminal.stashInput" as ActionId,
    title: "Stash Input",
    description: "Park the current hybrid input draft to a temporary stash slot",
    category: "terminal",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    run: async () => {
      const { triggerStashInput } = await import("@/store/terminalInputStore");
      const state = useTerminalStore.getState();
      const targetId = state.focusedId;
      if (targetId) triggerStashInput(targetId);
    },
  }));

  actions.set("terminal.popStash", () => ({
    id: "terminal.popStash" as ActionId,
    title: "Restore Stashed Input",
    description: "Restore the previously stashed hybrid input draft",
    category: "terminal",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    run: async () => {
      const { triggerPopStash } = await import("@/store/terminalInputStore");
      const state = useTerminalStore.getState();
      const targetId = state.focusedId;
      if (targetId) triggerPopStash(targetId);
    },
  }));

  actions.set("terminal.sendToAgent", () => ({
    id: "terminal.sendToAgent" as ActionId,
    title: "Send to Agent",
    description: "Send terminal selection to another agent or terminal panel",
    category: "terminal",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    argsSchema: z.object({ terminalId: z.string().optional() }),
    run: async (args: unknown) => {
      const { terminalId } = (args ?? {}) as { terminalId?: string };
      const state = useTerminalStore.getState();
      const sourceId = terminalId ?? state.focusedId;
      if (!sourceId) return;

      const terminal = state.terminals.find((t) => t.id === sourceId);
      if (!terminal) return;
      if (terminal.kind && !panelKindHasPty(terminal.kind)) return;

      const { openSendToAgentPalette } = await import("@/hooks/useSendToAgentPalette");
      openSendToAgentPalette(sourceId);
    },
  }));
}
