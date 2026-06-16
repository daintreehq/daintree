// eager-import-allow: reads forge-recommendation state via store.get synchronously at module scope
import { store } from "../../store.js";
import { defineIpcNamespace, op } from "../define.js";
import { FORGE_RECOMMENDATION_METHOD_CHANNELS } from "./forgeRecommendation.preload.js";

export const forgeRecommendationNamespace = defineIpcNamespace({
  name: "forgeRecommendation",
  ops: {
    getDismissed: op(
      FORGE_RECOMMENDATION_METHOD_CHANNELS.getDismissed,
      (): Record<string, true> => {
        return store.get("forgeEnableDismissedPaths") ?? {};
      }
    ),
    markDismissed: op(
      FORGE_RECOMMENDATION_METHOD_CHANNELS.markDismissed,
      (projectPath: string): void => {
        if (typeof projectPath !== "string" || projectPath.length === 0) return;
        const current = store.get("forgeEnableDismissedPaths") ?? {};
        // Defend against a field-level corrupt value (e.g. an array or string)
        // that survived the store's JSON parse — spreading it would otherwise
        // produce character-indexed garbage.
        const base = typeof current === "object" && !Array.isArray(current) ? current : {};
        store.set("forgeEnableDismissedPaths", { ...base, [projectPath]: true });
      }
    ),
  },
});

export function registerForgeRecommendationHandlers(): () => void {
  return forgeRecommendationNamespace.register();
}
