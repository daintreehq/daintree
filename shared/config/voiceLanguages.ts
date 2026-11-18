export const VOICE_LANGUAGE_AUTO = "auto";

export const VOICE_LANGUAGES = [
  { code: VOICE_LANGUAGE_AUTO, label: "Auto-detect (multiple languages)" },
  { code: "en", label: "English" },
  { code: "es", label: "Spanish" },
  { code: "fr", label: "French" },
  { code: "de", label: "German" },
  { code: "ja", label: "Japanese" },
  { code: "zh", label: "Chinese" },
  { code: "ko", label: "Korean" },
  { code: "pt", label: "Portuguese" },
  { code: "it", label: "Italian" },
  { code: "ru", label: "Russian" },
] as const;

/** Persisted settings are cast, not validated, so blank and non-string values fall back to English. */
export function normalizeVoiceLanguage(value: unknown): string {
  const trimmed = typeof value === "string" ? value.trim() : "";
  return trimmed || "en";
}

/**
 * Spoken commands ("new line", "send it") are English phrases. They run with
 * English selected, and on Auto-detect, where a passage in any language can
 * end in one; a fixed other language leaves them as words.
 */
export function spokenCommandsAvailable(language: unknown): boolean {
  const code = normalizeVoiceLanguage(language);
  return code === "en" || code === VOICE_LANGUAGE_AUTO;
}

export function voiceLanguageName(code: string): string {
  return VOICE_LANGUAGES.find((l) => l.code === code)?.label ?? code;
}
