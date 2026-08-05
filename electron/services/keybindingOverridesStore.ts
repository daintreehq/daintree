// eager-import-allow: reads persisted keybindings via store.get synchronously at module scope
import { store } from "../store.js";

/**
 * Actions whose default binding moved to a successor action, mapped old → new.
 *
 * An override is keyed by action id, and only ids carrying a binding row are
 * resolvable — so moving a default binding to a new action silently orphans
 * every override the user recorded against the old one: their custom combo
 * stops firing, and a deliberate unbind (`[]`) lets the new default back in.
 * Read-time aliasing rather than a store rewrite: it is idempotent, needs no
 * migration ordering, and leaves the original entry untouched for a rollback.
 *
 * The new id always wins, so a user who has since rebound the successor is
 * never dragged back to their old choice.
 */
const RENAMED_BINDING_ACTIONS: Record<string, string> = {
  // #11666 — Cmd+Alt+F now opens the persistent panel; the dialog action it
  // used to point at is still registered, but no longer carries a binding.
  "worktree.openFileBrowser": "worktree.openFileBrowserPanel",
};

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
  // After validation, so a malformed legacy entry is dropped rather than
  // carried onto the successor id.
  for (const [oldId, newId] of Object.entries(RENAMED_BINDING_ACTIONS)) {
    const inherited = validated[oldId];
    if (inherited !== undefined && validated[newId] === undefined) {
      validated[newId] = inherited;
    }
  }
  return validated;
}
