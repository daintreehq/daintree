import type { ActionRegistry } from "../actionTypes";
import { actionService } from "@/services/ActionService";

export function registerActionActions(actions: ActionRegistry): void {
  actions.set("action.repeatLast", () => ({
    id: "action.repeatLast",
    title: "Repeat Last Action",
    description: "Re-dispatch the last user/menu/keybinding action with fresh context",
    category: "app",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    // Read fresh on every invocation — closing over lastAction at registration
    // time would always capture null.
    nonRepeatable: true,
    run: async () => {
      const last = actionService.getLastAction();
      if (!last) {
        throw new Error("No action to repeat");
      }
      const result = await actionService.dispatch(last.actionId, last.args, {
        source: "keybinding",
      });
      if (!result.ok) {
        throw new Error(result.error.message);
      }
      return result.result;
    },
  }));
}
