import { describe, expect, it } from "vitest";
import { relayDeployPrefill } from "../relayDeployPrefill.js";

type Settings = Parameters<typeof relayDeployPrefill>[0];

/** Dictation on, transcribing with Grok and cleaning up with Anthropic, every key held. */
const CONFIGURED: Settings = {
  enabled: true,
  transcriptionProvider: "grok",
  correctionEnabled: true,
  correctionProvider: "anthropic",
  correctionModel: "claude-haiku-5-5",
  xaiApiKey: "xai-key-0123456789",
  openaiApiKey: "sk-openai-0123456789",
  anthropicApiKey: "sk-ant-0123456789",
};

/** What a fresh install reads: dictation off, though a provider and cleanup are preselected. */
const UNTOUCHED: Settings = {
  enabled: false,
  transcriptionProvider: "openai",
  correctionEnabled: true,
  correctionProvider: "openai",
  correctionModel: "gpt-6-terra",
  xaiApiKey: "",
  openaiApiKey: "",
  anthropicApiKey: "",
};

describe("relayDeployPrefill", () => {
  it("prefills Grok as xAI, the cleanup provider and model, and every key held", () => {
    expect(relayDeployPrefill(CONFIGURED)).toEqual({
      transcription: { provider: "xai" },
      cleanup: { provider: "anthropic", model: "claude-haiku-5-5" },
      keys: {
        xai: "xai-key-0123456789",
        openai: "sk-openai-0123456789",
        anthropic: "sk-ant-0123456789",
      },
    });
  });

  it("prefills nothing for settings nobody has configured", () => {
    expect(relayDeployPrefill(UNTOUCHED)).toEqual({ keys: {} });
  });

  it("suggests neither feature while dictation is off, but still offers the keys it holds", () => {
    expect(relayDeployPrefill({ ...CONFIGURED, enabled: false })).toEqual({
      keys: {
        xai: "xai-key-0123456789",
        openai: "sk-openai-0123456789",
        anthropic: "sk-ant-0123456789",
      },
    });
  });

  it("suggests no transcription for Deepgram, which the relay has no equivalent of", () => {
    const prefill = relayDeployPrefill({ ...CONFIGURED, transcriptionProvider: "deepgram" });

    expect(prefill.transcription).toBeUndefined();
    expect(prefill.cleanup).toEqual({ provider: "anthropic", model: "claude-haiku-5-5" });
  });

  it("keeps OpenAI transcription as OpenAI", () => {
    expect(
      relayDeployPrefill({ ...CONFIGURED, transcriptionProvider: "openai" }).transcription
    ).toEqual({ provider: "openai" });
  });

  it("suggests no cleanup while it's turned off", () => {
    expect(relayDeployPrefill({ ...CONFIGURED, correctionEnabled: false }).cleanup).toBeUndefined();
  });

  it("passes the cleanup model on as it is, for the CLI to accept or replace", () => {
    const prefill = relayDeployPrefill({
      ...CONFIGURED,
      correctionProvider: "openai",
      correctionModel: "gpt-6-luna",
    });

    expect(prefill.cleanup).toEqual({ provider: "openai", model: "gpt-6-luna" });
  });

  it("offers no key or model the CLI would refuse, so the deploy isn't failed by a default", () => {
    const prefill = relayDeployPrefill({
      ...CONFIGURED,
      xaiApiKey: "  ",
      openaiApiKey: "sk-line\nbreak",
      anthropicApiKey: "x".repeat(1025),
      correctionModel: "model\twith-tab",
    });

    expect(prefill.keys).toEqual({});
    expect(prefill.cleanup).toBeUndefined();
  });

  it("trims a key held with stray whitespace", () => {
    expect(relayDeployPrefill({ ...UNTOUCHED, openaiApiKey: " sk-openai \n" }).keys).toEqual({
      openai: "sk-openai",
    });
  });
});
