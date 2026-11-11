import { getEffectiveAgentConfig, type AgentModelConfig } from "../config/agentRegistry.js";
import type { ResolvedModelCatalog } from "../types/ipc/agentCapabilities.js";

/** Reads an agent's runtime model catalog, as `agentCapabilities.getResolvedModelList` answers. */
export type AgentModelCatalogReader = (
  agentId: string
) => Promise<Pick<ResolvedModelCatalog, "models"> | null | undefined>;

/**
 * How long a title waits on the catalog. A cold one can wait on the CLI or the
 * network, and a title isn't worth holding a launch for: past this the pane
 * takes the bare agent name, as it does for a model nothing lists.
 */
export const MODEL_TITLE_CATALOG_WAIT_MS = 3_000;

/**
 * The runtime models a title for `modelId` can be read from (#16783), or
 * `undefined` when there is nothing to read: no model, an id the agent's
 * bundled list already names, or a catalog that failed or didn't answer in
 * time. Never rejects.
 */
export async function loadModelTitleCatalog(
  agentId: string,
  modelId: string | undefined,
  readCatalog: AgentModelCatalogReader | undefined
): Promise<readonly AgentModelConfig[] | undefined> {
  if (!modelId || !readCatalog) return undefined;
  if (getEffectiveAgentConfig(agentId)?.models?.some((m) => m.id === modelId)) return undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<undefined>((resolve) => {
    timer = setTimeout(resolve, MODEL_TITLE_CATALOG_WAIT_MS, undefined);
  });
  const lookup = (async () => (await readCatalog(agentId))?.models)().catch(() => undefined);
  try {
    return await Promise.race([lookup, deadline]);
  } finally {
    clearTimeout(timer);
  }
}
