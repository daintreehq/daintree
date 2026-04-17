import { describe, expect, it, vi } from "vitest";
import { migration014 } from "../014-consolidate-telemetry-consent.js";

function makeStoreMock(data: Record<string, unknown>) {
  return {
    get: vi.fn((key: string) => data[key]),
    set: vi.fn((key: string, value: unknown) => {
      data[key] = value;
    }),
    delete: vi.fn((key: string) => {
      delete data[key];
    }),
    _data: data,
  } as unknown as Parameters<typeof migration014.up>[0] & {
    _data: Record<string, unknown>;
  };
}

describe("migration014 — consolidate telemetry consent", () => {
  it("has version 14", () => {
    expect(migration014.version).toBe(14);
  });

  it("migrates legacy enabled=true to privacy.telemetryLevel='errors'", () => {
    const store = makeStoreMock({
      telemetry: { enabled: true, hasSeenPrompt: true },
    });
    migration014.up(store);
    expect(store.set).toHaveBeenCalledWith(
      "privacy",
      expect.objectContaining({ telemetryLevel: "errors", hasSeenPrompt: true })
    );
    expect((store as unknown as { delete: ReturnType<typeof vi.fn> }).delete).toHaveBeenCalledWith(
      "telemetry"
    );
    expect(
      (store as unknown as { _data: Record<string, unknown> })._data.telemetry
    ).toBeUndefined();
  });

  it("migrates legacy enabled=false to privacy.telemetryLevel='off'", () => {
    const store = makeStoreMock({
      telemetry: { enabled: false, hasSeenPrompt: false },
    });
    migration014.up(store);
    expect(store.set).toHaveBeenCalledWith(
      "privacy",
      expect.objectContaining({ telemetryLevel: "off", hasSeenPrompt: false })
    );
  });

  it("preserves an existing privacy.telemetryLevel when legacy disagrees", () => {
    const store = makeStoreMock({
      telemetry: { enabled: true, hasSeenPrompt: false },
      privacy: { telemetryLevel: "full", logRetentionDays: 30 },
    });
    migration014.up(store);
    expect(store.set).toHaveBeenCalledWith(
      "privacy",
      expect.objectContaining({ telemetryLevel: "full", logRetentionDays: 30 })
    );
  });

  it("preserves an existing privacy.hasSeenPrompt when both are set", () => {
    const store = makeStoreMock({
      telemetry: { enabled: true, hasSeenPrompt: false },
      privacy: { telemetryLevel: "errors", hasSeenPrompt: true, logRetentionDays: 30 },
    });
    migration014.up(store);
    expect(store.set).toHaveBeenCalledWith(
      "privacy",
      expect.objectContaining({ hasSeenPrompt: true })
    );
  });

  it("defaults to off/false when neither legacy nor privacy has values", () => {
    const store = makeStoreMock({});
    migration014.up(store);
    expect(store.set).toHaveBeenCalledWith(
      "privacy",
      expect.objectContaining({ telemetryLevel: "off", hasSeenPrompt: false })
    );
  });

  it("is idempotent — a second run with no telemetry key produces no delete call", () => {
    const data: Record<string, unknown> = {
      telemetry: { enabled: true, hasSeenPrompt: true },
    };
    const store = makeStoreMock(data);

    migration014.up(store);
    const firstDelete = (store as unknown as { delete: ReturnType<typeof vi.fn> }).delete.mock.calls
      .length;
    expect(firstDelete).toBe(1);
    expect(data.telemetry).toBeUndefined();

    migration014.up(store);
    const secondDelete = (store as unknown as { delete: ReturnType<typeof vi.fn> }).delete.mock
      .calls.length;
    expect(secondDelete).toBe(1); // no additional delete call
  });

  it("does not throw on malformed telemetry shapes", () => {
    const shapes: Array<[string, unknown]> = [
      ["telemetry null", null],
      ["telemetry array", []],
      ["telemetry string", "nope"],
      ["telemetry enabled non-bool", { enabled: "yes", hasSeenPrompt: "yes" }],
    ];
    for (const [label, value] of shapes) {
      const store = makeStoreMock({ telemetry: value });
      expect(() => migration014.up(store), `case: ${label}`).not.toThrow();
    }
  });

  it("treats non-true legacy enabled as 'off'", () => {
    const store = makeStoreMock({
      telemetry: { enabled: "yes", hasSeenPrompt: false },
    });
    migration014.up(store);
    expect(store.set).toHaveBeenCalledWith(
      "privacy",
      expect.objectContaining({ telemetryLevel: "off" })
    );
  });

  it("does not regress privacy='full' when legacy telemetry.enabled=false", () => {
    const store = makeStoreMock({
      telemetry: { enabled: false, hasSeenPrompt: true },
      privacy: { telemetryLevel: "full", hasSeenPrompt: true, logRetentionDays: 30 },
    });
    migration014.up(store);
    expect(store.set).toHaveBeenCalledWith(
      "privacy",
      expect.objectContaining({ telemetryLevel: "full", hasSeenPrompt: true })
    );
  });

  it("preserves unrelated privacy fields (logRetentionDays)", () => {
    const store = makeStoreMock({
      telemetry: { enabled: true, hasSeenPrompt: true },
      privacy: { logRetentionDays: 7 },
    });
    migration014.up(store);
    expect(store.set).toHaveBeenCalledWith(
      "privacy",
      expect.objectContaining({
        telemetryLevel: "errors",
        hasSeenPrompt: true,
        logRetentionDays: 7,
      })
    );
  });
});
