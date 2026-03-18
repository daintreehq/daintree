import { ipcMain } from "electron";
import { CHANNELS } from "../channels.js";
import { store } from "../../store.js";

export function registerShortcutHintsHandlers(): () => void {
  const cleanups: Array<() => void> = [];

  ipcMain.handle(CHANNELS.SHORTCUT_HINTS_GET_COUNTS, () => {
    return store.get("shortcutHintCounts") ?? {};
  });
  cleanups.push(() => ipcMain.removeHandler(CHANNELS.SHORTCUT_HINTS_GET_COUNTS));

  ipcMain.handle(CHANNELS.SHORTCUT_HINTS_INCREMENT_COUNT, (_event, actionId: unknown) => {
    if (typeof actionId !== "string") return;
    const counts = store.get("shortcutHintCounts") ?? {};
    counts[actionId] = (counts[actionId] ?? 0) + 1;
    store.set("shortcutHintCounts", counts);
  });
  cleanups.push(() => ipcMain.removeHandler(CHANNELS.SHORTCUT_HINTS_INCREMENT_COUNT));

  return () => cleanups.forEach((c) => c());
}
