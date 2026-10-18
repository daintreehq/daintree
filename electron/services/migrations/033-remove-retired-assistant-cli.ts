import type { Migration } from "../StoreMigrations.js";

const RETIRED_AGENT_ID = "daintree-assistant";

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function withoutKey(record: Record<string, unknown>, key: string): Record<string, unknown> {
  const { [key]: _removed, ...rest } = record;
  return rest;
}

/**
 * Clear what the retired Daintree Assistant CLI left in the store (issue
 * #13502). A saved assistant choice of it becomes an explicit clear, which is
 * how the host already reads it, so the panel offers an agent and an old
 * localStorage value can't land a choice in its place. Its model entry, its
 * agent settings and the debug-logging switch only it read go too.
 */
export const migration033: Migration = {
  version: 33,
  description: "Remove the retired Daintree Assistant CLI's stored state (issue #13502)",
  up: (store) => {
    const helpAssistant = store.get("helpAssistant") as unknown;
    if (isPlainObject(helpAssistant)) {
      let next = helpAssistant;
      if (Object.hasOwn(next, "debugLogging")) next = withoutKey(next, "debugLogging");
      if (next.agentId === RETIRED_AGENT_ID) next = { ...next, agentId: null };
      if (isPlainObject(next.modelIds) && Object.hasOwn(next.modelIds, RETIRED_AGENT_ID)) {
        next = { ...next, modelIds: withoutKey(next.modelIds, RETIRED_AGENT_ID) };
      }
      if (next !== helpAssistant) store.set("helpAssistant", next as never);
    }

    const agentSettings = store.get("agentSettings") as unknown;
    if (
      isPlainObject(agentSettings) &&
      isPlainObject(agentSettings.agents) &&
      Object.hasOwn(agentSettings.agents, RETIRED_AGENT_ID)
    ) {
      store.set("agentSettings", {
        ...agentSettings,
        agents: withoutKey(agentSettings.agents, RETIRED_AGENT_ID),
      } as never);
    }
  },
};
