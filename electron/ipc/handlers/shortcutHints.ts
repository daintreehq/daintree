// eager-import-allow: reads shortcut-hint state via store.get synchronously at module scope
import { store } from "../../store.js";
import { defineIpcNamespace, op } from "../define.js";
import { SHORTCUT_HINTS_METHOD_CHANNELS } from "./shortcutHints.preload.js";

export const shortcutHintsNamespace = defineIpcNamespace({
  name: "shortcutHints",
  ops: {
    getCounts: op(SHORTCUT_HINTS_METHOD_CHANNELS.getCounts, (): Record<string, number> => {
      return store.get("shortcutHintCounts") ?? {};
    }),
    incrementCount: op(SHORTCUT_HINTS_METHOD_CHANNELS.incrementCount, (actionId: string): void => {
      if (typeof actionId !== "string") return;
      const counts = store.get("shortcutHintCounts") ?? {};
      counts[actionId] = (counts[actionId] ?? 0) + 1;
      store.set("shortcutHintCounts", counts);
    }),
    getHintedHover: op(SHORTCUT_HINTS_METHOD_CHANNELS.getHintedHover, (): string[] => {
      return store.get("shortcutHintHoveredKeys") ?? [];
    }),
    setHintedHover: op(SHORTCUT_HINTS_METHOD_CHANNELS.setHintedHover, (keys: string[]): void => {
      if (!Array.isArray(keys)) return;
      store.set(
        "shortcutHintHoveredKeys",
        keys.filter((key): key is string => typeof key === "string")
      );
    }),
  },
});

export function registerShortcutHintsHandlers(): () => void {
  return shortcutHintsNamespace.register();
}
