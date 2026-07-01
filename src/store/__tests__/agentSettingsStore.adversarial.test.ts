// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const clientMock = vi.hoisted(() => ({
  get: vi.fn(),
  invalidate: vi.fn(),
  set: vi.fn(),
  setGlobal: vi.fn(),
  setGlobalInline: vi.fn(),
  reset: vi.fn(),
  stampVersion: vi.fn(),
}));

const registryMock = vi.hoisted(() => ({
  getEffectiveAgentIds: vi.fn(() => ["claude", "codex"]),
}));

const bootMock = vi.hoisted(() => ({
  getSafeBootPromise: vi.fn(async () => ({ ok: false as const, error: new Error("no boot") })),
}));

vi.mock("@/clients", () => ({ agentSettingsClient: clientMock }));

vi.mock("@/lib/bootPromise", () => ({ getSafeBootPromise: bootMock.getSafeBootPromise }));

vi.mock("../../../shared/config/agentRegistry", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../shared/config/agentRegistry")>();
  return { ...actual, getEffectiveAgentIds: registryMock.getEffectiveAgentIds };
});

import {
  useAgentSettingsStore,
  cleanupAgentSettingsStore,
  getPinnedAgents,
  normalizeAgentSelection,
  migrateAgentSettings,
} from "../agentSettingsStore";
import { useCliAvailabilityStore } from "../cliAvailabilityStore";
import { BUILT_IN_AGENT_IDS } from "../../../shared/config/agentIds";
import { DEFAULT_AGENT_SETTINGS, type CliAvailability } from "@shared/types";

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

    // initialize() consults the boot payload before the live client, so the
    // client fetch lands a few microtasks in — wait for it before asserting
    // the dedupe.
    await vi.waitFor(() => expect(clientMock.get).toHaveBeenCalledTimes(1));

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
    // missing entries to seed — and stamp the migration version so
    // migrateAgentSettings doesn't clone the response.
    const returned = {
      settingsVersion: 1,
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
      settingsVersion: 1,
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

  it("initialize leaves pinned undefined for upgrader entries — tri-state defers to availability at read time (#7673)", async () => {
    registryMock.getEffectiveAgentIds.mockReturnValue(["claude", "codex"]);
    setAvailability({ claude: "ready", codex: "missing" }, true);
    clientMock.get.mockResolvedValue({
      settingsVersion: 1,
      agents: {
        claude: { enabled: true, flags: {} },
        codex: { enabled: true, flags: {} },
      },
    });

    await useAgentSettingsStore.getState().initialize();

    const state = useAgentSettingsStore.getState();
    // The normalizer no longer materializes `pinned` from availability —
    // toolbar visibility resolves at read time via `isAgentToolbarVisible`.
    expect(state.settings?.agents.claude?.pinned).toBeUndefined();
    expect(state.settings?.agents.codex?.pinned).toBeUndefined();
  });

  it("initialize pins the first five installed built-ins for fresh default settings", async () => {
    registryMock.getEffectiveAgentIds.mockReturnValue(["claude", "codex"]);
    setAvailability({ claude: "ready", codex: "installed" }, true);
    clientMock.get.mockResolvedValue(DEFAULT_AGENT_SETTINGS);
    clientMock.set.mockResolvedValue({ agents: {} });
    clientMock.stampVersion.mockResolvedValue({ settingsVersion: 2, agents: {} });

    await useAgentSettingsStore.getState().initialize();

    const state = useAgentSettingsStore.getState();
    expect(state.settings?.settingsVersion).toBe(2);
    expect(state.settings?.agents.claude?.pinned).toBe(true);
    expect(state.settings?.agents.codex?.pinned).toBe(true);
    for (const id of BUILT_IN_AGENT_IDS.filter((id) => id !== "claude" && id !== "codex")) {
      expect(state.settings?.agents[id]?.pinned).toBe(false);
    }

    await Promise.resolve();
    await Promise.resolve();
    expect(clientMock.set).toHaveBeenCalledWith("claude", { pinned: true });
    expect(clientMock.set).toHaveBeenCalledWith("codex", { pinned: true });
    expect(clientMock.stampVersion).toHaveBeenCalledWith(2);
  });

  it("initialize recovers default-shaped settingsVersion 1 stores that missed first-run pinning", async () => {
    registryMock.getEffectiveAgentIds.mockReturnValue(["claude", "codex"]);
    setAvailability({ claude: "ready", codex: "installed" }, true);
    clientMock.get.mockResolvedValue({
      ...DEFAULT_AGENT_SETTINGS,
      settingsVersion: 1,
    });
    clientMock.set.mockResolvedValue({ agents: {} });
    clientMock.stampVersion.mockResolvedValue({ settingsVersion: 2, agents: {} });

    await useAgentSettingsStore.getState().initialize();

    const state = useAgentSettingsStore.getState();
    expect(state.settings?.settingsVersion).toBe(2);
    expect(state.settings?.agents.claude?.pinned).toBe(true);
    expect(state.settings?.agents.codex?.pinned).toBe(true);

    await Promise.resolve();
    await Promise.resolve();
    expect(clientMock.stampVersion).toHaveBeenCalledWith(2);
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
        settingsVersion: 1,
        agents: { claude: { pinned: false, customFlags: "fresh" } },
      });

    const refreshA = useAgentSettingsStore.getState().refresh();
    const refreshB = useAgentSettingsStore.getState().refresh();
    await refreshB;

    // Now let the stale (first) refresh resolve — it must not clobber B's result.
    resolveStale({
      settingsVersion: 1,
      agents: { claude: { pinned: true, customFlags: "stale" } },
    });
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
      .mockResolvedValueOnce({ settingsVersion: 1, agents: { claude: { pinned: false } } });

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

  describe("migrateAgentSettings (#7673 one-shot)", () => {
    it("clears every concrete pinned value when settingsVersion is absent", () => {
      const raw = {
        agents: {
          claude: { pinned: true, customFlags: "--verbose" },
          codex: { pinned: false, customFlags: "" },
          gemini: { pinned: undefined, customFlags: "" },
          cursor: { customFlags: "" },
        },
      } as never;

      const { migrated, agentsToClear } = migrateAgentSettings(raw);

      expect(migrated.settingsVersion).toBe(1);
      expect(migrated.agents.claude).toEqual({ customFlags: "--verbose" });
      expect(migrated.agents.codex).toEqual({ customFlags: "" });
      // pinned: undefined was already undefined — no clear needed
      expect(migrated.agents.gemini).toEqual({ pinned: undefined, customFlags: "" });
      expect(migrated.agents.cursor).toEqual({ customFlags: "" });
      expect(agentsToClear.sort()).toEqual(["claude", "codex"]);
    });

    it("is a no-op when settingsVersion is already 1", () => {
      const raw = {
        settingsVersion: 1,
        agents: {
          claude: { pinned: true, customFlags: "" },
          codex: { pinned: false, customFlags: "" },
        },
      } as never;

      const { migrated, agentsToClear } = migrateAgentSettings(raw);

      expect(migrated).toBe(raw);
      expect(agentsToClear).toEqual([]);
    });

    it("runs migration when settingsVersion is 0 (covers manual edits and version rollback)", () => {
      const raw = {
        settingsVersion: 0,
        agents: { claude: { pinned: true } },
      } as never;

      const { migrated, agentsToClear } = migrateAgentSettings(raw);

      expect(migrated.settingsVersion).toBe(1);
      expect(migrated.agents.claude!.pinned).toBeUndefined();
      expect(agentsToClear).toEqual(["claude"]);
    });

    it("preserves all other entry fields when clearing pinned", () => {
      const raw = {
        agents: {
          claude: {
            pinned: true,
            customFlags: "--verbose",
            dangerousEnabled: true,
            worktreePresets: { "wt-A": "preset-1" },
          },
        },
      } as never;

      const { migrated } = migrateAgentSettings(raw);

      expect(migrated.agents.claude).toEqual({
        customFlags: "--verbose",
        dangerousEnabled: true,
        worktreePresets: { "wt-A": "preset-1" },
      });
      expect(migrated.agents.claude!.pinned).toBeUndefined();
    });

    it("handles empty agents map gracefully", () => {
      const raw = { agents: {} } as never;
      const { migrated, agentsToClear } = migrateAgentSettings(raw);
      expect(migrated.settingsVersion).toBe(1);
      expect(migrated.agents).toEqual({});
      expect(agentsToClear).toEqual([]);
    });
  });

  it("initialize fires migration pin clear write-backs and stamps version after all succeed", async () => {
    registryMock.getEffectiveAgentIds.mockReturnValue(["claude", "codex"]);
    setAvailability({ claude: "ready", codex: "missing" }, true);
    // Legacy persisted shape: no settingsVersion, both agents have eagerly-seeded concrete pinned.
    clientMock.get.mockResolvedValue({
      agents: {
        claude: { pinned: true, customFlags: "" },
        codex: { pinned: false, customFlags: "" },
      },
    });
    clientMock.set.mockResolvedValue({ agents: {} });
    clientMock.stampVersion.mockResolvedValue({ settingsVersion: 1, agents: {} });

    await useAgentSettingsStore.getState().initialize();

    // In-memory state shows tri-state undefined (visibility comes from availability).
    const state = useAgentSettingsStore.getState();
    expect(state.settings?.agents.claude?.pinned).toBeUndefined();
    expect(state.settings?.agents.codex?.pinned).toBeUndefined();

    // Write-backs were scheduled with pinned: undefined to clear the persisted keys.
    // Drain the microtask queue so the fire-and-forget scheduleMigrationWriteBacks
    // settles before assertions.
    await Promise.resolve();
    await Promise.resolve();
    expect(clientMock.set).toHaveBeenCalledWith("claude", { pinned: undefined });
    expect(clientMock.set).toHaveBeenCalledWith("codex", { pinned: undefined });
    expect(clientMock.stampVersion).toHaveBeenCalledWith(1);
  });

  it("initialize does NOT stamp version when a migration write-back fails", async () => {
    registryMock.getEffectiveAgentIds.mockReturnValue(["claude", "codex"]);
    setAvailability({ claude: "ready", codex: "missing" }, true);
    clientMock.get.mockResolvedValue({
      agents: {
        claude: { pinned: true, customFlags: "" },
        codex: { pinned: false, customFlags: "" },
      },
    });
    // First write-back succeeds; second fails.
    clientMock.set
      .mockResolvedValueOnce({ agents: {} })
      .mockRejectedValueOnce(new Error("IPC dropped"));

    await useAgentSettingsStore.getState().initialize();
    // Drain the microtask queue.
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    // Both per-agent writes fired, but the version stamp must NOT have happened —
    // next cold start re-runs migration to retry the failed clear.
    expect(clientMock.set).toHaveBeenCalledWith("claude", { pinned: undefined });
    expect(clientMock.set).toHaveBeenCalledWith("codex", { pinned: undefined });
    expect(clientMock.stampVersion).not.toHaveBeenCalled();
  });

  it("initialize does NOT run migration when settingsVersion is already 1", async () => {
    registryMock.getEffectiveAgentIds.mockReturnValue(["claude", "codex"]);
    setAvailability({ claude: "ready", codex: "missing" }, true);
    clientMock.get.mockResolvedValue({
      settingsVersion: 1,
      agents: {
        claude: { pinned: true, customFlags: "" },
        codex: { pinned: false, customFlags: "" },
      },
    });

    await useAgentSettingsStore.getState().initialize();

    // Explicit user pins remain untouched.
    const state = useAgentSettingsStore.getState();
    expect(state.settings?.agents.claude?.pinned).toBe(true);
    expect(state.settings?.agents.codex?.pinned).toBe(false);
    expect(clientMock.set).not.toHaveBeenCalled();
    expect(clientMock.stampVersion).not.toHaveBeenCalled();
  });

  it("updateAgent migrates the IPC response — covers race where updateAgent is the first interaction with a legacy store", async () => {
    registryMock.getEffectiveAgentIds.mockReturnValue(["claude", "codex"]);
    setAvailability({ claude: "ready", codex: "ready" }, true);
    useAgentSettingsStore.setState({
      settings: null,
      isInitialized: false,
      isLoading: false,
    });
    // Legacy-shaped IPC response (no settingsVersion, codex has stale pin).
    clientMock.set.mockResolvedValue({
      agents: {
        claude: { pinned: true, customFlags: "--verbose" },
        codex: { pinned: false, customFlags: "" },
      },
    });
    clientMock.stampVersion.mockResolvedValue({ settingsVersion: 1, agents: {} });

    await useAgentSettingsStore.getState().updateAgent("claude", { customFlags: "--verbose" });

    // After updateAgent, codex's stale pin should be cleared in-memory.
    const state = useAgentSettingsStore.getState();
    expect(state.settings?.agents.codex?.pinned).toBeUndefined();
    expect(state.settings?.agents.claude?.pinned).toBeUndefined();
  });

  it("initialize seeds from the boot payload without a live client fetch", async () => {
    registryMock.getEffectiveAgentIds.mockReturnValue(["claude", "codex"]);
    bootMock.getSafeBootPromise.mockResolvedValueOnce({
      ok: true,
      result: {
        agentSettings: {
          settingsVersion: 1,
          agents: {
            claude: { pinned: true, customFlags: "--from-boot" },
            codex: { pinned: false, customFlags: "" },
          },
        },
      },
    } as never);

    await useAgentSettingsStore.getState().initialize();

    expect(clientMock.get).not.toHaveBeenCalled();
    const state = useAgentSettingsStore.getState();
    expect(state.isInitialized).toBe(true);
    expect(state.settings?.agents.claude?.customFlags).toBe("--from-boot");
  });

  it("initialize falls back to the live client when the boot payload failed", async () => {
    bootMock.getSafeBootPromise.mockResolvedValueOnce({
      ok: false,
      error: new Error("boot IPC down"),
    } as never);
    clientMock.get.mockResolvedValue({ settingsVersion: 1, agents: {} });

    await useAgentSettingsStore.getState().initialize();

    expect(clientMock.get).toHaveBeenCalledTimes(1);
    expect(useAgentSettingsStore.getState().isInitialized).toBe(true);
  });

  it("initialize falls back to the live client when the boot payload was released", async () => {
    // `releaseBootPayload()` nulls `agentSettings` after hydration — a
    // re-initialize after cleanup must hit the live client, not crash on the
    // released field.
    bootMock.getSafeBootPromise.mockResolvedValueOnce({
      ok: true,
      result: { agentSettings: undefined },
    } as never);
    clientMock.get.mockResolvedValue({ settingsVersion: 1, agents: {} });

    await useAgentSettingsStore.getState().initialize();

    expect(clientMock.get).toHaveBeenCalledTimes(1);
    expect(useAgentSettingsStore.getState().isInitialized).toBe(true);
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

    // Kick off init; it holds initPromise. Wait for it to reach the client
    // (it consults the boot payload first) so the mocked `get` order below
    // stays init-then-refresh. While in-flight, another caller triggers a
    // refresh (bumping the epoch and invalidating init).
    const initPending = useAgentSettingsStore.getState().initialize();
    await vi.waitFor(() => expect(clientMock.get).toHaveBeenCalledTimes(1));
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

  it("setGlobalSkipPermissions optimistically updates the root field without touching per-agent dangerousEnabled (#10432)", async () => {
    useAgentSettingsStore.setState({
      settings: {
        agents: { claude: { dangerousEnabled: true } },
        globalSkipPermissions: false,
      },
    });
    clientMock.setGlobal.mockResolvedValueOnce({});

    await useAgentSettingsStore.getState().setGlobalSkipPermissions(true);

    expect(clientMock.setGlobal).toHaveBeenCalledWith(true);
    const settings = useAgentSettingsStore.getState().settings;
    expect(settings?.globalSkipPermissions).toBe(true);
    // The per-agent toggle must be left untouched — the global is a live override.
    expect(settings?.agents.claude?.dangerousEnabled).toBe(true);
  });

  it("setGlobalSkipPermissions rolls back to the prior value when the IPC write rejects (#10432)", async () => {
    useAgentSettingsStore.setState({
      settings: { agents: { claude: {} }, globalSkipPermissions: false },
    });
    clientMock.setGlobal.mockRejectedValueOnce(new Error("ipc down"));

    await expect(useAgentSettingsStore.getState().setGlobalSkipPermissions(true)).rejects.toThrow(
      "ipc down"
    );

    const state = useAgentSettingsStore.getState();
    expect(state.settings?.globalSkipPermissions).toBe(false);
    expect(state.error).toBeTruthy();
  });

  it("setGlobalUseAltScreen optimistically updates the root field without touching per-agent inlineMode (#10876)", async () => {
    useAgentSettingsStore.setState({
      settings: {
        agents: { codex: { inlineMode: "on" } },
        globalUseAltScreen: false,
      },
    });
    clientMock.setGlobalInline.mockResolvedValueOnce({});

    await useAgentSettingsStore.getState().setGlobalUseAltScreen(true);

    expect(clientMock.setGlobalInline).toHaveBeenCalledWith(true);
    const settings = useAgentSettingsStore.getState().settings;
    expect(settings?.globalUseAltScreen).toBe(true);
    // The per-agent choice must be left untouched — the global is a live override.
    expect(settings?.agents.codex?.inlineMode).toBe("on");
  });

  it("setGlobalUseAltScreen rolls back to the prior value when the IPC write rejects (#10876)", async () => {
    useAgentSettingsStore.setState({
      settings: { agents: { codex: {} }, globalUseAltScreen: false },
    });
    clientMock.setGlobalInline.mockRejectedValueOnce(new Error("ipc down"));

    await expect(useAgentSettingsStore.getState().setGlobalUseAltScreen(true)).rejects.toThrow(
      "ipc down"
    );

    const state = useAgentSettingsStore.getState();
    expect(state.settings?.globalUseAltScreen).toBe(false);
    expect(state.error).toBeTruthy();
  });
});
