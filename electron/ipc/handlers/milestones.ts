// eager-import-allow: reads milestone state via store.get synchronously at module scope
import { store } from "../../store.js";
import { defineIpcNamespace, op } from "../define.js";
import { MILESTONES_METHOD_CHANNELS } from "./milestones.preload.js";

export const milestonesNamespace = defineIpcNamespace({
  name: "milestones",
  ops: {
    get: op(MILESTONES_METHOD_CHANNELS.get, (): Record<string, boolean> => {
      return store.get("orchestrationMilestones") ?? {};
    }),
    markShown: op(MILESTONES_METHOD_CHANNELS.markShown, (milestoneId: string): void => {
      if (typeof milestoneId !== "string") return;
      const current = store.get("orchestrationMilestones") ?? {};
      store.set("orchestrationMilestones", { ...current, [milestoneId]: true });
    }),
  },
});

export function registerMilestonesHandlers(): () => void {
  return milestonesNamespace.register();
}
