import type { ActionRegistry } from "../actionTypes";
import { actionService } from "@/services/ActionService";
import { notify } from "@/lib/notify";

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
        // No history yet (e.g. picked from the palette on a fresh session).
        // Throwing here surfaced a "Couldn't run" error toast for an empty
        // state; a quiet notice is the honest signal instead.
        // eslint-disable-next-line no-restricted-syntax -- notify-no-action: ok
        notify({
          type: "info",
          title: "Nothing to repeat",
          message: "Run an action first — there's no recent action to repeat yet.",
        });
        return;
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
