import { CHANNELS } from "../channels.js";
import { store } from "../../store.js";
import { typedHandle } from "../utils.js";

export function registerShortcutHintsHandlers(): () => void {
  const cleanups: Array<() => void> = [];

  cleanups.push(
    typedHandle(CHANNELS.SHORTCUT_HINTS_GET_COUNTS, () => {
      return store.get("shortcutHintCounts") ?? {};
    })
  );

  cleanups.push(
    typedHandle(CHANNELS.SHORTCUT_HINTS_INCREMENT_COUNT, (actionId: unknown) => {
      if (typeof actionId !== "string") return;
      const counts = store.get("shortcutHintCounts") ?? {};
      counts[actionId] = (counts[actionId] ?? 0) + 1;
      store.set("shortcutHintCounts", counts);
    })
  );

  return () => cleanups.forEach((c) => c());
}
