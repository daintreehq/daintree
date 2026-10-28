import { useEffect, useMemo, useState } from "react";
import { logError } from "@/utils/logger";
import { agentCapabilitiesClient } from "@/clients/agentCapabilitiesClient";
import { followModelUpgrades } from "@shared/utils/modelUpgrades";
import {
  getSavedAssistantModelId,
  resolveAssistantModelId,
  type AgentModelConfig,
} from "@shared/config/agentRegistry";
import type { HelpAssistantSettings } from "@shared/types";

// Radix Select rejects an empty-string item value, so the "use the CLI default"
// choice carries a sentinel in the dropdown and maps back to "" on persist.
export const MODEL_DEFAULT_SENTINEL = "__default__";

export function useAssistantModelCatalog(
  preferredAgentId: string | null,
  modelIds: HelpAssistantSettings["modelIds"]
) {
  // Resolved model catalog for the currently-preferred agent. `null` means "not
  // loaded / unavailable" (we render nothing); an empty array means "agent has
  // no models", which shows the row only to keep a saved choice and its reset.
  // Otherwise the picker appears once a non-empty catalog resolves for the
  // selected agent. A failed read is not "this agent
  // has no models": the row stays, with Retry. Tagged with the agent it was
  // read for, so a switch never shows the previous agent's models, saved choice
  // or failure for a render.
  const [modelCatalog, setModelCatalog] = useState<{
    agentId: string;
    models: AgentModelConfig[];
    modelUpgrades?: Record<string, string>;
    failed: boolean;
  } | null>(null);
  const currentCatalog = modelCatalog?.agentId === preferredAgentId ? modelCatalog : null;
  const resolvedModels = currentCatalog?.models ?? null;
  const modelCatalogFailed = currentCatalog?.failed ?? false;
  const [modelCatalogAttempt, setModelCatalogAttempt] = useState(0);

  useEffect(() => {
    if (!preferredAgentId) {
      setModelCatalog(null);
      return;
    }
    const agentId = preferredAgentId;
    let cancelled = false;
    setModelCatalog(null);
    agentCapabilitiesClient
      .getResolvedModelList(preferredAgentId)
      .then((catalog) => {
        if (cancelled) return;
        setModelCatalog({
          agentId,
          models: catalog?.models ?? [],
          modelUpgrades: catalog?.modelUpgrades,
          failed: false,
        });
      })
      .catch((err) => {
        if (cancelled) return;
        setModelCatalog({ agentId, models: [], failed: true });
        logError("Failed to load model catalog for assistant tab", err);
      });
    return () => {
      cancelled = true;
    };
  }, [preferredAgentId, modelCatalogAttempt]);

  // Nothing saved means the CLI's own default model, matching what the launch
  // path resolves.
  // Only the selected agent's own entry — another agent's model never shows as
  // selected here.
  const savedModelId = preferredAgentId
    ? getSavedAssistantModelId(modelIds, preferredAgentId)
    : null;
  const catalogIds = useMemo(() => resolvedModels?.map((m) => m.id), [resolvedModels]);
  // A saved model the CLI has retired shows as the successor it launches as,
  // matching the launch path; the stored choice is untouched until the user
  // picks again.
  const effectiveModelId = followModelUpgrades(
    preferredAgentId
      ? resolveAssistantModelId(preferredAgentId, savedModelId, catalogIds)
      : (savedModelId ?? ""),
    currentCatalog?.modelUpgrades
  );

  const modelOptions = useMemo(() => {
    const models = resolvedModels ?? [];
    const options = [
      { value: MODEL_DEFAULT_SENTINEL, label: "Default (CLI default)" },
      ...models.map((m) => ({ value: m.id, label: m.name })),
    ];
    // This agent's persisted model that isn't in its catalog (custom CLI,
    // renamed model), or the recommendation while the catalog read has failed,
    // still needs a matching option or Radix shows a blank trigger.
    if (effectiveModelId && !models.some((m) => m.id === effectiveModelId)) {
      options.push({ value: effectiveModelId, label: effectiveModelId });
    }
    return options;
  }, [resolvedModels, effectiveModelId]);

  const modelSelectValue = effectiveModelId || MODEL_DEFAULT_SENTINEL;
  // A saved choice keeps the row after an empty catalog (Codex without its CLI's
  // model list), or the only way to clear it would disappear.
  const showModelPicker =
    Boolean(resolvedModels && resolvedModels.length > 0) ||
    (modelCatalogFailed && Boolean(preferredAgentId)) ||
    (resolvedModels !== null && savedModelId !== null);

  return {
    modelCatalogFailed,
    retryModelCatalog: () => setModelCatalogAttempt((n) => n + 1),
    savedModelId,
    catalogIds,
    modelOptions,
    modelSelectValue,
    showModelPicker,
  };
}
