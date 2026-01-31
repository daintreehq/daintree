import type { ActionCallbacks, ActionRegistry } from "../actionTypes";
import { useAssistantChatStore } from "@/store/assistantChatStore";

export function registerAssistantActions(
  actions: ActionRegistry,
  _callbacks: ActionCallbacks
): void {
  actions.set("assistant.open", () => ({
    id: "assistant.open",
    title: "Toggle Assistant",
    description: "Open or close the Canopy Assistant",
    category: "assistant",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    run: async () => {
      useAssistantChatStore.getState().toggle();
    },
  }));
}
