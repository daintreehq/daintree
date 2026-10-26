import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { migration038 } from "../038-device-agent-toolbar-pins.js";

function run(initial: Record<string, unknown>, times = 1) {
  const data: Record<string, unknown> = structuredClone(initial);
  const store = {
    get: vi.fn((key: string) => structuredClone(data[key])),
    set: vi.fn((key: string, value: unknown) => {
      data[key] = value;
    }),
  } as unknown as Parameters<typeof migration038.up>[0];
  for (let i = 0; i < times; i++) migration038.up(store);
  return { data, store };
}

describe("migration038 — toolbar agent pins move onto this machine (#14702)", () => {
  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("carries explicit pins over unchanged and leaves unset pins unset", () => {
    const { data } = run({
      agentSettings: {
        settingsVersion: 2,
        agents: {
          claude: { pinned: true, customFlags: "--verbose" },
          gemini: { pinned: false },
          codex: { customFlags: "" },
        },
      },
    });

    expect(data.agentToolbarPins).toEqual({ claude: true, gemini: false });
  });

  it("carries pins from a store at settingsVersion 1, the first that showed them", () => {
    const { data } = run({
      agentSettings: { settingsVersion: 1, agents: { claude: { pinned: false } } },
    });

    expect(data.agentToolbarPins).toEqual({ claude: false });
  });

  it("strips the pin from agent settings and keeps every execution setting", () => {
    const { data } = run({
      agentSettings: {
        settingsVersion: 1,
        globalSkipPermissions: true,
        agents: {
          claude: { pinned: true, customFlags: "--verbose", presetId: "fast" },
          codex: { customFlags: "" },
        },
      },
    });

    expect(data.agentSettings).toEqual({
      settingsVersion: 1,
      globalSkipPermissions: true,
      agents: {
        claude: { customFlags: "--verbose", presetId: "fast" },
        codex: { customFlags: "" },
      },
    });
  });

  it("keeps pins for agents this machine doesn't have installed or registered", () => {
    const { data } = run({
      agentSettings: { settingsVersion: 2, agents: { "some-user-agent": { pinned: true } } },
    });

    expect(data.agentToolbarPins).toEqual({ "some-user-agent": true });
  });

  it("drops pins from a store below settingsVersion 1, which never showed them", () => {
    // The renderer cleared these on every load (#7673), so the toolbar fell back
    // to its default for every agent; carrying them over would change it.
    const { data } = run({
      agentSettings: { agents: { claude: { pinned: true }, gemini: { pinned: false } } },
    });

    expect(data.agentToolbarPins).toEqual({});
    expect(data.agentSettings).toEqual({ agents: { claude: {}, gemini: {} } });
  });

  it("writes an empty pin map for a profile with no agent settings, so it never seeds", () => {
    const { data } = run({});

    expect(data.agentToolbarPins).toEqual({});
    expect(data).not.toHaveProperty("agentSettings");
  });

  it("never overwrites pins already on this machine, but still strips the source", () => {
    const { data } = run({
      agentToolbarPins: {},
      agentSettings: { settingsVersion: 2, agents: { claude: { pinned: true } } },
    });

    expect(data.agentToolbarPins).toEqual({});
    expect(data.agentSettings).toEqual({ settingsVersion: 2, agents: { claude: {} } });
  });

  it("is a no-op the second time", () => {
    const initial = {
      agentSettings: {
        settingsVersion: 2,
        agents: { claude: { pinned: true }, gemini: { pinned: false, customFlags: "-x" } },
      },
    };
    const once = run(initial).data;
    const twice = run(initial, 2);

    expect(twice.data).toEqual(once);
    // The replay writes nothing: the pins exist and no source pin is left.
    expect(twice.store.set).toHaveBeenCalledTimes(2);
  });

  it("ignores non-boolean pins and malformed entries without inventing intent", () => {
    const { data } = run({
      agentSettings: {
        settingsVersion: 2,
        agents: {
          claude: { pinned: "yes" },
          gemini: null,
          codex: ["not", "an", "entry"],
          aider: { pinned: false },
        },
      },
    });

    expect(data.agentToolbarPins).toEqual({ aider: false });
    expect((data.agentSettings as { agents: Record<string, unknown> }).agents).toEqual({
      claude: {},
      gemini: null,
      codex: ["not", "an", "entry"],
      aider: {},
    });
  });
});
