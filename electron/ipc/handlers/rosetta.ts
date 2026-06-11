import { defineIpcNamespace, op } from "../define.js";
import { CHANNELS } from "../channels.js";
import { store } from "../../store.js";

/**
 * Persists the permanent dismissal of the Rosetta translation warning banner.
 * Machine-level and one-way: the installed binary's architecture never changes
 * via auto-update, so there is no corresponding "undismiss" op.
 */
export const rosettaNamespace = defineIpcNamespace({
  name: "rosetta",
  ops: {
    dismissRosettaWarning: op(CHANNELS.APP_DISMISS_ROSETTA_WARNING, async (): Promise<void> => {
      store.set("rosettaWarningDismissed", true);
    }),
  },
});

export function registerRosettaHandlers(): () => void {
  return rosettaNamespace.register();
}
