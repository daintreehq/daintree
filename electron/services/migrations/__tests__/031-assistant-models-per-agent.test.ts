import { describe, expect, it, vi } from "vitest";
import { migration031 } from "../031-assistant-models-per-agent.js";

function run(helpAssistant: Record<string, unknown> | undefined) {
  const data: Record<string, unknown> = helpAssistant === undefined ? {} : { helpAssistant };
  const store = {
    get: vi.fn((key: string) => data[key]),
    set: vi.fn((key: string, value: unknown) => {
      data[key] = value;
    }),
  } as unknown as Parameters<typeof migration031.up>[0] & { set: ReturnType<typeof vi.fn> };
  migration031.up(store);
  return { store, after: data.helpAssistant as Record<string, unknown> | undefined };
}

describe("migration031 — assistant model per agent", () => {
  it("has version 31", () => {
    expect(migration031.version).toBe(31);
  });

  it("moves a model onto the one assistant agent whose catalog lists it", () => {
    const { after } = run({ tier: "core", bypassPermissions: true, modelId: "opus" });
    expect(after).toEqual({ tier: "core", bypassPermissions: true, modelIds: { claude: "opus" } });
  });

  it("ignores catalogs of agents that can't back the assistant", () => {
    // Aider lists "sonnet" too, but never runs the assistant.
    expect(run({ modelId: "sonnet" }).after).toEqual({ modelIds: { claude: "sonnet" } });
  });

  it("drops a model several assistant agents list, since its owner is unknown", () => {
    expect(run({ modelId: "gemini-2.5-pro" }).after).toEqual({ modelIds: {} });
  });

  it("drops a custom model no catalog lists", () => {
    expect(run({ modelId: "my-fork-model", customArgs: "--verbose" }).after).toEqual({
      customArgs: "--verbose",
      modelIds: {},
    });
  });

  it("drops an explicit CLI default, a null and a corrupted value", () => {
    expect(run({ modelId: "" }).after).toEqual({ modelIds: {} });
    expect(run({ modelId: null }).after).toEqual({ modelIds: {} });
    expect(run({ modelId: "opus;rm -rf /" }).after).toEqual({ modelIds: {} });
    expect(run({ modelId: 42 }).after).toEqual({ modelIds: {} });
  });

  it("trims the legacy value before attributing it", () => {
    expect(run({ modelId: "  opus " }).after).toEqual({ modelIds: { claude: "opus" } });
  });

  it("keeps an existing map as authoritative and drops the leftover scalar", () => {
    expect(run({ modelId: "opus", modelIds: { codex: "gpt-6-sol" } }).after).toEqual({
      modelIds: { codex: "gpt-6-sol" },
    });
    expect(run({ modelId: "opus", modelIds: {} }).after).toEqual({ modelIds: {} });
  });

  it("is a no-op without assistant settings or a legacy modelId", () => {
    expect(run(undefined).store.set).not.toHaveBeenCalled();
    expect(run({ docSearch: true }).store.set).not.toHaveBeenCalled();
    expect(run({ modelIds: { claude: "opus" } }).store.set).not.toHaveBeenCalled();
  });

  it("is a no-op on replay", () => {
    const first = run({ modelId: "opus" }).after;
    const { store, after } = run(first);
    expect(store.set).not.toHaveBeenCalled();
    expect(after).toEqual({ modelIds: { claude: "opus" } });
  });
});
