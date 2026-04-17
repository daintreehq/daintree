import type { ActionCallbacks, ActionRegistry } from "../actionTypes";
import { z } from "zod";
import { openPanelContextMenu } from "@/lib/panelContextMenu";
import { usePanelStore } from "@/store/panelStore";
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

  actions.set("terminal.copy", () => ({
    id: "terminal.copy",
    title: "Copy Selection",
    description: "Copy the current terminal selection to clipboard",
    category: "terminal",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    argsSchema: z.object({ terminalId: z.string().optional() }).optional(),
    run: async (args: unknown) => {
      const { terminalId } = (args as { terminalId?: string } | undefined) ?? {};
      const state = usePanelStore.getState();
      const targetId = terminalId ?? state.focusedId;
      if (!targetId) return;
      const { terminalInstanceService } =
        await import("@/services/terminal/TerminalInstanceService");
      const managed = terminalInstanceService.get(targetId);
      if (managed?.terminal) {
        const selection = managed.terminal.getSelection();
        if (selection) {
          await navigator.clipboard.writeText(selection);
        }
      }
    },
  }));

  actions.set("terminal.paste", () => ({
    id: "terminal.paste",
    title: "Paste",
    description: "Paste clipboard content into the terminal",
    category: "terminal",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    argsSchema: z.object({ terminalId: z.string().optional() }).optional(),
    run: async (args: unknown) => {
      const { terminalId } = (args as { terminalId?: string } | undefined) ?? {};
      const state = usePanelStore.getState();
      const targetId = terminalId ?? state.focusedId;
      if (!targetId) return;
      const terminal = state.panelsById[targetId];
      if (terminal?.isInputLocked) return;
      const { terminalInstanceService } =
        await import("@/services/terminal/TerminalInstanceService");
      const managed = terminalInstanceService.get(targetId);
      if (!managed || managed.isInputLocked) return;
      try {
        const text = await navigator.clipboard.readText();
        if (!text) return;
        const { terminalClient } = await import("@/clients");
        const { formatWithBracketedPaste } = await import("@shared/utils/terminalInputProtocol");
        if (managed.terminal.modes.bracketedPasteMode) {
          terminalClient.write(targetId, formatWithBracketedPaste(text));
        } else {
          terminalClient.write(targetId, text.replace(/\r?\n/g, "\r"));
        }
        terminalInstanceService.notifyUserInput(targetId);
      } catch {
        // Clipboard API may be denied
      }
    },
  }));

  actions.set("terminal.copyLink", () => ({
    id: "terminal.copyLink",
    title: "Copy Link Address",
    description: "Copy a URL to the clipboard",
    category: "terminal",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    argsSchema: z.object({ url: z.string() }),
    run: async (args: unknown) => {
      const { url } = args as { url: string };
      await navigator.clipboard.writeText(url);
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
      const state = usePanelStore.getState();
      const targetId = terminalId ?? state.focusedId;
      if (targetId) {
        openPanelContextMenu(targetId);
      }
    },
  }));

  actions.set("terminal.stashInput", () => ({
    id: "terminal.stashInput",
    title: "Stash Input",
    description: "Park the current hybrid input draft to a temporary stash slot",
    category: "terminal",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    run: async () => {
      const { triggerStashInput } = await import("@/store/terminalInputStore");
      const state = usePanelStore.getState();
      const targetId = state.focusedId;
      if (targetId) triggerStashInput(targetId);
    },
  }));

  actions.set("terminal.popStash", () => ({
    id: "terminal.popStash",
    title: "Restore Stashed Input",
    description: "Restore the previously stashed hybrid input draft",
    category: "terminal",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    run: async () => {
      const { triggerPopStash } = await import("@/store/terminalInputStore");
      const state = usePanelStore.getState();
      const targetId = state.focusedId;
      if (targetId) triggerPopStash(targetId);
    },
  }));

  actions.set("terminal.bulkCommand", () => ({
    id: "terminal.bulkCommand",
    title: "Bulk Operations",
    description: "Send keystrokes or commands to multiple agent terminals",
    category: "terminal",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    run: async () => {
      const { openBulkCommandPalette } =
        await import("@/components/BulkCommandCenter/BulkCommandPalette");
      openBulkCommandPalette();
    },
  }));

  actions.set("terminal.sendToAgent", () => ({
    id: "terminal.sendToAgent",
    title: "Send to Agent",
    description: "Send terminal selection to another agent or terminal panel",
    category: "terminal",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    argsSchema: z.object({ terminalId: z.string().optional() }),
    run: async (args: unknown) => {
      const { terminalId } = (args ?? {}) as { terminalId?: string };
      const state = usePanelStore.getState();
      const sourceId = terminalId ?? state.focusedId;
      if (!sourceId) return;

      const terminal = state.panelsById[sourceId];
      if (!terminal) return;
      if (terminal.kind && !panelKindHasPty(terminal.kind)) return;

      const { openSendToAgentPalette } = await import("@/hooks/useSendToAgentPalette");
      openSendToAgentPalette(sourceId);
    },
  }));

  actions.set("terminal.arm", () => ({
    id: "terminal.arm",
    title: "Arm Terminal",
    description: "Add a terminal to the fleet arming set",
    category: "terminal",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    argsSchema: z.object({ terminalId: z.string() }),
    run: async (args: unknown) => {
      const { terminalId } = args as { terminalId: string };
      const terminal = usePanelStore.getState().panelsById[terminalId];
      const { useFleetArmingStore, isFleetArmEligible } = await import("@/store/fleetArmingStore");
      if (!isFleetArmEligible(terminal)) return;
      useFleetArmingStore.getState().armId(terminalId);
    },
  }));

  actions.set("terminal.disarm", () => ({
    id: "terminal.disarm",
    title: "Disarm Terminal",
    description: "Remove a terminal from the fleet arming set",
    category: "terminal",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    argsSchema: z.object({ terminalId: z.string() }),
    run: async (args: unknown) => {
      const { terminalId } = args as { terminalId: string };
      const { useFleetArmingStore } = await import("@/store/fleetArmingStore");
      useFleetArmingStore.getState().disarmId(terminalId);
    },
  }));

  actions.set("terminal.disarmAll", () => ({
    id: "terminal.disarmAll",
    title: "Disarm All",
    description: "Clear the fleet arming set",
    category: "terminal",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    run: async () => {
      const { useFleetArmingStore } = await import("@/store/fleetArmingStore");
      useFleetArmingStore.getState().clear();
    },
  }));

  actions.set("terminal.armByState", () => ({
    id: "terminal.armByState",
    title: "Arm by State",
    description: "Arm all eligible agent terminals in a given state",
    category: "terminal",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    argsSchema: z.object({
      state: z.enum(["working", "waiting", "finished"]),
      scope: z.enum(["current", "all"]).optional(),
      extend: z.boolean().optional(),
    }),
    run: async (args: unknown) => {
      const {
        state,
        scope = "current",
        extend = false,
      } = args as {
        state: "working" | "waiting" | "finished";
        scope?: "current" | "all";
        extend?: boolean;
      };
      const { useFleetArmingStore } = await import("@/store/fleetArmingStore");
      useFleetArmingStore.getState().armByState(state, scope, extend);
    },
  }));

  actions.set("terminal.armAll", () => ({
    id: "terminal.armAll",
    title: "Arm All Eligible",
    description: "Arm every eligible agent terminal",
    category: "terminal",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    argsSchema: z.object({ scope: z.enum(["current", "all"]).optional() }).optional(),
    run: async (args: unknown) => {
      const { scope = "current" } = (args ?? {}) as { scope?: "current" | "all" };
      const { useFleetArmingStore } = await import("@/store/fleetArmingStore");
      useFleetArmingStore.getState().armAll(scope);
    },
  }));

  actions.set("terminal.armDefault", () => ({
    id: "terminal.armDefault",
    title: "Arm Current Worktree",
    description: "Arm all eligible agent terminals in the active worktree",
    category: "terminal",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    run: async () => {
      const { useFleetArmingStore } = await import("@/store/fleetArmingStore");
      useFleetArmingStore.getState().armAll("current");
    },
  }));
}
