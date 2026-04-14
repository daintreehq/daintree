// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const clientMock = vi.hoisted(() => ({
  get: vi.fn(),
  set: vi.fn(),
  reset: vi.fn(),
}));

const registryMock = vi.hoisted(() => ({
  getEffectiveAgentIds: vi.fn(() => ["claude", "codex"]),
}));

vi.mock("@/clients", () => ({ agentSettingsClient: clientMock }));

vi.mock("../../../shared/config/agentRegistry", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../shared/config/agentRegistry")>();
  return { ...actual, getEffectiveAgentIds: registryMock.getEffectiveAgentIds };
});

import {
  useAgentSettingsStore,
  cleanupAgentSettingsStore,
  getPinnedAgents,
  normalizeAgentSelection,
} from "../agentSettingsStore";

beforeEach(() => {
  vi.clearAllMocks();
  cleanupAgentSettingsStore();
});

afterEach(() => {
  cleanupAgentSettingsStore();
});

describe("agentSettingsStore adversarial", () => {
  it("normalizeAgentSelection seeds pinned:false on entries missing the flag", () => {
    const before = {
      agents: {
        claude: {
          enabled: true,
          selected: true,
          toolbarPinned: true,
          primaryModelId: null,
          autoCompact: true,
          defaultMethodIndex: 0,
          customCommand: null,
          flags: {},
        },
        codex: {
          enabled: true,
          selected: false,
          toolbarPinned: false,
          primaryModelId: null,
          autoCompact: true,
          defaultMethodIndex: 0,
          customCommand: null,
          pinned: true,
          flags: {},
        },
      },
    };

    const after = normalizeAgentSelection(before as never);
    expect(after.agents.claude.pinned).toBe(false);
    expect(after.agents.codex.pinned).toBe(true);
  });

  it("normalizeAgentSelection returns the same reference when no changes are needed", () => {
    const settings = {
      agents: {
        claude: { pinned: true, enabled: true, flags: {} },
        codex: { pinned: false, enabled: true, flags: {} },
      },
    } as never;

    expect(normalizeAgentSelection(settings)).toBe(settings);
  });

  it("concurrent initialize() calls dedupe into a single client fetch", async () => {
    let resolveGet: (v: unknown) => void = () => {};
    clientMock.get.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveGet = resolve;
        })
    );

    const p1 = useAgentSettingsStore.getState().initialize();
    const p2 = useAgentSettingsStore.getState().initialize();

    expect(clientMock.get).toHaveBeenCalledTimes(1);

    resolveGet({ agents: { claude: { pinned: true, enabled: true, flags: {} } } });
    await Promise.all([p1, p2]);

    expect(useAgentSettingsStore.getState().isInitialized).toBe(true);
  });

  it("initialize() after completion is a no-op", async () => {
    clientMock.get.mockResolvedValue({ agents: {} });
    await useAgentSettingsStore.getState().initialize();
    expect(clientMock.get).toHaveBeenCalledTimes(1);

    await useAgentSettingsStore.getState().initialize();
    expect(clientMock.get).toHaveBeenCalledTimes(1);
  });

  it("initialize() failure still flips isInitialized and records the error", async () => {
    clientMock.get.mockRejectedValue(new Error("IPC down"));

    await useAgentSettingsStore.getState().initialize();

    const state = useAgentSettingsStore.getState();
    expect(state.isInitialized).toBe(true);
    expect(state.isLoading).toBe(false);
    expect(state.error).toBe("IPC down");
  });

  it("updateAgent failure preserves previous settings and surfaces the error", async () => {
    const priorSettings = {
      agents: { claude: { pinned: true, enabled: true, flags: {} } },
    } as never;
    useAgentSettingsStore.setState({
      settings: priorSettings,
      isInitialized: true,
      isLoading: false,
      error: null,
    });

    clientMock.set.mockRejectedValue(new Error("write failed"));

    await expect(
      useAgentSettingsStore.getState().updateAgent("claude", { pinned: false })
    ).rejects.toThrow("write failed");

    const state = useAgentSettingsStore.getState();
    expect(state.settings).toBe(priorSettings);
    expect(state.error).toBe("write failed");
  });

  it("reset(agentId) forwards the id argument and stores the returned settings", async () => {
    const returned = {
      agents: { claude: { pinned: false, enabled: true, flags: {} } },
    } as never;
    clientMock.reset.mockResolvedValue(returned);

    await useAgentSettingsStore.getState().reset("claude");

    expect(clientMock.reset).toHaveBeenCalledWith("claude");
    expect(useAgentSettingsStore.getState().settings).toBe(returned);
  });

  it("cleanupAgentSettingsStore fully resets the init guard so re-initialize hits the client again", async () => {
    clientMock.get.mockResolvedValue({ agents: {} });
    await useAgentSettingsStore.getState().initialize();
    expect(clientMock.get).toHaveBeenCalledTimes(1);

    cleanupAgentSettingsStore();
    expect(useAgentSettingsStore.getState().isInitialized).toBe(false);

    await useAgentSettingsStore.getState().initialize();
    expect(clientMock.get).toHaveBeenCalledTimes(2);
  });

  it("getPinnedAgents returns [] when settings are null", () => {
    useAgentSettingsStore.setState({ settings: null });
    expect(getPinnedAgents()).toEqual([]);
  });

  it("initialize applies normalizeAgentSelection so missing pinned flags are seeded in memory", async () => {
    registryMock.getEffectiveAgentIds.mockReturnValue(["claude", "codex"]);
    clientMock.get.mockResolvedValue({
      agents: {
        claude: { enabled: true, flags: {} },
        codex: { enabled: true, pinned: true, flags: {} },
      },
    });

    await useAgentSettingsStore.getState().initialize();

    const state = useAgentSettingsStore.getState();
    expect(state.settings?.agents.claude?.pinned).toBe(false);
    expect(state.settings?.agents.codex?.pinned).toBe(true);
  });

  it("getPinnedAgents returns only agents with explicit pinned:true", () => {
    useAgentSettingsStore.setState({
      settings: {
        agents: {
          a: { pinned: true },
          b: { pinned: false },
          c: {},
          d: { pinned: true },
        },
      } as never,
    });
    expect(getPinnedAgents().sort()).toEqual(["a", "d"]);
  });
});
