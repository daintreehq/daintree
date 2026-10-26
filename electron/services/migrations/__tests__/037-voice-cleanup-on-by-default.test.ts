import { describe, expect, it, vi } from "vitest";
import { migration037 } from "../037-voice-cleanup-on-by-default.js";

function run(initial: Record<string, unknown>, times = 1) {
  const data: Record<string, unknown> = structuredClone(initial);
  const set = vi.fn((key: string, value: unknown) => {
    data[key] = value;
  });
  const store = {
    get: vi.fn((key: string) => data[key]),
    set,
  } as unknown as Parameters<typeof migration037.up>[0];
  for (let i = 0; i < times; i++) migration037.up(store);
  return { data, writes: set.mock.calls.length };
}

describe("migration037 — AI cleanup of dictation on by default", () => {
  it("turns a persisted old default on, keeping every other voice setting", () => {
    const { data } = run({
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
    const { data } = run({ voiceInput: { enabled: false } });
    expect(data.voiceInput).toEqual({ enabled: false, correctionEnabled: true });
  });

  it("leaves cleanup that is already on untouched, without writing", () => {
    const { data, writes } = run({ voiceInput: { correctionEnabled: true, language: "de" } });
    expect(data.voiceInput).toEqual({ correctionEnabled: true, language: "de" });
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
    const initial = { voiceInput: { correctionEnabled: false, enabled: true } };
    const twice = run(initial, 2);
    expect(twice.data).toEqual(run(initial, 1).data);
    expect(twice.writes).toBe(1);
  });
});
