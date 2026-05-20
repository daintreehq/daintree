import { CHANNELS } from "../channels.js";
import { defineIpcNamespace, op } from "../define.js";
import { store } from "../../store.js";

function handleGetCounts(): Record<string, number> {
  return store.get("shortcutHintCounts") ?? {};
}

function handleIncrementCount(actionId: string): void {
  if (typeof actionId !== "string") return;
  const counts = store.get("shortcutHintCounts") ?? {};
  counts[actionId] = (counts[actionId] ?? 0) + 1;
  store.set("shortcutHintCounts", counts);
}

export const shortcutHintsNamespace = defineIpcNamespace({
  name: "shortcut-hints",
  ops: {
    getCounts: op(CHANNELS.SHORTCUT_HINTS_GET_COUNTS, handleGetCounts),
    incrementCount: op(CHANNELS.SHORTCUT_HINTS_INCREMENT_COUNT, handleIncrementCount),
  },
});

export function registerShortcutHintsHandlers(): () => void {
  return shortcutHintsNamespace.register();
}
