import { describe, expect, it, vi } from "vitest";
import { migration038 } from "../038-tap-or-hold-recording-mode.js";

function run(initial: Record<string, unknown>, times = 1) {
  const data: Record<string, unknown> = structuredClone(initial);
  const store = {
    get: vi.fn((key: string) => data[key]),
    set: vi.fn((key: string, value: unknown) => {
      data[key] = value;
    }),
    delete: vi.fn((key: string) => {
      delete data[key];
    }),
  } as unknown as Parameters<typeof migration038.up>[0];
  for (let i = 0; i < times; i++) migration038.up(store);
  return data;
}

describe("migration038 — tap-or-hold dictation default", () => {
  it("moves the old toggle default onto tap-or-hold, keeping every other setting", () => {
    const data = run({
      voiceInput: { enabled: true, language: "en", recordingMode: "toggle" },
      sessionRestore: { enabled: true },
    });
    expect(data).toEqual({
      voiceInput: { enabled: true, language: "en", recordingMode: "tap-or-hold" },
      sessionRestore: { enabled: true },
    });
  });

  it.each([
    ["push-to-talk", { enabled: true, recordingMode: "push-to-talk" }],
    ["already tap-or-hold", { enabled: true, recordingMode: "tap-or-hold" }],
    ["missing", { enabled: true }],
    ["unknown", { enabled: true, recordingMode: "hold" }],
  ])("leaves any stored mode but toggle alone (%s)", (_label, voiceInput) => {
    const initial = { voiceInput };
    expect(run(initial)).toEqual(initial);
  });

  it("leaves a store without voice settings untouched", () => {
    expect(run({ sessionRestore: { enabled: false } })).toEqual({
      sessionRestore: { enabled: false },
    });
  });

  it("is idempotent", () => {
    const initial = { voiceInput: { recordingMode: "toggle" } };
    expect(run(initial, 2)).toEqual(run(initial, 1));
  });
});
