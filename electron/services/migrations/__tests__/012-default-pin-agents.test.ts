import { describe, expect, it, vi } from "vitest";
import { migration012 } from "../012-default-pin-agents.js";

function makeStoreMock(data: Record<string, unknown>) {
  return {
    get: vi.fn((key: string) => data[key]),
    set: vi.fn((key: string, value: unknown) => {
      data[key] = value;
    }),
  } as unknown as Parameters<typeof migration012.up>[0];
}

describe("migration012 — default-pin agents", () => {
  it("has version 12", () => {
    expect(migration012.version).toBe(12);
  });

  it("converts selected: true → pinned: true and removes selected/enabled keys", () => {
    const data: Record<string, unknown> = {
      agentSettings: {
        agents: { claude: { selected: true, customFlags: "--verbose" } },
      },
    };
    const store = makeStoreMock(data);
    migration012.up(store);

    expect(store.set).toHaveBeenCalledWith("agentSettings", {
      agents: { claude: { pinned: true, customFlags: "--verbose" } },
    });
  });

  it("converts selected: false → pinned: false (preserve explicit unselect)", () => {
    const data: Record<string, unknown> = {
      agentSettings: { agents: { gemini: { selected: false } } },
    };
    const store = makeStoreMock(data);
    migration012.up(store);

    expect(store.set).toHaveBeenCalledWith("agentSettings", {
      agents: { gemini: { pinned: false } },
    });
  });

  it("converts selected: undefined → pinned: true (grandfather v0.6 visibility)", () => {
    const data: Record<string, unknown> = {
      agentSettings: { agents: { codex: { customFlags: "" } } },
    };
    const store = makeStoreMock(data);
    migration012.up(store);

    expect(store.set).toHaveBeenCalledWith("agentSettings", {
      agents: { codex: { pinned: true, customFlags: "" } },
    });
  });

  it("strips legacy enabled field alongside selected", () => {
    const data: Record<string, unknown> = {
      agentSettings: {
        agents: { claude: { enabled: false, selected: undefined, dangerousEnabled: true } },
      },
    };
    const store = makeStoreMock(data);
    migration012.up(store);

    const result = (store.set as ReturnType<typeof vi.fn>).mock.calls[0][1] as {
      agents: Record<string, Record<string, unknown>>;
    };
    expect(result.agents.claude).toEqual({ pinned: true, dangerousEnabled: true });
    expect(result.agents.claude).not.toHaveProperty("selected");
    expect(result.agents.claude).not.toHaveProperty("enabled");
  });

  it("is a no-op when agentSettings is absent", () => {
    const store = makeStoreMock({});
    migration012.up(store);
    expect(store.set).not.toHaveBeenCalled();
  });

  it("is a no-op when agentSettings has no agents", () => {
    const store = makeStoreMock({ agentSettings: {} });
    migration012.up(store);
    expect(store.set).not.toHaveBeenCalled();
  });

  it("replay leaves pinned: false untouched (regression guard)", () => {
    const data: Record<string, unknown> = {
      agentSettings: {
        agents: {
          claude: { pinned: true, customFlags: "--verbose" },
          gemini: { pinned: false },
        },
      },
    };
    const store = makeStoreMock(data);
    migration012.up(store);

    expect(store.set).not.toHaveBeenCalled();
    const after = data.agentSettings as { agents: Record<string, Record<string, unknown>> };
    expect(after.agents.claude).toEqual({ pinned: true, customFlags: "--verbose" });
    expect(after.agents.gemini).toEqual({ pinned: false });
  });

  it("does not crash on null/non-object entries (defensive)", () => {
    const data: Record<string, unknown> = {
      agentSettings: {
        agents: {
          claude: { selected: true },
          broken: null as unknown as Record<string, unknown>,
          alsoBroken: "not-an-object" as unknown as Record<string, unknown>,
        },
      },
    };
    const store = makeStoreMock(data);
    expect(() => migration012.up(store)).not.toThrow();

    const after = data.agentSettings as { agents: Record<string, unknown> };
    expect(after.agents.claude).toEqual({ pinned: true });
    expect(after.agents.broken).toBeNull();
    expect(after.agents.alsoBroken).toBe("not-an-object");
  });

  it("migrates legacy entries while leaving already-migrated entries untouched", () => {
    const data: Record<string, unknown> = {
      agentSettings: {
        agents: {
          claude: { pinned: false }, // already migrated, explicit unpin
          gemini: { selected: false }, // legacy, needs migration
          codex: { pinned: true, customFlags: "" }, // already migrated
        },
      },
    };
    const store = makeStoreMock(data);
    migration012.up(store);

    expect(store.set).toHaveBeenCalledTimes(1);
    const after = data.agentSettings as { agents: Record<string, Record<string, unknown>> };
    expect(after.agents.claude).toEqual({ pinned: false });
    expect(after.agents.gemini).toEqual({ pinned: false });
    expect(after.agents.codex).toEqual({ pinned: true, customFlags: "" });
  });
});
