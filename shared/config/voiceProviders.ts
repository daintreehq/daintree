import type { VoiceInputSettings, VoiceTranscriptionProvider } from "../types/ipc/api.js";

/** A stored voice-input credential: any `VoiceInputSettings` field named `<company>ApiKey`. */
export type VoiceApiKeyField = Extract<keyof VoiceInputSettings, `${string}ApiKey`>;

export interface VoiceTranscriptionProviderInfo {
  name: string;
  keyField: VoiceApiKeyField;
}

/**
 * One entry per transcription provider, naming the settings field that holds the key it
 * transcribes with. `Record` makes a new provider fail to compile until it has an entry,
 * so no key check needs a branch of its own.
 */
export const VOICE_TRANSCRIPTION_PROVIDERS: Record<
  VoiceTranscriptionProvider,
  VoiceTranscriptionProviderInfo
> = {
  openai: { name: "OpenAI", keyField: "openaiApiKey" },
  deepgram: { name: "Deepgram", keyField: "deepgramApiKey" },
};

/** Cleanup, file-link detection and rewrite all run on OpenAI, whichever provider transcribes. */
export const VOICE_CLEANUP_KEY_FIELD = "openaiApiKey" satisfies VoiceApiKeyField;

/** An unrecognised stored provider reads as OpenAI, as the main process settings merge does. */
function providerInfo(provider: VoiceTranscriptionProvider): VoiceTranscriptionProviderInfo {
  return VOICE_TRANSCRIPTION_PROVIDERS[provider] ?? VOICE_TRANSCRIPTION_PROVIDERS.openai;
}

export function transcriptionKeyField(provider: VoiceTranscriptionProvider): VoiceApiKeyField {
  return providerInfo(provider).keyField;
}

export function transcriptionProviderName(provider: VoiceTranscriptionProvider): string {
  return providerInfo(provider).name;
}

type KeySettings = Pick<VoiceInputSettings, "transcriptionProvider" | VoiceApiKeyField>;

/** The key the selected provider transcribes with. */
export function transcriptionApiKey(settings: KeySettings): string {
  return settings[transcriptionKeyField(settings.transcriptionProvider)];
}

export function hasTranscriptionKey(settings: KeySettings): boolean {
  return !!transcriptionApiKey(settings);
}

/** Whether a cleanup pass has the OpenAI key it needs. */
export function hasCleanupKey(settings: Pick<VoiceInputSettings, typeof VOICE_CLEANUP_KEY_FIELD>) {
  return !!settings[VOICE_CLEANUP_KEY_FIELD];
}
