// eager-import-allow: reads persisted keybindings via store.get synchronously at module scope
import { store } from "../store.js";

export function getValidatedOverrides(): Record<string, string[]> {
  const raw = store.get("keybindingOverrides.overrides");
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return {};
  }
  const validated: Record<string, string[]> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (Array.isArray(value) && value.every((c) => typeof c === "string" && c.trim() !== "")) {
      validated[key] = value;
    } else {
      // Surface malformed persisted entries so a hand-edited or corrupt store
      // doesn't silently swallow a user's rebinds. typeof keeps the log small
      // even if the raw value is large.
      console.warn(
        `[keybinding] Dropping malformed override "${key}": expected non-empty string[], got ${typeof value}`
      );
    }
  }
  return validated;
}
