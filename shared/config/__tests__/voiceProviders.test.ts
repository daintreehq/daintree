import { describe, expect, it } from "vitest";
import {
  VOICE_TRANSCRIPTION_PROVIDERS,
  cleanupApiKey,
  cleanupKeyField,
  hasCleanupKey,
  hasTranscriptionKey,
  transcribesOnDevice,
  transcriptionApiKey,
  transcriptionKeyField,
  transcriptionKeyIssuer,
  transcriptionProviderReady,
} from "../voiceProviders.js";

describe("voiceProviders", () => {
  it("maps each provider to its own key field", () => {
    expect(transcriptionKeyField("openai")).toBe("openaiApiKey");
    expect(transcriptionKeyField("deepgram")).toBe("deepgramApiKey");
    expect(transcriptionKeyField("grok")).toBe("xaiApiKey");
  });

  it("gives every keyed provider a distinct key field", () => {
    const fields = Object.values(VOICE_TRANSCRIPTION_PROVIDERS).flatMap((p) =>
      p.kind === "key" ? [p.keyField] : []
    );
    expect(fields).toHaveLength(3);
    expect(new Set(fields).size).toBe(fields.length);
  });

  it("gives the on-device provider no key", () => {
    const settings = { openaiApiKey: "sk-1", deepgramApiKey: "dg", xaiApiKey: "xai-1" };
    expect(transcribesOnDevice("local")).toBe(true);
    expect(transcribesOnDevice("openai")).toBe(false);
    expect(transcriptionKeyField("local")).toBeNull();
    expect(transcriptionKeyIssuer("local")).toBeNull();
    expect(transcriptionApiKey({ ...settings, transcriptionProvider: "local" })).toBe("");
    expect(hasTranscriptionKey({ ...settings, transcriptionProvider: "local" })).toBe(false);
  });

  it("counts the on-device provider ready once its model is, and a keyed one by its key", () => {
    const keyless = { openaiApiKey: "", deepgramApiKey: "", xaiApiKey: "" };
    expect(transcriptionProviderReady({ ...keyless, transcriptionProvider: "local" }, true)).toBe(
      true
    );
    expect(transcriptionProviderReady({ ...keyless, transcriptionProvider: "local" }, false)).toBe(
      false
    );
    expect(transcriptionProviderReady({ ...keyless, transcriptionProvider: "openai" }, true)).toBe(
      false
    );
    expect(
      transcriptionProviderReady(
        { ...keyless, openaiApiKey: "sk-1", transcriptionProvider: "openai" },
        false
      )
    ).toBe(true);
  });

  it("reads only the selected provider's key", () => {
    const settings = { openaiApiKey: "sk-1", deepgramApiKey: "", xaiApiKey: "" };
    expect(transcriptionApiKey({ ...settings, transcriptionProvider: "openai" })).toBe("sk-1");
    expect(hasTranscriptionKey({ ...settings, transcriptionProvider: "openai" })).toBe(true);
    expect(hasTranscriptionKey({ ...settings, transcriptionProvider: "deepgram" })).toBe(false);
    expect(hasTranscriptionKey({ ...settings, transcriptionProvider: "grok" })).toBe(false);
  });

  it("does not need an OpenAI key to transcribe with another provider", () => {
    const settings = {
      openaiApiKey: "",
      deepgramApiKey: "dg",
      xaiApiKey: "",
      transcriptionProvider: "deepgram",
      anthropicApiKey: "",
      correctionProvider: "openai",
    } as const;
    expect(hasTranscriptionKey(settings)).toBe(true);
    expect(hasCleanupKey(settings)).toBe(false);
  });

  it("reads Grok's key from the xAI field", () => {
    const settings = {
      openaiApiKey: "",
      deepgramApiKey: "",
      xaiApiKey: "xai-1",
      transcriptionProvider: "grok",
      anthropicApiKey: "",
      correctionProvider: "openai",
    } as const;
    expect(transcriptionApiKey(settings)).toBe("xai-1");
    expect(hasTranscriptionKey(settings)).toBe(true);
    expect(hasTranscriptionKey({ ...settings, transcriptionProvider: "deepgram" })).toBe(false);
    expect(hasCleanupKey(settings)).toBe(false);
  });

  it("reads cleanup's key from the cleanup provider, whichever provider transcribes", () => {
    const settings = {
      openaiApiKey: "sk-1",
      deepgramApiKey: "dg",
      xaiApiKey: "",
      anthropicApiKey: "",
      transcriptionProvider: "deepgram",
      correctionProvider: "anthropic",
    } as const;
    expect(cleanupKeyField("anthropic")).toBe("anthropicApiKey");
    expect(cleanupApiKey(settings)).toBe("");
    expect(hasCleanupKey(settings)).toBe(false);
    expect(hasCleanupKey({ ...settings, anthropicApiKey: "sk-ant-1" })).toBe(true);
    expect(cleanupApiKey({ ...settings, correctionProvider: "openai" })).toBe("sk-1");
  });
});
