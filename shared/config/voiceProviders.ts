import type {
  VoiceCorrectionProvider,
  VoiceInputSettings,
  VoiceTranscriptionProvider,
} from "../types/ipc/api.js";

/** A stored voice-input credential: any `VoiceInputSettings` field named `<company>ApiKey`. */
export type VoiceApiKeyField = Extract<keyof VoiceInputSettings, `${string}ApiKey`>;

/** The keys a transcription provider can hold; Anthropic's only cleans up. */
export type TranscriptionKeyField = Exclude<VoiceApiKeyField, "anthropicApiKey">;

interface VoiceProviderInfo<Field extends VoiceApiKeyField> {
  name: string;
  /** Who issues the key, as its settings row names it. */
  keyIssuer: string;
  keyField: Field;
}

export type VoiceTranscriptionProviderInfo = VoiceProviderInfo<TranscriptionKeyField>;

/**
 * One entry per transcription provider, naming the settings field that holds the key it
 * transcribes with. `Record` makes a new provider fail to compile until it has an entry,
 * so no key check needs a branch of its own.
 */
export const VOICE_TRANSCRIPTION_PROVIDERS: Record<
  VoiceTranscriptionProvider,
  VoiceTranscriptionProviderInfo
> = {
  openai: { name: "OpenAI", keyIssuer: "OpenAI", keyField: "openaiApiKey" },
  deepgram: { name: "Deepgram", keyIssuer: "Deepgram", keyField: "deepgramApiKey" },
  grok: { name: "Grok", keyIssuer: "xAI", keyField: "xaiApiKey" },
};

/** Cleanup and spoken rewrite run on the chosen cleanup provider, whichever provider transcribes. */
export const VOICE_CLEANUP_PROVIDER_INFO: Record<
  VoiceCorrectionProvider,
  VoiceProviderInfo<VoiceApiKeyField>
> = {
  openai: { name: "OpenAI", keyIssuer: "OpenAI", keyField: "openaiApiKey" },
  anthropic: { name: "Anthropic", keyIssuer: "Anthropic", keyField: "anthropicApiKey" },
};

/** File-link detection and its reranking run on OpenAI, whichever provider cleans up. */
export const VOICE_FILE_LINK_KEY_FIELD = "openaiApiKey" satisfies VoiceApiKeyField;

function cleanupInfo(provider: VoiceCorrectionProvider): VoiceProviderInfo<VoiceApiKeyField> {
  return VOICE_CLEANUP_PROVIDER_INFO[provider] ?? VOICE_CLEANUP_PROVIDER_INFO.openai;
}

export function cleanupKeyField(provider: VoiceCorrectionProvider): VoiceApiKeyField {
  return cleanupInfo(provider).keyField;
}

export function cleanupKeyIssuer(provider: VoiceCorrectionProvider): string {
  return cleanupInfo(provider).keyIssuer;
}

/** An unrecognised stored provider reads as OpenAI, as the main process settings merge does. */
function providerInfo(provider: VoiceTranscriptionProvider): VoiceTranscriptionProviderInfo {
  return VOICE_TRANSCRIPTION_PROVIDERS[provider] ?? VOICE_TRANSCRIPTION_PROVIDERS.openai;
}

export function transcriptionKeyField(provider: VoiceTranscriptionProvider): TranscriptionKeyField {
  return providerInfo(provider).keyField;
}

export function transcriptionProviderName(provider: VoiceTranscriptionProvider): string {
  return providerInfo(provider).name;
}

export function transcriptionKeyIssuer(provider: VoiceTranscriptionProvider): string {
  return providerInfo(provider).keyIssuer;
}

type KeySettings = Pick<VoiceInputSettings, "transcriptionProvider" | TranscriptionKeyField>;

/** The key the selected provider transcribes with. */
export function transcriptionApiKey(settings: KeySettings): string {
  return settings[transcriptionKeyField(settings.transcriptionProvider)];
}

export function hasTranscriptionKey(settings: KeySettings): boolean {
  return !!transcriptionApiKey(settings);
}

type CleanupKeySettings = Pick<VoiceInputSettings, "correctionProvider" | VoiceApiKeyField>;

/** The key the chosen cleanup provider cleans up and rewrites with. */
export function cleanupApiKey(settings: CleanupKeySettings): string {
  return settings[cleanupKeyField(settings.correctionProvider)];
}

/** Whether a cleanup pass or a spoken rewrite has the key its provider needs. */
export function hasCleanupKey(settings: CleanupKeySettings): boolean {
  return !!cleanupApiKey(settings);
}
