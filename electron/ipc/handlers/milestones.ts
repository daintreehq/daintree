import { CHANNELS } from "../channels.js";
import { store } from "../../store.js";
import { typedHandle } from "../utils.js";

export function registerMilestonesHandlers(): () => void {
  const cleanups: Array<() => void> = [];

  cleanups.push(
    typedHandle(CHANNELS.MILESTONES_GET, () => {
      return store.get("orchestrationMilestones") ?? {};
    })
  );

  cleanups.push(
    typedHandle(CHANNELS.MILESTONES_MARK_SHOWN, (milestoneId: unknown) => {
      if (typeof milestoneId !== "string") return;
      const current = store.get("orchestrationMilestones") ?? {};
      store.set("orchestrationMilestones", { ...current, [milestoneId]: true });
    })
  );

  return () => cleanups.forEach((c) => c());
}
