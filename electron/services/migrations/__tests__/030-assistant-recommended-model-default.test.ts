import { describe, expect, it, vi } from "vitest";
import { migration030 } from "../030-assistant-recommended-model-default.js";

function run(helpAssistant: Record<string, unknown> | undefined) {
  const data: Record<string, unknown> = helpAssistant === undefined ? {} : { helpAssistant };
  const store = {
    get: vi.fn((key: string) => data[key]),
    set: vi.fn((key: string, value: unknown) => {
      data[key] = value;
    }),
  } as unknown as Parameters<typeof migration030.up>[0] & { set: ReturnType<typeof vi.fn> };
  migration030.up(store);
  return { store, after: data.helpAssistant as Record<string, unknown> | undefined };
}

describe("migration030 — assistant recommended model default", () => {
  it("has version 30", () => {
    expect(migration030.version).toBe(30);
  });

  it("drops an empty modelId so the agent's recommended model applies", () => {
    const { after } = run({ docSearch: true, modelId: "", customArgs: "--verbose" });
    expect(after).toEqual({ docSearch: true, customArgs: "--verbose" });
  });

  it("keeps a model the user chose", () => {
    const { store, after } = run({ modelId: "opus" });
    expect(after).toEqual({ modelId: "opus" });
    expect(store.set).not.toHaveBeenCalled();
  });

  it("treats a whitespace-only modelId as unset", () => {
    expect(run({ modelId: "   " }).after).toEqual({});
  });

  it("leaves malformed assistant settings alone", () => {
    expect(run({ modelId: 42 }).store.set).not.toHaveBeenCalled();
    expect(run({ modelId: null }).store.set).not.toHaveBeenCalled();
    expect(() => run("corrupt" as unknown as Record<string, unknown>)).not.toThrow();
  });

  it("is a no-op without assistant settings or a stored modelId", () => {
    expect(run(undefined).store.set).not.toHaveBeenCalled();
    expect(run({ docSearch: false }).store.set).not.toHaveBeenCalled();
  });
});
