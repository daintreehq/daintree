import type { ActionCallbacks, ActionRegistry } from "../actionTypes";
import { useTerminalStore } from "@/store/terminalStore";

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
      const store = useTerminalStore.getState();
      const terminals = store.terminals;

      // Look for an existing assistant panel (excluding trashed ones)
      const existingAssistant = terminals.find(
        (t) => t.kind === "assistant" && t.location !== "trash"
      );

      if (existingAssistant) {
        // Activate the existing assistant panel (handles both grid and dock)
        store.activateTerminal(existingAssistant.id);
      } else {
        // Create a new assistant panel (addTerminal auto-focuses grid panels)
        await store.addTerminal({
          kind: "assistant",
          title: "Assistant",
          location: "grid",
          cwd: "",
        });
      }
    },
  }));
}
