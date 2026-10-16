import { agentCapabilitiesClient } from "@/clients/agentCapabilitiesClient";
import { getSavedAssistantModelId, resolveAssistantModelId } from "@shared/config/agentRegistry";
import type { ResolvedModelCatalog } from "@shared/types/ipc/agentCapabilities";
import { followModelUpgrades, publishesModelUpgrades } from "@shared/utils/modelUpgrades";
import { logError } from "@/utils/logger";

async function loadCatalog(agentId: string): Promise<ResolvedModelCatalog | null> {
  try {
    return await agentCapabilitiesClient.getResolvedModelList(agentId);
  } catch {
    return null;
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
    // Only this agent's own entry — a model saved for another agent must never
    // reach this launch.
    const saved = getSavedAssistantModelId(settings.modelIds, agentId);
    // The catalog is read for an unsaved model's recommendation, or to move a
    // saved one onto its successor. An explicit CLI default ("") and a saved
    // model no upgrade can reach launch without waiting on it.
    const needsCatalog = saved === null || (saved !== "" && publishesModelUpgrades(agentId));
    const catalog = needsCatalog ? await loadCatalog(agentId) : null;
    const flags: string[] = [];
    const chosen = resolveAssistantModelId(
      agentId,
      saved,
      catalog?.models.map((m) => m.id)
    ).trim();
    // A saved model the CLI has since pointed at a successor launches as that
    // successor; the stored choice is left as the user wrote it. Without a
    // catalog it passes through unchanged.
    const modelId = chosen ? followModelUpgrades(chosen, catalog?.modelUpgrades) : "";
    if (modelId) flags.push("--model", modelId);
    const raw = settings.customArgs?.trim();
    if (raw) flags.push(...raw.split(/\s+/).filter(Boolean));
    return flags;
  } catch (err) {
    logError("Failed to load helpAssistant launch flags", err);
    return [];
  }
}
