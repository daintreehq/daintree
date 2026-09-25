/**
 * The model providers the Daintree Assistant can run on with the user's own key.
 *
 * The assistant's backend does runbook selection, prompt assembly and tools itself and
 * then makes the model calls on whichever provider the user picked here, with the key
 * they saved for it. Every provider takes a single API key; the model is free text so a
 * user can run anything their provider serves, and an empty model means the
 * recommendation below.
 *
 * Kept in step with the backend's `providers/upstream.py` and the engine's
 * `internal/backend/upstream.go` — an id added here and not there is refused at the
 * engine's startup.
 */
export const ASSISTANT_MODEL_PROVIDER_IDS = ["openai", "baseten", "openrouter"] as const;

export type AssistantModelProviderId = (typeof ASSISTANT_MODEL_PROVIDER_IDS)[number];

export interface AssistantModelProvider {
  id: AssistantModelProviderId;
  label: string;
  /** Sent when the user leaves the model blank. */
  recommendedModel: string;
  /** One line under the choice: why you would pick it. */
  description: string;
  /** Where the user creates a key. */
  keyUrl: string;
  /** Example of what a key looks like, for the input's placeholder. */
  keyPlaceholder: string;
}

export const ASSISTANT_MODEL_PROVIDERS: Readonly<
  Record<AssistantModelProviderId, AssistantModelProvider>
> = {
  baseten: {
    id: "baseten",
    label: "Baseten",
    recommendedModel: "zai-org/GLM-5.3-Flash",
    description: "GLM-5.3 Flash on Baseten — the fastest way to run the assistant.",
    keyUrl: "https://app.baseten.co/settings/api_keys",
    keyPlaceholder: "Baseten API key",
  },
  openrouter: {
    id: "openrouter",
    label: "OpenRouter",
    recommendedModel: "z-ai/glm-5.3-flash",
    description:
      "One key for hundreds of models, with control over cost, speed and how your prompts are handled.",
    keyUrl: "https://openrouter.ai/settings/keys",
    keyPlaceholder: "sk-or-…",
  },
  openai: {
    id: "openai",
    label: "OpenAI",
    recommendedModel: "gpt-6-luna",
    description:
      "Recommended. GPT-6 Luna is fast, reliable and handles the assistant's tools well.",
    keyUrl: "https://platform.openai.com/api-keys",
    keyPlaceholder: "sk-…",
  },
};

/** The provider a new install starts on, and the one Settings recommends. */
export const DEFAULT_ASSISTANT_MODEL_PROVIDER: AssistantModelProviderId = "openai";

/**
 * OpenRouter's own endpoint-routing preferences — it serves each model from many
 * hosts, so these decide which ones. Only OpenRouter has them; the other providers
 * serve a model from one place.
 */
export interface OpenRouterRoutingPreferences {
  /** Rank the hosts serving the model by speed or by price. */
  sort: "latency" | "price";
  /** Allow hosts that may collect or train on prompts. Off means OpenRouter's `data_collection: deny`. */
  allowTraining: boolean;
  /** Keep to hosts OpenRouter lists as zero data retention (its `zdr` filter). */
  zeroRetention: boolean;
}

export const DEFAULT_OPENROUTER_ROUTING: OpenRouterRoutingPreferences = {
  sort: "latency",
  allowTraining: false,
  zeroRetention: false,
};

export function isAssistantModelProviderId(value: unknown): value is AssistantModelProviderId {
  return (
    typeof value === "string" && (ASSISTANT_MODEL_PROVIDER_IDS as readonly string[]).includes(value)
  );
}

/** The model a launch actually sends for a provider: the override, else the recommendation. */
export function effectiveAssistantModel(
  provider: AssistantModelProviderId,
  override: string | undefined
): string {
  const trimmed = override?.trim() ?? "";
  return trimmed || ASSISTANT_MODEL_PROVIDERS[provider].recommendedModel;
}
