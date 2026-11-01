// eager-import-allow: reads the saved Decisions switch via store.get so an off status is answered without importing any of Decisions
import { CHANNELS } from "../channels.js";
import { defineIpcNamespace, op } from "../define.js";
import { store } from "../../store.js";
import { loadDecisionsModule } from "../../window/serviceRefs.js";
import type { DecisionsStatus } from "../../../shared/types/decisions.js";

/**
 * Decisions' only module on the startup path, and it imports nothing that
 * isn't there already (the channel name comes from `CHANNELS` rather than the
 * preload constants for that reason). With the switch off, a status read
 * answers from the store; Decisions itself loads only once it is on.
 */
export const decisionsNamespace = defineIpcNamespace({
  name: "decisions",
  ops: {
    getStatus: op(CHANNELS.DECISIONS_GET_STATUS, async (): Promise<DecisionsStatus> => {
      if (store.get("decisions")?.enabled !== true) return { state: "off" };
      const decisions = await loadDecisionsModule(
        () => import("../../services/decisions/index.js")
      );
      // Null only once quit has begun, when nothing of Decisions runs.
      return decisions ? decisions.getDecisionsStatus() : { state: "off" };
    }),
  },
});

export function registerDecisionsHandlers(): () => void {
  return decisionsNamespace.register();
}
