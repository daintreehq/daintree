import { describe, expect, it, vi } from "vitest";
import { migration033 } from "../033-remove-retired-assistant-cli.js";

function run(initial: Record<string, unknown>) {
  const data: Record<string, unknown> = structuredClone(initial);
  const store = {
    get: vi.fn((key: string) => data[key]),
    set: vi.fn((key: string, value: unknown) => {
      data[key] = value;
    }),
  } as unknown as Parameters<typeof migration033.up>[0] & { set: ReturnType<typeof vi.fn> };
  migration033.up(store);
  return { store, data };
}

describe("migration033 — remove the retired assistant CLI's stored state", () => {
  it("has version 33", () => {
    expect(migration033.version).toBe(33);
  });

  it("turns a retired assistant choice into an explicit clear and drops what only it used", () => {
    const { data } = run({
      helpAssistant: {
        docSearch: true,
        tier: "core",
        agentId: "daintree-assistant",
        debugLogging: true,
        modelIds: { "daintree-assistant": "sonnet", claude: "opus" },
      },
      agentSettings: {
        defaultAgent: "claude",
        agents: { claude: { pinned: true }, "daintree-assistant": { pinned: false } },
      },
    });

    expect(data.helpAssistant).toEqual({
      docSearch: true,
      tier: "core",
      agentId: null,
      modelIds: { claude: "opus" },
    });
    expect(data.agentSettings).toEqual({
      defaultAgent: "claude",
      agents: { claude: { pinned: true } },
    });
  });

  it("leaves a live assistant choice, an explicit clear and an unset choice alone", () => {
    for (const agentId of ["codex", null, undefined]) {
      const helpAssistant = agentId === undefined ? { tier: "full" } : { tier: "full", agentId };
      const { store, data } = run({
        helpAssistant,
        agentSettings: { agents: { codex: { pinned: true } } },
      });
      expect(store.set).not.toHaveBeenCalled();
      expect(data.helpAssistant).toEqual(helpAssistant);
    }
  });

  it("drops debug logging on its own without touching the rest", () => {
    const { data } = run({
      helpAssistant: { tier: "core", agentId: "claude", debugLogging: false },
    });
    expect(data.helpAssistant).toEqual({ tier: "core", agentId: "claude" });
  });

  it("is a no-op when the slots are missing or malformed, and on a replay", () => {
    for (const initial of [
      {},
      { helpAssistant: "nope", agentSettings: [] },
      { agentSettings: { agents: null } },
    ]) {
      const { store } = run(initial);
      expect(store.set).not.toHaveBeenCalled();
    }

    const first = run({
      helpAssistant: { agentId: "daintree-assistant", debugLogging: true },
      agentSettings: { agents: { "daintree-assistant": {} } },
    });
    const replay = run(first.data);
    expect(replay.store.set).not.toHaveBeenCalled();
    expect(replay.data).toEqual(first.data);
  });
});
