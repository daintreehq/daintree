import type { Migration } from "../StoreMigrations.js";

interface StoredAgentEntry {
  pinned?: boolean;
  [key: string]: unknown;
}

interface StoredAgentSettings {
  agents?: Record<string, StoredAgentEntry>;
  [key: string]: unknown;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Phantom predicate: an entry is considered phantom IFF it has exactly one
 * key (`pinned`) and its value is `true`. These entries were synthesized by
 * the v0.7.0 normalizer and migration 012 for every registered agent —
 * including ones the user never installed — so they carry no real intent.
 *
 * Entries with `pinned: false` (explicit unpin) or any other field alongside
 * `pinned: true` (e.g. `customFlags`, `primaryModelId`, `dangerousEnabled`)
 * represent real user configuration and must be preserved untouched. A narrow
 * false-positive exists: a v0.7.0 user who unpinned an agent then re-pinned
 * it produces a bare `{ pinned: true }` via the IPC merge path. Migration
 * 013 strips that entry, but the renderer normalizer re-synthesizes
 * `pinned: true` on the next init for installed agents — so the user-visible
 * outcome matches intent. The narrow loss case (user pinned an uninstalled
 * agent they planned to install later) is acceptable given the one-shot
 * upgrade window.
 */
function isPhantomPinEntry(entry: unknown): boolean {
  if (!isPlainObject(entry)) return false;
  const keys = Object.keys(entry);
  return keys.length === 1 && keys[0] === "pinned" && entry.pinned === true;
}

export const migration013: Migration = {
  version: 13,
  description: "Clean up phantom pinned entries for uninstalled agents (issue #5158)",
  up: (store) => {
    const agentSettings = store.get("agentSettings") as unknown;
    if (!isPlainObject(agentSettings)) return;
    const rawAgents = (agentSettings as StoredAgentSettings).agents;
    if (!isPlainObject(rawAgents)) return;

    const kept: Record<string, StoredAgentEntry> = {};
    let changed = false;

    for (const [id, entry] of Object.entries(rawAgents)) {
      if (isPhantomPinEntry(entry)) {
        changed = true;
        continue;
      }
      // Non-phantom and non-object entries (e.g. a corrupted `null`) pass
      // through untouched — cleaning up truly malformed data is out of scope
      // for this migration.
      kept[id] = entry as StoredAgentEntry;
    }

    if (!changed) return;

    // electron-store v11 throws on `store.set(key, undefined)` — rebuild the
    // whole `agentSettings` object and write it back in one call (matches
    // migration 012's pattern and avoids the v11 delete foot-gun).
    store.set("agentSettings", { ...(agentSettings as StoredAgentSettings), agents: kept });
  },
};
