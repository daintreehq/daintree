import { describe, expect, it, vi } from "vitest";
import { migration037 } from "../037-voice-cleanup-on-by-default.js";

function run(initial: Record<string, unknown>, times = 1) {
  const data: Record<string, unknown> = structuredClone(initial);
  const store = {
    get: vi.fn((key: string) => data[key]),
    set: vi.fn((key: string, value: unknown) => {
      data[key] = value;
    }),
  } as unknown as Parameters<typeof migration037.up>[0];
  for (let i = 0; i < times; i++) migration037.up(store);
  return data;
}

describe("migration037 — AI cleanup of dictation on by default", () => {
  it("turns a persisted old default on, keeping every other voice setting", () => {
    const data = run({
      voiceInput: {
        enabled: true,
        openaiApiKey: "sk-test",
        correctionEnabled: false,
        correctionCustomInstructions: "Prefer British spelling",
        resolveFileLinks: false,
      },
    });

    expect(data.voiceInput).toEqual({
      enabled: true,
      openaiApiKey: "sk-test",
      correctionEnabled: true,
      correctionCustomInstructions: "Prefer British spelling",
      resolveFileLinks: false,
    });
  });

  it("backfills a store written before the field existed", () => {
    const data = run({ voiceInput: { enabled: false } });
    expect(data.voiceInput).toEqual({ enabled: false, correctionEnabled: true });
  });

  it("leaves cleanup that is already on untouched", () => {
    const data = run({ voiceInput: { correctionEnabled: true, language: "de" } });
    expect(data.voiceInput).toEqual({ correctionEnabled: true, language: "de" });
  });

  it.each([
    ["missing", undefined],
    ["malformed", "on"],
    ["an array", [1]],
  ])("skips a voiceInput value that is %s", (_label, value) => {
    const initial = value === undefined ? {} : { voiceInput: value };
    expect(run(initial)).toEqual(initial);
  });

  it("is idempotent", () => {
    const initial = { voiceInput: { correctionEnabled: false, enabled: true } };
    expect(run(initial, 2)).toEqual(run(initial, 1));
  });
});
