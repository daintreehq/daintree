import { describe, expect, it, vi } from "vitest";
import { migration013 } from "../013-cleanup-phantom-pins.js";

function makeStoreMock(data: Record<string, unknown>) {
  return {
    get: vi.fn((key: string) => data[key]),
    set: vi.fn((key: string, value: unknown) => {
      data[key] = value;
    }),
  } as unknown as Parameters<typeof migration013.up>[0];
}

describe("migration013 — cleanup phantom pinned entries", () => {
  it("has version 13", () => {
    expect(migration013.version).toBe(13);
  });

  it("removes entries that have only `{ pinned: true }`", () => {
    const data: Record<string, unknown> = {
      agentSettings: {
        agents: {
          opencode: { pinned: true },
          cursor: { pinned: true },
          claude: { pinned: true, customFlags: "--verbose" },
        },
      },
    };
    const store = makeStoreMock(data);
    migration013.up(store);

    expect(store.set).toHaveBeenCalledWith("agentSettings", {
      agents: { claude: { pinned: true, customFlags: "--verbose" } },
    });
  });

  it("preserves `{ pinned: true }` when any additional field is present", () => {
    const cases: Array<[string, Record<string, unknown>]> = [
      ["customFlags", { pinned: true, customFlags: "" }],
      ["dangerousEnabled", { pinned: true, dangerousEnabled: false }],
      ["primaryModelId null", { pinned: true, primaryModelId: null }],
      ["shareClipboardDirectory", { pinned: true, shareClipboardDirectory: false }],
      ["inlineMode", { pinned: true, inlineMode: false }],
    ];

    for (const [label, entry] of cases) {
      const data: Record<string, unknown> = {
        agentSettings: { agents: { claude: entry } },
      };
      const store = makeStoreMock(data);
      migration013.up(store);
      // No phantoms found, no write expected.
      expect(store.set, `case: ${label}`).not.toHaveBeenCalled();
    }
  });

  it("preserves explicit `pinned: false` entries", () => {
    const data: Record<string, unknown> = {
      agentSettings: { agents: { gemini: { pinned: false } } },
    };
    const store = makeStoreMock(data);
    migration013.up(store);
    expect(store.set).not.toHaveBeenCalled();
  });

  it("preserves entries whose sole field is NOT `pinned: true`", () => {
    const data: Record<string, unknown> = {
      agentSettings: { agents: { codex: { customFlags: "--debug" } } },
    };
    const store = makeStoreMock(data);
    migration013.up(store);
    expect(store.set).not.toHaveBeenCalled();
  });

  it("is a no-op when agentSettings is absent", () => {
    const store = makeStoreMock({});
    migration013.up(store);
    expect(store.set).not.toHaveBeenCalled();
  });

  it("is a no-op when agentSettings has no agents", () => {
    const store = makeStoreMock({ agentSettings: {} });
    migration013.up(store);
    expect(store.set).not.toHaveBeenCalled();
  });

  it("is a no-op when agents is empty", () => {
    const store = makeStoreMock({ agentSettings: { agents: {} } });
    migration013.up(store);
    expect(store.set).not.toHaveBeenCalled();
  });

  it("preserves unrelated top-level keys on agentSettings", () => {
    const data: Record<string, unknown> = {
      agentSettings: {
        defaultAgent: "claude",
        agents: {
          opencode: { pinned: true },
          claude: { pinned: true, customFlags: "--verbose" },
        },
      },
    };
    const store = makeStoreMock(data);
    migration013.up(store);

    expect(store.set).toHaveBeenCalledWith("agentSettings", {
      defaultAgent: "claude",
      agents: { claude: { pinned: true, customFlags: "--verbose" } },
    });
  });

  it("is idempotent — running twice yields the same result and no second write", () => {
    const data: Record<string, unknown> = {
      agentSettings: {
        agents: {
          opencode: { pinned: true },
          claude: { pinned: true, customFlags: "--verbose" },
        },
      },
    };
    const store = makeStoreMock(data);
    migration013.up(store);
    expect(store.set).toHaveBeenCalledTimes(1);

    // Second run: no phantoms left, so no further writes.
    migration013.up(store);
    expect(store.set).toHaveBeenCalledTimes(1);
  });

  it("does not throw on malformed agentSettings shapes", () => {
    const shapes: Array<[string, unknown]> = [
      ["agents is null", { agents: null }],
      ["agents is a string", { agents: "oops" }],
      ["agents is an array", { agents: [] }],
      ["an entry is null", { agents: { claude: null } }],
      ["an entry is a string", { agents: { claude: "oops" } }],
      ["agentSettings is a string", "nope"],
      ["agentSettings is an array", []],
    ];

    for (const [label, value] of shapes) {
      const store = makeStoreMock({ agentSettings: value });
      expect(() => migration013.up(store), `case: ${label}`).not.toThrow();
    }
  });

  it("preserves malformed non-phantom entries untouched", () => {
    // A corrupted entry like `null` is not phantom (predicate requires an
    // object) and not our problem to repair — it should pass through
    // alongside any phantom-stripping that happens.
    const data: Record<string, unknown> = {
      agentSettings: {
        agents: {
          opencode: { pinned: true },
          broken: null,
          claude: { pinned: true, customFlags: "" },
        },
      },
    };
    const store = makeStoreMock(data);
    migration013.up(store);

    const written = (store.set as ReturnType<typeof vi.fn>).mock.calls[0][1] as {
      agents: Record<string, unknown>;
    };
    expect(Object.keys(written.agents).sort()).toEqual(["broken", "claude"]);
    expect(written.agents.broken).toBeNull();
  });

  it("removes multiple phantoms in one call", () => {
    const data: Record<string, unknown> = {
      agentSettings: {
        agents: {
          opencode: { pinned: true },
          cursor: { pinned: true },
          kira: { pinned: true },
          copilot: { pinned: true },
          claude: { pinned: true, customFlags: "" },
        },
      },
    };
    const store = makeStoreMock(data);
    migration013.up(store);

    const written = (store.set as ReturnType<typeof vi.fn>).mock.calls[0][1] as {
      agents: Record<string, unknown>;
    };
    expect(Object.keys(written.agents).sort()).toEqual(["claude"]);
  });
});
