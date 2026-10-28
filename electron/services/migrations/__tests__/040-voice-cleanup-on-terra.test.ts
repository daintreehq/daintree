import { describe, expect, it, vi } from "vitest";
import { migration040 } from "../040-voice-cleanup-on-terra.js";

function run(initial: Record<string, unknown>, times = 1) {
  const data: Record<string, unknown> = structuredClone(initial);
  const set = vi.fn((key: string, value: unknown) => {
    data[key] = value;
  });
  const store = {
    get: vi.fn((key: string) => data[key]),
    set,
  } as unknown as Parameters<typeof migration040.up>[0];
  for (let i = 0; i < times; i++) migration040.up(store);
  return { data, writes: set.mock.calls.length };
}

describe("migration040 — dictation cleanup moves to gpt-6.1-terra", () => {
  it("moves the forced gpt-6-luna on, keeping every other voice setting", () => {
    const { data } = run({
      voiceInput: {
        enabled: true,
        openaiApiKey: "sk-test",
        correctionEnabled: true,
        correctionModel: "gpt-6-luna",
        correctionCustomInstructions: "Prefer British spelling",
      },
    });

    expect(data.voiceInput).toEqual({
      enabled: true,
      openaiApiKey: "sk-test",
      correctionEnabled: true,
      correctionModel: "gpt-6.1-terra",
      correctionCustomInstructions: "Prefer British spelling",
    });
  });

  it("moves an older model on too", () => {
    const { data } = run({ voiceInput: { correctionModel: "gpt-5.6-luna", language: "de" } });
    expect(data.voiceInput).toEqual({ language: "de", correctionModel: "gpt-6.1-terra" });
  });

  it.each([
    ["already on gpt-6.1-terra", { correctionModel: "gpt-6.1-terra" }],
    ["without a model, which reads the default", { language: "de" }],
  ])("leaves a store %s untouched, without writing", (_label, voiceInput) => {
    const { data, writes } = run({ voiceInput });
    expect(data.voiceInput).toEqual(voiceInput);
    expect(writes).toBe(0);
  });

  it.each([
    ["missing", undefined],
    ["malformed", "on"],
    ["an array", [1]],
  ])("skips a voiceInput value that is %s", (_label, value) => {
    const initial = value === undefined ? {} : { voiceInput: value };
    const { data, writes } = run(initial);
    expect(data).toEqual(initial);
    expect(writes).toBe(0);
  });

  it("is idempotent, writing only the first time", () => {
    const initial = { voiceInput: { correctionModel: "gpt-6-luna", enabled: true } };
    const twice = run(initial, 2);
    expect(twice.data).toEqual(run(initial, 1).data);
    expect(twice.writes).toBe(1);
  });
});
