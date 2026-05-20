import { CHANNELS } from "../channels.js";
import { defineIpcNamespace, op } from "../define.js";
import { store } from "../../store.js";

function handleGet(): Record<string, boolean> {
  return store.get("orchestrationMilestones") ?? {};
}

function handleMarkShown(milestoneId: string): void {
  if (typeof milestoneId !== "string") return;
  const current = store.get("orchestrationMilestones") ?? {};
  store.set("orchestrationMilestones", { ...current, [milestoneId]: true });
}

export const milestonesNamespace = defineIpcNamespace({
  name: "milestones",
  ops: {
    get: op(CHANNELS.MILESTONES_GET, handleGet),
    markShown: op(CHANNELS.MILESTONES_MARK_SHOWN, handleMarkShown),
  },
});

export function registerMilestonesHandlers(): () => void {
  return milestonesNamespace.register();
}
