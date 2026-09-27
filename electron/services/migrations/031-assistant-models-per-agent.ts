import type { Migration } from "../StoreMigrations.js";
import { BUILT_IN_AGENT_IDS } from "../../../shared/config/agentIds.js";
import { getAgentConfig } from "../../../shared/config/agentRegistry.js";
import { sanitizeModelId, sanitizeModelIdMap } from "../../utils/helpAssistantModels.js";

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

// Only built-ins that can back the assistant at all could have been the
// assistant's agent — Aider lists "sonnet" too, but never runs the assistant.
function soleCatalogOwner(modelId: string): string | undefined {
  const owners = BUILT_IN_AGENT_IDS.filter((id) => {
    const config = getAgentConfig(id);
    return !!config?.supports && config.models?.some((m) => m.id === modelId);
  });
  return owners.length === 1 ? owners[0] : undefined;
}

/**
 * Key the assistant's model by agent (issue #12872). The legacy scalar
 * `modelId` never recorded which agent it was chosen for, so it leaked into
 * other agents' launches. It moves onto the one assistant-capable built-in
 * agent whose catalog lists it; a model several such catalogs list, a custom ID no catalog lists, and
 * an explicit CLI-default "" can't be attributed and are dropped, which reads
 * as each agent's recommended model. Attribution is best-effort — a live
 * catalog may have offered the model to a different agent — but it only ever
 * lands on an agent whose own catalog lists that model, so it can't produce a
 * launch that agent can't serve. An existing `modelIds` map is
 * authoritative, so a replay never resurrects a choice the user has since
 * reset.
 */
export const migration031: Migration = {
  version: 31,
  description: "Store the assistant's model per agent (issue #12872)",
  up: (store) => {
    const helpAssistant = store.get("helpAssistant") as unknown;
    if (!isPlainObject(helpAssistant) || !("modelId" in helpAssistant)) return;

    const { modelId: legacy, ...rest } = helpAssistant;
    let modelIds = sanitizeModelIdMap(rest.modelIds);
    if (modelIds === undefined) {
      modelIds = {};
      const sanitized = sanitizeModelId(legacy);
      const owner = sanitized ? soleCatalogOwner(sanitized) : undefined;
      if (owner && sanitized) modelIds[owner] = sanitized;
    }

    store.set("helpAssistant", { ...rest, modelIds } as never);
  },
};
