import type { ActionCallbacks, ActionRegistry } from "../actionTypes";
import { z } from "zod";
import { useTerminalStore } from "@/store/terminalStore";
import { useWorktreeSelectionStore } from "@/store/worktreeStore";
import { useAssistantChatStore } from "@/store/assistantChatStore";

export function registerAssistantActions(
  actions: ActionRegistry,
  _callbacks: ActionCallbacks
): void {
  actions.set("assistant.open", () => ({
    id: "assistant.open",
    title: "Open Assistant",
    description: "Open or focus the Canopy Assistant panel",
    category: "assistant",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    run: async () => {
      const activeWorktreeId = useWorktreeSelectionStore.getState().activeWorktreeId;
      await useTerminalStore.getState().addTerminal({
        kind: "assistant",
        title: "Assistant",
        location: "grid",
        cwd: "",
        worktreeId: activeWorktreeId ?? undefined,
      });
    },
  }));

  actions.set("assistant.restart", () => ({
    id: "assistant.restart",
    title: "Restart Assistant",
    description: "Clear conversation and start a new session",
    category: "assistant",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    argsSchema: z.object({ panelId: z.string().optional() }).optional(),
    run: async (args: unknown) => {
      const { panelId } = (args as { panelId?: string } | undefined) ?? {};
      const chatStore = useAssistantChatStore.getState();
      const terminalStore = useTerminalStore.getState();
      const targetId = panelId ?? terminalStore.focusedId;

      if (targetId) {
        chatStore.clearConversation(targetId);
      }
    },
  }));
}
