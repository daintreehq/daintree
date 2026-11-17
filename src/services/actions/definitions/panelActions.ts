import type { ActionCallbacks, ActionRegistry } from "../actionTypes";
import { registerPanelCoreActions } from "./panelCoreActions";
import { registerPortalActions } from "./portalActions";
import { registerPortalTabActions } from "./portalTabActions";

export function registerPanelActions(actions: ActionRegistry, callbacks: ActionCallbacks): void {
  registerPanelCoreActions(actions, callbacks);
  registerPortalActions(actions, callbacks);
  registerPortalTabActions(actions, callbacks);
}
