import { getSavedAssistantModelId, resolveAssistantModelId } from "../config/agentRegistry.js";
import type { ResolvedModelCatalog } from "../types/ipc/agentCapabilities.js";
import { followModelUpgrades, publishesModelUpgrades } from "./modelUpgrades.js";

/** The assistant settings a launch's flags are read from. */
export interface AssistantLaunchSettings {
  modelIds?: Readonly<Record<string, string | null>>;
  customArgs?: string;
}

/**
 * Whether choosing the assistant's model for `agentId` needs that agent's
 * model catalog: an unsaved model takes its recommendation, and a saved one
 * an upgrade can reach moves to its successor. An explicit CLI default ("")
 * and a saved model no upgrade can reach launch without waiting on it.
 */
export function assistantModelNeedsCatalog(
  agentId: string,
  settings: AssistantLaunchSettings
): boolean {
  // Only this agent's own entry — a model saved for another agent must never
  // reach this launch.
  const saved = getSavedAssistantModelId(settings.modelIds, agentId);
  return saved === null || (saved !== "" && publishesModelUpgrades(agentId));
}

/**
 * The assistant's `--model` and custom-args flags for a launch of `agentId`,
 * wherever it starts: a view's launch and a host's own with no view (#13511).
 * The model goes first so a `--model` typed into custom args still wins (CLIs
 * are last-flag-wins on repeated `--model`), keeping custom args the advanced
 * override.
 */
export function assistantLaunchFlags(
  agentId: string,
  settings: AssistantLaunchSettings,
  catalog: Pick<ResolvedModelCatalog, "models" | "modelUpgrades"> | null
): string[] {
  const saved = getSavedAssistantModelId(settings.modelIds, agentId);
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
}
