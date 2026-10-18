import { agentCapabilitiesClient } from "@/clients/agentCapabilitiesClient";
import type { ResolvedModelCatalog } from "@shared/types/ipc/agentCapabilities";
import {
  assistantLaunchFlags,
  assistantModelNeedsCatalog,
} from "@shared/utils/assistantLaunchFlags";
import { logError } from "@/utils/logger";

async function loadCatalog(agentId: string): Promise<ResolvedModelCatalog | null> {
  try {
    return await agentCapabilitiesClient.getResolvedModelList(agentId);
  } catch {
    return null;
  }
}

/** The assistant's `--model` and custom-args flags for a launch of `agentId`. */
export async function loadCustomLaunchFlags(agentId: string): Promise<string[]> {
  try {
    const settings = await window.electron.helpAssistant.getSettings();
    const catalog = assistantModelNeedsCatalog(agentId, settings)
      ? await loadCatalog(agentId)
      : null;
    return assistantLaunchFlags(agentId, settings, catalog);
  } catch (err) {
    logError("Failed to load helpAssistant launch flags", err);
    return [];
  }
}
