import { store } from "../../store.js";
import { defineIpcNamespace, op } from "../define.js";
import { SHORTCUT_HINTS_METHOD_CHANNELS } from "./shortcutHints.preload.js";

export const shortcutHintsNamespace = defineIpcNamespace({
  name: "shortcutHints",
  ops: {
    getCounts: op(SHORTCUT_HINTS_METHOD_CHANNELS.getCounts, (): Record<string, number> => {
      return store.get("shortcutHintCounts") ?? {};
    }),
    incrementCount: op(
      SHORTCUT_HINTS_METHOD_CHANNELS.incrementCount,
      (actionId: string): void => {
        if (typeof actionId !== "string") return;
        const counts = store.get("shortcutHintCounts") ?? {};
        counts[actionId] = (counts[actionId] ?? 0) + 1;
        store.set("shortcutHintCounts", counts);
      }
    ),
  },
});

export function registerShortcutHintsHandlers(): () => void {
  return shortcutHintsNamespace.register();
}
