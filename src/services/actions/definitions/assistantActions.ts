import type { ActionCallbacks, ActionRegistry } from "../actionTypes";
import { useTerminalStore } from "@/store/terminalStore";
import { useWorktreeSelectionStore } from "@/store/worktreeStore";

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
}
