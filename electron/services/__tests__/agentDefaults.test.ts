import { beforeEach, describe, expect, it, vi } from "vitest";

// A dotted-path store that behaves like conf: nested reads, writes and deletes,
// so presence ("never set") can be told apart from an explicit `null`.
const fakeStore = vi.hoisted(() => {
  let data: Record<string, unknown> = {};
  const walk = (key: string, create: boolean) => {
    const segments = key.split(".");
    let node: Record<string, unknown> = data;
    for (const segment of segments.slice(0, -1)) {
      const next = node[segment];
      if (next === null || typeof next !== "object") {
        if (!create) return null;
        node[segment] = {};
      }
      node = node[segment] as Record<string, unknown>;
    }
    return { node, leaf: segments[segments.length - 1]! };
  };
  return {
    reset(initial: Record<string, unknown>) {
      data = structuredClone(initial);
    },
    dump: () => data,
    get: vi.fn((key: string) => {
      const target = walk(key, false);
      const value = target?.node[target.leaf];
      return value === undefined ? undefined : structuredClone(value);
    }),
    set: vi.fn((key: string, value: unknown) => {
      const target = walk(key, true)!;
      target.node[target.leaf] = structuredClone(value);
    }),
    delete: vi.fn((key: string) => {
      const target = walk(key, false);
      if (target) delete target.node[target.leaf];
    }),
  };
});

vi.mock("../../store.js", () => ({ store: fakeStore }));

const broadcastMock = vi.hoisted(() => vi.fn());
vi.mock("../../ipc/utils.js", () => ({ broadcastToRenderer: broadcastMock }));

import {
  migrateLegacyAgentDefaults,
  readAgentDefaults,
  restoreAgentDefaults,
  setAgentDefaults,
} from "../agentDefaults.js";

const FRESH = { helpAssistant: { tier: "core" }, agentSettings: { agents: {} } };

