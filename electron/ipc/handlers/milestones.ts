import { ipcMain } from "electron";
import { CHANNELS } from "../channels.js";
import { store } from "../../store.js";

export function registerMilestonesHandlers(): () => void {
  const cleanups: Array<() => void> = [];

  ipcMain.handle(CHANNELS.MILESTONES_GET, () => {
    return store.get("orchestrationMilestones") ?? {};
  });
  cleanups.push(() => ipcMain.removeHandler(CHANNELS.MILESTONES_GET));

  ipcMain.handle(CHANNELS.MILESTONES_MARK_SHOWN, (_event, milestoneId: unknown) => {
    if (typeof milestoneId !== "string") return;
    const current = store.get("orchestrationMilestones") ?? {};
    store.set("orchestrationMilestones", { ...current, [milestoneId]: true });
  });
  cleanups.push(() => ipcMain.removeHandler(CHANNELS.MILESTONES_MARK_SHOWN));

  return () => cleanups.forEach((c) => c());
}
