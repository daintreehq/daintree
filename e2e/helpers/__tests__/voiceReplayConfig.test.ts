import { describe, expect, it } from "vitest";
import { providerKeyEnv, resolveReplayConfigs } from "../voiceReplayConfig";

const noFile = () => {
  throw new Error("no file expected");
};

describe("resolveReplayConfigs", () => {
  it("runs every provider without a custom dictionary by default", () => {
    const configs = resolveReplayConfigs({}, noFile);
    expect(configs.map((c) => [c.id, c.provider, c.dictionary.length])).toEqual([
      ["openai", "openai", 0],
      ["deepgram", "deepgram", 0],
      ["grok", "grok", 0],
    ]);
  });

  it("picks presets by name, the +terms ones carrying the fixture vocabulary", () => {
    const [config] = resolveReplayConfigs({ VOICE_REPLAY_CONFIGS: " deepgram+terms " }, noFile);
    expect(config!.provider).toBe("deepgram");
    expect(config!.dictionary).toContain("Zustand");
  });

  it("adds file configs, and runs only them when no preset is named", () => {
    const file = JSON.stringify([
      { id: "german", provider: "openai", settings: { language: "de" }, dictionary: ["Zod"] },
    ]);
    const configs = resolveReplayConfigs({ VOICE_REPLAY_CONFIG_FILE: "c.json" }, () => file);
    expect(configs).toEqual([
      { id: "german", provider: "openai", settings: { language: "de" }, dictionary: ["Zod"] },
    ]);
  });

  it("refuses a setting the app doesn't read, rather than reporting a difference that isn't there", () => {
    for (const setting of ["delay", "transcriptionModel"]) {
      const file = JSON.stringify([{ id: "x", provider: "openai", settings: { [setting]: "y" } }]);
      expect(() =>
        resolveReplayConfigs({ VOICE_REPLAY_CONFIG_FILE: "c.json" }, () => file)
      ).toThrow(`can't vary ${setting}`);
    }
  });

  it("refuses unknown presets, bad providers and duplicate ids", () => {
    expect(() => resolveReplayConfigs({ VOICE_REPLAY_CONFIGS: "whisper" }, noFile)).toThrow(
      /unknown config/
    );
    const bad = JSON.stringify([{ id: "x", provider: "azure" }]);
    expect(() => resolveReplayConfigs({ VOICE_REPLAY_CONFIG_FILE: "c" }, () => bad)).toThrow(
      /provider/
    );
    const dup = JSON.stringify([{ id: "openai", provider: "openai" }]);
    expect(() =>
      resolveReplayConfigs(
        { VOICE_REPLAY_CONFIGS: "openai", VOICE_REPLAY_CONFIG_FILE: "c" },
        () => dup
      )
    ).toThrow(/appears twice/);
  });
});

describe("providerKeyEnv", () => {
  it("hands the OpenAI key to the variable the app reads", () => {
    expect(providerKeyEnv("openai", { OPENAI_API_KEY: " sk-a " })).toEqual({
      WHISPER_API_KEY: "sk-a",
    });
    expect(providerKeyEnv("openai", { WHISPER_API_KEY: "sk-b" })).toEqual({
      WHISPER_API_KEY: "sk-b",
    });
    expect(providerKeyEnv("deepgram", { DEEPGRAM_API_KEY: "dg" })).toEqual({
      DEEPGRAM_API_KEY: "dg",
    });
    expect(providerKeyEnv("grok", { XAI_API_KEY: " xai-a " })).toEqual({ XAI_API_KEY: "xai-a" });
  });

  it("prefers OPENAI_API_KEY over an inherited WHISPER_API_KEY", () => {
    expect(providerKeyEnv("openai", { OPENAI_API_KEY: "sk-a", WHISPER_API_KEY: "sk-b" })).toEqual({
      WHISPER_API_KEY: "sk-a",
    });
  });

  it("returns null when the provider has no key, so the config is skipped", () => {
    expect(providerKeyEnv("openai", { DEEPGRAM_API_KEY: "dg" })).toBeNull();
    expect(providerKeyEnv("deepgram", { DEEPGRAM_API_KEY: "  " })).toBeNull();
    expect(providerKeyEnv("grok", { DEEPGRAM_API_KEY: "dg" })).toBeNull();
  });
});
