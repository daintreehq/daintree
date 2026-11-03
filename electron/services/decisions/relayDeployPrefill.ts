import type { VoiceInputSettings } from "../../../shared/types/ipc/api.js";

/** A provider whose key the relay's dictation can use. */
export type RelayKeyProvider = "xai" | "openai" | "anthropic";

/**
 * The `answers` of the host channel's `prefill` message (CLI 0.3.0, contract
 * version 1): defaults the person still sees and confirms at each step.
 */
export interface RelayDeployPrefill {
  transcription?: { provider: "xai" | "openai" };
  cleanup?: { provider: "anthropic" | "openai"; model: string };
  keys: Partial<Record<RelayKeyProvider, string>>;
}

type PrefillSettings = Pick<
  VoiceInputSettings,
  | "enabled"
  | "transcriptionProvider"
  | "correctionEnabled"
  | "correctionProvider"
  | "correctionModel"
  | "xaiApiKey"
  | "openaiApiKey"
  | "anthropicApiKey"
>;

/**
 * The CLI fails the whole deploy on a field longer than 1024 characters or
 * holding a control character, so such a value is left for the person to type.
 */
function singleLine(value: string | undefined): string | undefined {
  const text = value?.trim();
  return text && text.length <= 1024 && !/[\x00-\x1f\x7f]/.test(text) ? text : undefined;
}

/**
 * The guided deploy's defaults, from the voice settings. Dictation turned off
 * suggests neither feature, since the default settings already pick a provider
 * and turn cleanup on. Grok transcribes through xAI; Deepgram has no relay
 * equivalent, so it suggests nothing. The cleanup model goes as it is: the CLI
 * explains and replaces one it doesn't offer. Every key held is offered, so a
 * provider changed during the deploy can still use one.
 */
export function relayDeployPrefill(settings: PrefillSettings): RelayDeployPrefill {
  const prefill: RelayDeployPrefill = { keys: {} };
  const keys: Record<RelayKeyProvider, string | undefined> = {
    xai: singleLine(settings.xaiApiKey),
    openai: singleLine(settings.openaiApiKey),
    anthropic: singleLine(settings.anthropicApiKey),
  };
  for (const provider of ["xai", "openai", "anthropic"] as const) {
    const key = keys[provider];
    if (key !== undefined) prefill.keys[provider] = key;
  }
  if (!settings.enabled) return prefill;

  if (settings.transcriptionProvider === "grok") prefill.transcription = { provider: "xai" };
  else if (settings.transcriptionProvider === "openai") {
    prefill.transcription = { provider: "openai" };
  }

  const model = singleLine(settings.correctionModel);
  if (
    settings.correctionEnabled &&
    (settings.correctionProvider === "anthropic" || settings.correctionProvider === "openai") &&
    model
  ) {
    prefill.cleanup = { provider: settings.correctionProvider, model };
  }
  return prefill;
}
