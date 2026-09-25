import { agentCapabilitiesClient } from "@/clients/agentCapabilitiesClient";
import { resolveAssistantModelId } from "@shared/config/agentRegistry";
import { logError } from "@/utils/logger";

async function loadCatalogIds(agentId: string): Promise<string[] | undefined> {
  try {
    const catalog = await agentCapabilitiesClient.getResolvedModelList(agentId);
    return catalog?.models.map((m) => m.id);
  } catch {
    return undefined;
  }
}

/**
 * The assistant's `--model` and custom-args flags for a launch of `agentId`.
 * The model goes first so a `--model` typed into custom args still wins (CLIs
 * are last-flag-wins on repeated `--model`), keeping custom args the advanced
 * override.
 */
export async function loadCustomLaunchFlags(agentId: string): Promise<string[]> {
  try {
    const settings = await window.electron.helpAssistant.getSettings();
    const saved = settings.modelId ?? null;
    const availableIds = saved === null ? await loadCatalogIds(agentId) : undefined;
    const flags: string[] = [];
    const modelId = resolveAssistantModelId(agentId, saved, availableIds).trim();
    if (modelId) flags.push("--model", modelId);
    const raw = settings.customArgs?.trim();
    if (raw) flags.push(...raw.split(/\s+/).filter(Boolean));
    return flags;
  } catch (err) {
    logError("Failed to load helpAssistant launch flags", err);
    return [];
  }
}
