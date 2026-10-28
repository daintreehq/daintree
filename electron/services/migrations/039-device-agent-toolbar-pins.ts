import type { Migration } from "../StoreMigrations.js";

const RESERVED_KEYS = new Set(["__proto__", "constructor", "prototype"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Move each agent's toolbar pin out of the host's agent settings into this
 * machine's `agentToolbarPins` (#14702). The toolbar is the screen's, so a pin
 * no longer travels with the agent's execution settings.
 *
 * An unset pin stays unset, so the toolbar keeps falling back to its default.
 * A store below `settingsVersion` 1 never showed its pins: the renderer cleared
 * them on every load (#7673), so they don't carry over either. The destination
 * is written whole, and only when absent, so a replay never overwrites pins set
 * since; the source is stripped either way. The key exists after this on every
 * upgraded profile, which is what keeps first-run seeding to fresh installs.
 *
 * Self-contained on purpose: a migration is a snapshot of the shape it moves.
 */
export const migration039: Migration = {
  version: 39,
  description: "Move toolbar agent pins out of agent settings onto this machine (issue #14702)",
  up: (store) => {
    const agentSettings = store.get("agentSettings") as unknown;
    const settings = isRecord(agentSettings) ? agentSettings : undefined;
    const agents = settings && isRecord(settings.agents) ? settings.agents : undefined;
    const showedPins =
      typeof settings?.settingsVersion === "number" && settings.settingsVersion >= 1;

    if (store.get("agentToolbarPins") === undefined) {
      const pins: Record<string, boolean> = {};
      if (agents && showedPins) {
        for (const [id, entry] of Object.entries(agents)) {
          if (RESERVED_KEYS.has(id) || !isRecord(entry)) continue;
          if (typeof entry.pinned === "boolean") pins[id] = entry.pinned;
        }
      }
      store.set("agentToolbarPins", pins);
      console.log(`[Migration 039] Moved ${Object.keys(pins).length} toolbar agent pins`);
    }

    if (!settings || !agents) return;
    let stripped = 0;
    const nextAgents: Record<string, unknown> = {};
    for (const [id, entry] of Object.entries(agents)) {
      if (isRecord(entry) && Object.hasOwn(entry, "pinned")) {
        const { pinned: _pinned, ...rest } = entry;
        nextAgents[id] = rest;
        stripped++;
      } else {
        nextAgents[id] = entry;
      }
    }
    if (stripped === 0) return;
    store.set("agentSettings", { ...settings, agents: nextAgents } as never);
  },
};
