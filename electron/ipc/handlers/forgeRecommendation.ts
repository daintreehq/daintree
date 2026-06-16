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
        store.set("forgeEnableDismissedPaths", { ...current, [projectPath]: true });
      }
    ),
  },
});

export function registerForgeRecommendationHandlers(): () => void {
  return forgeRecommendationNamespace.register();
}
