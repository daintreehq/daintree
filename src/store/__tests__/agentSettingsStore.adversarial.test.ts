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
import { useCliAvailabilityStore } from "../cliAvailabilityStore";
import type { CliAvailability } from "@shared/types";

function setAvailability(
  overrides: Partial<Record<string, "ready" | "installed" | "missing">>,
  hasRealData = true
) {
  const availability = {
    claude: overrides.claude ?? "missing",
    codex: overrides.codex ?? "missing",
  } as unknown as CliAvailability;
  useCliAvailabilityStore.setState({ availability, hasRealData });
}

beforeEach(() => {
  vi.clearAllMocks();
  cleanupAgentSettingsStore();
  setAvailability({}, false);
});

afterEach(() => {
  cleanupAgentSettingsStore();
});

describe("agentSettingsStore adversarial", () => {
  it("normalizeAgentSelection preserves explicit pinned flags regardless of availability", () => {
    const before = {
      agents: {
        claude: { pinned: true, customFlags: "" },
        codex: { pinned: false, customFlags: "" },
      },
    } as never;

    const availability = { claude: "missing", codex: "ready" } as unknown as CliAvailability;
    const after = normalizeAgentSelection(before, availability, true);
    expect(after.agents.claude!.pinned).toBe(true);
    expect(after.agents.codex!.pinned).toBe(false);
  });

  it("normalizeAgentSelection returns the same reference when no changes are needed", () => {
    const settings = {
      agents: {
        claude: { pinned: true, enabled: true, flags: {} },
        codex: { pinned: false, enabled: true, flags: {} },
      },
    } as never;

    const availability = { claude: "ready", codex: "missing" } as unknown as CliAvailability;
    expect(normalizeAgentSelection(settings, availability, true)).toBe(settings);
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
    // Pre-populate every registered agent so normalizeAgentSelection has no
    // missing entries to seed — that way the store ends up with the exact
    // reference the client returned.
    const returned = {
      agents: {
        claude: { pinned: false, enabled: true, flags: {} },
        codex: { pinned: true, enabled: true, flags: {} },
      },
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

  it("initialize leaves pinned absent for entries without explicit pin when availability has no real data (issue #5158)", async () => {
    registryMock.getEffectiveAgentIds.mockReturnValue(["claude", "codex"]);
    setAvailability({ claude: "ready", codex: "missing" }, false);
    clientMock.get.mockResolvedValue({
      agents: {
        claude: { enabled: true, flags: {} },
        codex: { enabled: true, pinned: false, flags: {} },
      },
    });

    await useAgentSettingsStore.getState().initialize();

    const state = useAgentSettingsStore.getState();
    // hasRealData === false: pre-probe state means we do NOT phantom-synthesize
    // a default. The orchestrator re-runs normalization after availability lands.
    expect(state.settings?.agents.claude?.pinned).toBeUndefined();
    expect(state.settings?.agents.codex?.pinned).toBe(false);
  });

  it("initialize synthesizes pinned from availability for pre-existing entries (upgrader path)", async () => {
    registryMock.getEffectiveAgentIds.mockReturnValue(["claude", "codex"]);
    setAvailability({ claude: "ready", codex: "missing" }, true);
    clientMock.get.mockResolvedValue({
      agents: {
        claude: { enabled: true, flags: {} },
        codex: { enabled: true, flags: {} },
      },
    });

    await useAgentSettingsStore.getState().initialize();

    const state = useAgentSettingsStore.getState();
    // Existing entries (upgraders from 0.7.x) preserve the implicit pin:
    // installed/ready → true, missing → false. Only agents without any
    // persisted entry default to pinned:false under the new opt-in model.
    expect(state.settings?.agents.claude?.pinned).toBe(true);
    expect(state.settings?.agents.codex?.pinned).toBe(false);
  });

  it("getPinnedAgents returns only agents with explicit pinned: true (opt-in)", () => {
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
    // Missing `pinned` field no longer implies pinned — only explicit `true`.
    expect(getPinnedAgents().sort()).toEqual(["a", "d"]);
  });

  it("stale refresh result does not overwrite a newer snapshot", async () => {
    registryMock.getEffectiveAgentIds.mockReturnValue(["claude", "codex"]);
    setAvailability({ claude: "ready" }, true);

    // Seed initial state so `refresh` has something to overwrite.
    useAgentSettingsStore.setState({
      settings: { agents: { claude: { pinned: true, customFlags: "" } } } as never,
      isInitialized: true,
      isLoading: false,
    });

    let resolveStale: (v: unknown) => void = () => {};
    const stalePromise = new Promise((resolve) => {
      resolveStale = resolve;
    });
    clientMock.get
      .mockImplementationOnce(() => stalePromise)
      .mockResolvedValueOnce({
        agents: { claude: { pinned: false, customFlags: "fresh" } },
      });

    const refreshA = useAgentSettingsStore.getState().refresh();
    const refreshB = useAgentSettingsStore.getState().refresh();
    await refreshB;

    // Now let the stale (first) refresh resolve — it must not clobber B's result.
    resolveStale({ agents: { claude: { pinned: true, customFlags: "stale" } } });
    await refreshA;

    const state = useAgentSettingsStore.getState();
    expect(state.settings?.agents.claude).toEqual({ pinned: false, customFlags: "fresh" });
  });

  it("cleanup during an in-flight refresh invalidates the result", async () => {
    registryMock.getEffectiveAgentIds.mockReturnValue(["claude"]);
    setAvailability({ claude: "ready" }, true);

    useAgentSettingsStore.setState({
      settings: null,
      isInitialized: true,
      isLoading: false,
    });

    let resolveGet: (v: unknown) => void = () => {};
    clientMock.get.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveGet = resolve;
        })
    );

    const pending = useAgentSettingsStore.getState().refresh();

    cleanupAgentSettingsStore();

    resolveGet({ agents: { claude: { pinned: true, customFlags: "hello" } } });
    await pending;

    // cleanupAgentSettingsStore resets `settings` to DEFAULT_AGENT_SETTINGS;
    // the invalidated refresh result must not have overwritten that.
    const state = useAgentSettingsStore.getState();
    expect(state.isInitialized).toBe(false);
    expect(state.settings?.agents.claude?.customFlags).not.toBe("hello");
  });

  it("stale refresh failures yield silently instead of throwing unhandled rejections", async () => {
    registryMock.getEffectiveAgentIds.mockReturnValue(["claude"]);
    setAvailability({ claude: "ready" }, true);

    useAgentSettingsStore.setState({
      settings: { agents: { claude: { pinned: true } } } as never,
      isInitialized: true,
      isLoading: false,
    });

    let rejectStale: (e: unknown) => void = () => {};
    clientMock.get
      .mockImplementationOnce(
        () =>
          new Promise((_resolve, reject) => {
            rejectStale = reject;
          })
      )
      .mockResolvedValueOnce({ agents: { claude: { pinned: false } } });

    const stale = useAgentSettingsStore.getState().refresh();
    const fresh = useAgentSettingsStore.getState().refresh();
    await fresh;

    // Now fail the stale attempt. It must NOT reject — fire-and-forget
    // callers (orchestrator subscription, toggle handlers) would surface an
    // unhandled rejection otherwise.
    rejectStale(new Error("stale failure"));
    await expect(stale).resolves.toBeUndefined();

    expect(useAgentSettingsStore.getState().settings?.agents.claude?.pinned).toBe(false);
  });

  describe("updateWorktreePreset", () => {
    it("spreads existing worktree keys so sibling entries are preserved", async () => {
      useAgentSettingsStore.setState({
        settings: {
          agents: {
            claude: {
              pinned: true,
              worktreePresets: { "wt-A": "user-111", "wt-B": "user-222" },
            },
          },
        } as never,
        isInitialized: true,
        isLoading: false,
      });
      clientMock.set.mockImplementation(
        async (_agentId: string, updates: Record<string, unknown>) => ({
          agents: {
            claude: {
              pinned: true,
              worktreePresets: updates.worktreePresets,
            },
          },
        })
      );

      await useAgentSettingsStore.getState().updateWorktreePreset("claude", "wt-A", "user-new");

      expect(clientMock.set).toHaveBeenCalledWith("claude", {
        worktreePresets: { "wt-A": "user-new", "wt-B": "user-222" },
      });
    });

    it("deletes the target key when presetId is undefined", async () => {
      useAgentSettingsStore.setState({
        settings: {
          agents: {
            claude: {
              worktreePresets: { "wt-A": "user-111", "wt-B": "user-222" },
            },
          },
        } as never,
        isInitialized: true,
        isLoading: false,
      });
      clientMock.set.mockResolvedValue({
        agents: { claude: { worktreePresets: { "wt-B": "user-222" } } },
      });

      await useAgentSettingsStore.getState().updateWorktreePreset("claude", "wt-A", undefined);

      expect(clientMock.set).toHaveBeenCalledWith("claude", {
        worktreePresets: { "wt-B": "user-222" },
      });
    });

    it("collapses an empty map to undefined when the last key is removed", async () => {
      useAgentSettingsStore.setState({
        settings: {
          agents: { claude: { worktreePresets: { "wt-A": "user-111" } } },
        } as never,
        isInitialized: true,
        isLoading: false,
      });
      clientMock.set.mockResolvedValue({ agents: { claude: {} } });

      await useAgentSettingsStore.getState().updateWorktreePreset("claude", "wt-A", undefined);

      expect(clientMock.set).toHaveBeenCalledWith("claude", {
        worktreePresets: undefined,
      });
    });

    it("creates the map when the entry has no prior worktreePresets", async () => {
      useAgentSettingsStore.setState({
        settings: { agents: { claude: { pinned: true } } } as never,
        isInitialized: true,
        isLoading: false,
      });
      clientMock.set.mockResolvedValue({
        agents: { claude: { pinned: true, worktreePresets: { "wt-A": "user-111" } } },
      });

      await useAgentSettingsStore.getState().updateWorktreePreset("claude", "wt-A", "user-111");

      expect(clientMock.set).toHaveBeenCalledWith("claude", {
        worktreePresets: { "wt-A": "user-111" },
      });
    });

    it("no-ops silently when worktreeId is an empty string", async () => {
      useAgentSettingsStore.setState({
        settings: { agents: { claude: {} } } as never,
        isInitialized: true,
        isLoading: false,
      });

      await useAgentSettingsStore.getState().updateWorktreePreset("claude", "", "user-111");

      expect(clientMock.set).not.toHaveBeenCalled();
    });
  });

  it("initialize after a concurrent refresh flips isInitialized even when the result is stale", async () => {
    registryMock.getEffectiveAgentIds.mockReturnValue(["claude"]);
    setAvailability({ claude: "ready" }, true);

    let resolveInit: (v: unknown) => void = () => {};
    clientMock.get
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveInit = resolve;
          })
      )
      .mockResolvedValueOnce({ agents: { claude: { pinned: false } } });

    // Kick off init; it holds initPromise. While in-flight, another caller
    // triggers a refresh (bumping the epoch and invalidating init).
    const initPending = useAgentSettingsStore.getState().initialize();
    useAgentSettingsStore.setState({ isInitialized: false, isLoading: true });
    const concurrent = useAgentSettingsStore.getState().refresh();
    await concurrent;

    resolveInit({ agents: { claude: { pinned: true } } });
    await initPending;

    // Stale init must still flip isInitialized and clear initPromise so
    // subsequent `initialize()` calls short-circuit (no-op) correctly.
    const state = useAgentSettingsStore.getState();
    expect(state.isInitialized).toBe(true);
    expect(state.isLoading).toBe(false);
  });
});
