import type { Migration } from "../StoreMigrations.js";

interface AgentEntry {
  flavorId?: unknown;
  customFlavors?: unknown;
  [key: string]: unknown;
}

interface AgentSettingsLike {
  agents?: Record<string, AgentEntry>;
  [key: string]: unknown;
}

export const migration016: Migration = {
  version: 16,
  description:
    "Rename agent-settings flavorId → presetId and customFlavors → customPresets (issue #5459)",
  up: (store) => {
    const raw = store.get("agentSettings") as AgentSettingsLike | undefined;
    if (!raw || typeof raw !== "object" || !raw.agents || typeof raw.agents !== "object") {
      return;
    }

    const migratedAgents: Record<string, Record<string, unknown>> = {};
    for (const [id, entry] of Object.entries(raw.agents)) {
      if (!entry || typeof entry !== "object") {
        migratedAgents[id] = entry as Record<string, unknown>;
        continue;
      }
      const { flavorId, customFlavors, ...rest } = entry;
      const next: Record<string, unknown> = { ...rest };
      // Defense in depth: if an entry somehow already has the new key
      // (hand-edited storage, partial migration), keep it and drop the legacy one.
      if (flavorId !== undefined && next.presetId === undefined) next.presetId = flavorId;
      if (customFlavors !== undefined && next.customPresets === undefined) {
        next.customPresets = customFlavors;
      }
      migratedAgents[id] = next;
    }

    store.set("agentSettings", { ...raw, agents: migratedAgents } as never);
  },
};
