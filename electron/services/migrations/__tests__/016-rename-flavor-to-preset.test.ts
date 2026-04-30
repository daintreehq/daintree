import { describe, expect, it, vi } from "vitest";
import { migration016 } from "../016-rename-flavor-to-preset.js";

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
  } as unknown as Parameters<typeof migration016.up>[0] & {
    _data: Record<string, unknown>;
  };
}

describe("migration016 — rename flavor to preset", () => {
  it("has version 16", () => {
    expect(migration016.version).toBe(16);
  });

  it("renames flavorId to presetId in each agent entry", () => {
    const data: Record<string, unknown> = {
      agentSettings: {
        agents: {
          claude: { flavorId: "ccr-route-a", pinned: true },
          gemini: { flavorId: "custom-1", dangerousEnabled: true },
        },
      },
    };
    const store = makeStoreMock(data);
    migration016.up(store);
    const after = data.agentSettings as {
      agents: Record<string, Record<string, unknown>>;
    };
    expect(after.agents.claude.presetId).toBe("ccr-route-a");
    expect(after.agents.claude.pinned).toBe(true);
    expect("flavorId" in after.agents.claude).toBe(false);
    expect(after.agents.gemini.presetId).toBe("custom-1");
    expect(after.agents.gemini.dangerousEnabled).toBe(true);
  });

  it("renames customFlavors to customPresets", () => {
    const customFlavors = [
      { id: "c1", name: "Custom 1" },
      { id: "c2", name: "Custom 2" },
    ];
    const data: Record<string, unknown> = {
      agentSettings: {
        agents: {
          claude: { customFlavors, customFlags: "--verbose" },
        },
      },
    };
    const store = makeStoreMock(data);
    migration016.up(store);
    const after = data.agentSettings as {
      agents: Record<string, Record<string, unknown>>;
    };
    expect(after.agents.claude.customPresets).toEqual(customFlavors);
    expect("customFlavors" in after.agents.claude).toBe(false);
    expect(after.agents.claude.customFlags).toBe("--verbose");
  });

  it("handles both fields simultaneously", () => {
    const data: Record<string, unknown> = {
      agentSettings: {
        agents: {
          claude: {
            flavorId: "ccr-a",
            customFlavors: [{ id: "x" }],
            pinned: true,
          },
        },
      },
    };
    const store = makeStoreMock(data);
    migration016.up(store);
    const after = data.agentSettings as {
      agents: Record<string, Record<string, unknown>>;
    };
    expect(after.agents.claude.presetId).toBe("ccr-a");
    expect(after.agents.claude.customPresets).toEqual([{ id: "x" }]);
    expect(after.agents.claude.pinned).toBe(true);
    expect("flavorId" in after.agents.claude).toBe(false);
    expect("customFlavors" in after.agents.claude).toBe(false);
  });

  it("is idempotent — running twice leaves already-migrated data intact", () => {
    const data: Record<string, unknown> = {
      agentSettings: {
        agents: {
          claude: { flavorId: "ccr-a", pinned: true },
        },
      },
    };
    const store = makeStoreMock(data);
    migration016.up(store);
    migration016.up(store);
    const after = data.agentSettings as {
      agents: Record<string, Record<string, unknown>>;
    };
    expect(after.agents.claude.presetId).toBe("ccr-a");
    expect("flavorId" in after.agents.claude).toBe(false);
    expect(after.agents.claude.pinned).toBe(true);
  });

  it("skips undefined fields — no presetId written when flavorId absent", () => {
    const data: Record<string, unknown> = {
      agentSettings: {
        agents: {
          claude: { pinned: true, customFlags: "" },
        },
      },
    };
    const store = makeStoreMock(data);
    migration016.up(store);
    const after = data.agentSettings as {
      agents: Record<string, Record<string, unknown>>;
    };
    expect("presetId" in after.agents.claude).toBe(false);
    expect("customPresets" in after.agents.claude).toBe(false);
    expect(after.agents.claude.pinned).toBe(true);
  });

  it("no-op when agentSettings is missing", () => {
    const data: Record<string, unknown> = {};
    const store = makeStoreMock(data);
    expect(() => migration016.up(store)).not.toThrow();
    expect(store.set).not.toHaveBeenCalled();
  });

  it("no-op when agents map is empty", () => {
    const data: Record<string, unknown> = {
      agentSettings: { agents: {} },
    };
    const store = makeStoreMock(data);
    migration016.up(store);
    const after = data.agentSettings as { agents: Record<string, unknown> };
    expect(after.agents).toEqual({});
  });

  it("preserves top-level agentSettings fields other than agents", () => {
    const data: Record<string, unknown> = {
      agentSettings: {
        agents: { claude: { flavorId: "x" } },
        extraField: "keep-me",
      },
    };
    const store = makeStoreMock(data);
    migration016.up(store);
    const after = data.agentSettings as {
      agents: Record<string, Record<string, unknown>>;
      extraField: string;
    };
    expect(after.extraField).toBe("keep-me");
    expect(after.agents.claude.presetId).toBe("x");
  });

  it("prefers existing presetId over legacy flavorId when both are present", () => {
    const data: Record<string, unknown> = {
      agentSettings: {
        agents: {
          claude: { flavorId: "legacy-value", presetId: "new-value", pinned: true },
          gemini: {
            customFlavors: [{ id: "old" }],
            customPresets: [{ id: "new" }],
          },
        },
      },
    };
    const store = makeStoreMock(data);
    migration016.up(store);
    const after = data.agentSettings as {
      agents: Record<string, Record<string, unknown>>;
    };
    expect(after.agents.claude.presetId).toBe("new-value");
    expect("flavorId" in after.agents.claude).toBe(false);
    expect(after.agents.claude.pinned).toBe(true);
    expect(after.agents.gemini.customPresets).toEqual([{ id: "new" }]);
    expect("customFlavors" in after.agents.gemini).toBe(false);
  });

  it("does not throw on malformed shapes", () => {
    const shapes: Array<[string, unknown]> = [
      ["agentSettings null", null],
      ["agentSettings array", []],
      ["agentSettings string", "nope"],
      ["agentSettings without agents", { foo: "bar" }],
      ["agents not an object", { agents: "broken" }],
    ];
    for (const [label, value] of shapes) {
      const store = makeStoreMock({ agentSettings: value });
      expect(() => migration016.up(store), `case: ${label}`).not.toThrow();
    }
  });
});
