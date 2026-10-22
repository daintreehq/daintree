import { describe, expect, it, vi } from "vitest";
import { migration035 } from "../035-remove-hibernation-setting.js";

function run(initial: Record<string, unknown>) {
  const data: Record<string, unknown> = structuredClone(initial);
  const store = {
    get: vi.fn((key: string) => data[key]),
    set: vi.fn((key: string, value: unknown) => {
      data[key] = value;
    }),
    delete: vi.fn((key: string) => {
      delete data[key];
    }),
  } as unknown as Parameters<typeof migration035.up>[0];
  migration035.up(store);
  return data;
}

describe("migration035 — remove the retired hibernation setting", () => {
  it("has version 35", () => {
    expect(migration035.version).toBe(35);
  });

  it.each([
    ["switched on", { enabled: true, inactiveThresholdHours: 48 }],
    ["switched off", { enabled: false, inactiveThresholdHours: 24 }],
    ["malformed", "yes"],
    ["empty", {}],
  ])("deletes the key whatever it holds (%s), carrying nothing forward", (_label, value) => {
    const data = run({
      hibernation: value,
      idleTerminalNotify: { enabled: true, thresholdMinutes: 60 },
      sessionRestore: { enabled: true },
    });

    expect(data).toEqual({
      idleTerminalNotify: { enabled: true, thresholdMinutes: 60 },
      sessionRestore: { enabled: true },
    });
  });

  it("leaves a store that never had the key untouched", () => {
    expect(run({ sessionRestore: { enabled: false } })).toEqual({
      sessionRestore: { enabled: false },
    });
  });
});
