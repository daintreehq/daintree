import type { ActionCallbacks, ActionRegistry } from "../actionTypes";
import { registerPanelCoreActions } from "./panelCoreActions";

export function registerPanelActions(actions: ActionRegistry, callbacks: ActionCallbacks): void {
  registerPanelCoreActions(actions, callbacks);
}