describe("agentDefaults", () => {
  beforeEach(() => {
    fakeStore.reset(FRESH);
    broadcastMock.mockClear();
  });

  it("reports a host that never had a default as absent, not cleared", () => {
    expect(readAgentDefaults()).toEqual({});
  });

  it("round-trips both defaults through their host-owned slots", () => {
    expect(setAgentDefaults({ assistantAgentId: "claude", defaultAgent: "codex" })).toBe(true);

    expect(readAgentDefaults()).toEqual({ assistantAgentId: "claude", defaultAgent: "codex" });
    const dump = fakeStore.dump() as {
      helpAssistant: Record<string, unknown>;
      agentSettings: Record<string, unknown>;
    };
    expect(dump.helpAssistant.agentId).toBe("claude");
    expect(dump.agentSettings.defaultAgent).toBe("codex");
    // The rest of each slot survives a leaf write.
    expect(dump.helpAssistant.tier).toBe("core");
    expect(dump.agentSettings.agents).toEqual({});
  });

  it("stores an explicit clear as null", () => {
    setAgentDefaults({ defaultAgent: null });
    expect(readAgentDefaults()).toEqual({ defaultAgent: null });
  });

  it("broadcasts the new snapshot once per real change and stays quiet on a no-op", () => {
    setAgentDefaults({ assistantAgentId: "claude" });
    expect(broadcastMock).toHaveBeenCalledTimes(1);
    expect(broadcastMock).toHaveBeenLastCalledWith("agent-defaults:changed", {
      assistantAgentId: "claude",
    });

    expect(setAgentDefaults({ assistantAgentId: "claude" })).toBe(false);
    expect(broadcastMock).toHaveBeenCalledTimes(1);
  });

  it("keeps an assistant agent whose CLI or registry entry isn't available", () => {
    setAgentDefaults({ assistantAgentId: "my-custom-agent" });
    expect(readAgentDefaults().assistantAgentId).toBe("my-custom-agent");
  });

  it("rejects values that aren't agents, leaving the stored ones alone", () => {
    setAgentDefaults({ assistantAgentId: "claude", defaultAgent: "codex" });
    broadcastMock.mockClear();

    expect(
      setAgentDefaults({
        assistantAgentId: "two words",
        defaultAgent: "not-a-built-in" as never,
      })
    ).toBe(false);
    expect(readAgentDefaults()).toEqual({ assistantAgentId: "claude", defaultAgent: "codex" });
    expect(broadcastMock).not.toHaveBeenCalled();
  });

  it("reads a corrupted stored value as cleared so it can't reopen migration", () => {
    fakeStore.reset({ ...FRESH, agentSettings: { agents: {}, defaultAgent: 42 } });
    expect(readAgentDefaults()).toEqual({ defaultAgent: null });
    migrateLegacyAgentDefaults({ defaultAgent: "claude" });
    expect(readAgentDefaults()).toEqual({ defaultAgent: null });
  });

  it("ignores payloads that aren't a plain object of known leaves", () => {
    const hostile = JSON.parse('{"__proto__": {"assistantAgentId": "claude"}}') as object;
    const inherited = Object.create({ assistantAgentId: "claude" }) as object;
    const array = Object.assign([], { assistantAgentId: "claude" });

    for (const payload of [null, "claude", 7, array, hostile, inherited]) {
      expect(setAgentDefaults(payload as never)).toBe(false);
      migrateLegacyAgentDefaults(payload as never);
    }

    expect(readAgentDefaults()).toEqual({});
    expect(broadcastMock).not.toHaveBeenCalled();
  });

  it("still tells every window about a leaf that landed before a later write threw", () => {
    const write = fakeStore.set.getMockImplementation()!;
    fakeStore.set.mockImplementationOnce(write).mockImplementationOnce(() => {
      throw new Error("disk full");
    });

    expect(() => setAgentDefaults({ assistantAgentId: "claude", defaultAgent: "codex" })).toThrow(
      "disk full"
    );
    expect(broadcastMock).toHaveBeenCalledWith("agent-defaults:changed", {
      assistantAgentId: "claude",
    });
  });

  describe("migrateLegacyAgentDefaults", () => {
    it("lands each candidate on a host that never had one", () => {
      const result = migrateLegacyAgentDefaults({ assistantAgentId: "claude", defaultAgent: null });
      expect(result).toEqual({ assistantAgentId: "claude", defaultAgent: null });
      expect(broadcastMock).toHaveBeenCalledTimes(1);
    });

    it("never overwrites a host value, including an explicit clear", () => {
      setAgentDefaults({ assistantAgentId: "codex", defaultAgent: null });
      broadcastMock.mockClear();

      const result = migrateLegacyAgentDefaults({
        assistantAgentId: "claude",
        defaultAgent: "gemini",
      });

      expect(result).toEqual({ assistantAgentId: "codex", defaultAgent: null });
      expect(broadcastMock).not.toHaveBeenCalled();
    });

    it("lands only once when two views migrate", () => {
      migrateLegacyAgentDefaults({ assistantAgentId: "claude" });
      const second = migrateLegacyAgentDefaults({ assistantAgentId: "codex" });
      expect(second.assistantAgentId).toBe("claude");
    });

    it("treats an omitted candidate as nothing to move, never as a clear", () => {
      expect(migrateLegacyAgentDefaults({ defaultAgent: "codex" })).toEqual({
        defaultAgent: "codex",
      });
      expect(readAgentDefaults()).not.toHaveProperty("assistantAgentId");
    });
  });

  describe("restoreAgentDefaults", () => {
    it("deletes a leaf the snapshot lacked, so the host is unset again", () => {
      setAgentDefaults({ assistantAgentId: "claude", defaultAgent: "codex" });
      restoreAgentDefaults({ defaultAgent: "codex" });
      expect(readAgentDefaults()).toEqual({ defaultAgent: "codex" });
    });

    it("puts back values and clears exactly as the snapshot had them", () => {
      setAgentDefaults({ assistantAgentId: "claude" });
      restoreAgentDefaults({ assistantAgentId: "codex", defaultAgent: null });
      expect(readAgentDefaults()).toEqual({ assistantAgentId: "codex", defaultAgent: null });
    });
  });
});
