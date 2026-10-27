import { describe, expect, it } from "vitest";
import {
  VOICE_TRANSCRIPTION_PROVIDERS,
  hasCleanupKey,
  hasTranscriptionKey,
  transcriptionApiKey,
  transcriptionKeyField,
} from "../voiceProviders.js";

describe("voiceProviders", () => {
  it("maps each provider to its own key field", () => {
    expect(transcriptionKeyField("openai")).toBe("openaiApiKey");
    expect(transcriptionKeyField("deepgram")).toBe("deepgramApiKey");
  });

  it("gives every provider a distinct key field", () => {
    const fields = Object.values(VOICE_TRANSCRIPTION_PROVIDERS).map((p) => p.keyField);
    expect(new Set(fields).size).toBe(fields.length);
  });

  it("reads only the selected provider's key", () => {
    const settings = { openaiApiKey: "sk-1", deepgramApiKey: "" };
    expect(transcriptionApiKey({ ...settings, transcriptionProvider: "openai" })).toBe("sk-1");
    expect(hasTranscriptionKey({ ...settings, transcriptionProvider: "openai" })).toBe(true);
    expect(hasTranscriptionKey({ ...settings, transcriptionProvider: "deepgram" })).toBe(false);
  });

  it("does not need an OpenAI key to transcribe with another provider", () => {
    const settings = {
      openaiApiKey: "",
      deepgramApiKey: "dg",
      transcriptionProvider: "deepgram",
    } as const;
    expect(hasTranscriptionKey(settings)).toBe(true);
    expect(hasCleanupKey(settings)).toBe(false);
  });
});
