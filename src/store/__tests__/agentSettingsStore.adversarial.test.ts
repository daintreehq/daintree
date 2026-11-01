// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const clientMock = vi.hoisted(() => ({
  get: vi.fn(),
  invalidate: vi.fn(),
  set: vi.fn(),
  setGlobal: vi.fn(),
  setGlobalInline: vi.fn(),
  setResumeOnRestart: vi.fn(),
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
  normalizeAgentSelection,
} from "../agentSettingsStore";
import { useCliAvailabilityStore } from "../cliAvailabilityStore";
import { BUILT_IN_AGENT_IDS } from "../../../shared/config/agentIds";
import { DEFAULT_AGENT_SETTINGS, type AgentSettings, type CliAvailability } from "@shared/types";

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
  it("normalizeAgentSelection returns the same reference when no changes are needed", () => {
    const settings = {
      agents: {
        claude: { enabled: true, flags: {} },
        codex: { enabled: true, flags: {} },
      },
    } as never;

    expect(normalizeAgentSelection(settings, true)).toBe(settings);
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

    resolveGet({ agents: { claude: { dangerousEnabled: true, enabled: true, flags: {} } } });
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
      agents: { claude: { dangerousEnabled: true, enabled: true, flags: {} } },
    } as never;
    useAgentSettingsStore.setState({
      settings: priorSettings,
      isInitialized: true,
      isLoading: false,
      error: null,
    });

    clientMock.set.mockRejectedValue(new Error("write failed"));

    await expect(
      useAgentSettingsStore.getState().updateAgent("claude", { dangerousEnabled: false })
    ).rejects.toThrow("write failed");

    const state = useAgentSettingsStore.getState();
    expect(state.settings).toBe(priorSettings);
    expect(state.error).toBe("write failed");
  });

  it("reset(agentId) forwards the id argument and stores the returned settings", async () => {
    // Pre-populate every registered agent so normalizeAgentSelection has no
    // missing entries to seed, and so leaves the response as it is.
    const returned = {
      settingsVersion: 1,
      agents: {
        claude: { dangerousEnabled: false, enabled: true, flags: {} },
        codex: { dangerousEnabled: true, enabled: true, flags: {} },
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

  it("initialize never pins agents or stamps a version, even on fresh default settings (#14702)", async () => {
    // First-run pins are this machine's, seeded by main from its own CLI
    // check; the host's agent settings are never touched for them.
    registryMock.getEffectiveAgentIds.mockReturnValue(["claude", "codex"]);
    setAvailability({ claude: "ready", codex: "installed" }, true);
    clientMock.get.mockResolvedValue(DEFAULT_AGENT_SETTINGS);

    await useAgentSettingsStore.getState().initialize();
    await Promise.resolve();
    await Promise.resolve();

    const state = useAgentSettingsStore.getState();
    expect(state.settings?.settingsVersion).toBe(DEFAULT_AGENT_SETTINGS.settingsVersion);
    for (const id of BUILT_IN_AGENT_IDS) {
      expect(state.settings?.agents[id]).not.toHaveProperty("pinned");
    }
    expect(clientMock.set).not.toHaveBeenCalled();
    expect(clientMock.stampVersion).not.toHaveBeenCalled();
  });

  it("stale refresh result does not overwrite a newer snapshot", async () => {
    registryMock.getEffectiveAgentIds.mockReturnValue(["claude", "codex"]);
    setAvailability({ claude: "ready" }, true);

    // Seed initial state so `refresh` has something to overwrite.
    useAgentSettingsStore.setState({
      settings: { agents: { claude: { customFlags: "" } } } as never,
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
        agents: { claude: { customFlags: "fresh" } },
      });

    const refreshA = useAgentSettingsStore.getState().refresh();
    const refreshB = useAgentSettingsStore.getState().refresh();
    await refreshB;

    // Now let the stale (first) refresh resolve — it must not clobber B's result.
    resolveStale({
      settingsVersion: 1,
      agents: { claude: { customFlags: "stale" } },
    });
    await refreshA;

    const state = useAgentSettingsStore.getState();
    expect(state.settings?.agents.claude).toEqual({ customFlags: "fresh" });
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

    resolveGet({ agents: { claude: { customFlags: "hello" } } });
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
      settings: { agents: { claude: { dangerousEnabled: true } } } as never,
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
      .mockResolvedValueOnce({
        settingsVersion: 1,
        agents: { claude: { dangerousEnabled: false } },
      });

    const stale = useAgentSettingsStore.getState().refresh();
    const fresh = useAgentSettingsStore.getState().refresh();
    await fresh;

    // Now fail the stale attempt. It must NOT reject — fire-and-forget
    // callers (orchestrator subscription, toggle handlers) would surface an
    // unhandled rejection otherwise.
    rejectStale(new Error("stale failure"));
    await expect(stale).resolves.toBeUndefined();

    expect(useAgentSettingsStore.getState().settings?.agents.claude?.dangerousEnabled).toBe(false);
  });

  describe("updateWorktreePreset", () => {
    it("spreads existing worktree keys so sibling entries are preserved", async () => {
      useAgentSettingsStore.setState({
        settings: {
          agents: {
            claude: {
              dangerousEnabled: true,
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
              dangerousEnabled: true,
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

    it("saves null as this worktree's bare-agent pick without touching the agent-level preset", async () => {
      useAgentSettingsStore.setState({
        settings: {
          agents: {
            claude: { presetId: "user-111", worktreePresets: { "wt-B": "user-222" } },
          },
        },
        isInitialized: true,
        isLoading: false,
      });
      let respond!: () => void;
      clientMock.set.mockImplementation(
        (_agentId: string, updates: Record<string, unknown>) =>
          new Promise((resolve) => {
            respond = () =>
              resolve({
                agents: {
                  claude: { presetId: "user-111", worktreePresets: updates.worktreePresets },
                },
              });
          })
      );
      const readEntry = () => useAgentSettingsStore.getState().settings?.agents?.claude;

      const pending = useAgentSettingsStore.getState().updateWorktreePreset("claude", "wt-A", null);

      expect(clientMock.set).toHaveBeenCalledWith("claude", {
        worktreePresets: { "wt-B": "user-222", "wt-A": null },
      });
      // The optimistic state already resolves wt-A to the bare agent, so a
      // launch while the save is in flight can't pick up the agent-level preset.
      expect(readEntry()?.presetId).toBe("user-111");
      expect(readEntry()?.worktreePresets).toEqual({ "wt-B": "user-222", "wt-A": null });

      respond();
      await pending;

      expect(readEntry()?.presetId).toBe("user-111");
      expect(readEntry()?.worktreePresets).toEqual({ "wt-B": "user-222", "wt-A": null });
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
        settings: { agents: { claude: { dangerousEnabled: true } } } as never,
        isInitialized: true,
        isLoading: false,
      });
      clientMock.set.mockResolvedValue({
        agents: { claude: { dangerousEnabled: true, worktreePresets: { "wt-A": "user-111" } } },
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

  it("initialize seeds from the boot payload without a live client fetch", async () => {
    registryMock.getEffectiveAgentIds.mockReturnValue(["claude", "codex"]);
    bootMock.getSafeBootPromise.mockResolvedValueOnce({
      ok: true,
      result: {
        agentSettings: {
          settingsVersion: 1,
          agents: {
            claude: { customFlags: "--from-boot" },
            codex: { customFlags: "" },
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
      .mockResolvedValueOnce({ agents: { claude: { dangerousEnabled: false } } });

    // Kick off init; it holds initPromise. Wait for it to reach the client
    // (it consults the boot payload first) so the mocked `get` order below
    // stays init-then-refresh. While in-flight, another caller triggers a
    // refresh (bumping the epoch and invalidating init).
    const initPending = useAgentSettingsStore.getState().initialize();
    await vi.waitFor(() => expect(clientMock.get).toHaveBeenCalledTimes(1));
    useAgentSettingsStore.setState({ isInitialized: false, isLoading: true });
    const concurrent = useAgentSettingsStore.getState().refresh();
    await concurrent;

    resolveInit({ agents: { claude: { dangerousEnabled: true } } });
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

  it("setResumeOnRestart writes the root field and rolls back when the IPC write rejects (#13509)", async () => {
    useAgentSettingsStore.setState({ settings: { agents: { claude: {} } } });
    clientMock.setResumeOnRestart.mockResolvedValueOnce({});

    await useAgentSettingsStore.getState().setResumeOnRestart("never");

    expect(clientMock.setResumeOnRestart).toHaveBeenCalledWith("never");
    expect(useAgentSettingsStore.getState().settings?.resumeOnRestart).toBe("never");

    clientMock.setResumeOnRestart.mockRejectedValueOnce(new Error("ipc down"));
    await expect(useAgentSettingsStore.getState().setResumeOnRestart("on-focus")).rejects.toThrow(
      "ipc down"
    );

    const state = useAgentSettingsStore.getState();
    expect(state.settings?.resumeOnRestart).toBe("never");
    expect(state.error).toBeTruthy();
  });
});

describe("applySaved (#14700)", () => {
  const savedElsewhere: AgentSettings = {
    settingsVersion: 3,
    agents: { claude: { customFlags: "--from-another-view" } },
  };

  it("takes a saved change over a read still travelling", async () => {
    let resolveRead: (value: unknown) => void = () => {};
    clientMock.get.mockImplementationOnce(() => new Promise((resolve) => (resolveRead = resolve)));
    const read = useAgentSettingsStore.getState().refresh();

    useAgentSettingsStore.getState().applySaved(savedElsewhere);
    resolveRead({ settingsVersion: 3, agents: { claude: { customFlags: "--before" } } });
    await read;

    const state = useAgentSettingsStore.getState();
    expect(state.settings?.agents.claude?.customFlags).toBe("--from-another-view");
    expect(state.isInitialized).toBe(true);
  });

  it("counts a read handed in from elsewhere from when the refresh began", async () => {
    let answer: (value: AgentSettings) => void = () => {};
    const overtaken = useAgentSettingsStore
      .getState()
      .refresh(() => new Promise((resolve) => (answer = resolve)));

    useAgentSettingsStore.getState().applySaved(savedElsewhere);
    answer({ settingsVersion: 3, agents: { claude: { customFlags: "--hydrated-before" } } });
    await overtaken;
    expect(useAgentSettingsStore.getState().settings?.agents.claude?.customFlags).toBe(
      "--from-another-view"
    );

    await useAgentSettingsStore.getState().refresh(async () => ({
      settingsVersion: 3,
      agents: { claude: { customFlags: "--hydrated" } },
    }));
    expect(useAgentSettingsStore.getState().settings?.agents.claude?.customFlags).toBe(
      "--hydrated"
    );
    expect(clientMock.get).not.toHaveBeenCalled();
  });

  it("takes a saved change as it is, writing nothing back (#14702)", async () => {
    // Pins left agent settings for this machine's own store, so there is no
    // renderer migration left for a heard change to echo.
    const saved: AgentSettings = { agents: { claude: { customFlags: "--x" } } };
    useAgentSettingsStore.getState().applySaved(saved);
    await Promise.resolve();

    expect(useAgentSettingsStore.getState().settings?.agents.claude).toEqual({
      customFlags: "--x",
    });
    expect(clientMock.set).not.toHaveBeenCalled();
    expect(clientMock.stampVersion).not.toHaveBeenCalled();
  });

  it("keeps newer typing over an older keystroke's saved change", async () => {
    useAgentSettingsStore.getState().applySaved({ settingsVersion: 3, agents: {} });
    const answers: Array<(value: unknown) => void> = [];
    clientMock.set.mockImplementation(() => new Promise((resolve) => answers.push(resolve)));
    const savedWith = (customFlags: string): AgentSettings => ({
      settingsVersion: 3,
      agents: { claude: { customFlags } },
    });

    const first = useAgentSettingsStore.getState().updateAgent("claude", { customFlags: "a" });
    const second = useAgentSettingsStore.getState().updateAgent("claude", { customFlags: "ab" });
    useAgentSettingsStore.getState().applySaved(savedWith("a"));
    expect(useAgentSettingsStore.getState().settings?.agents.claude?.customFlags).toBe("ab");

    answers[0]!(savedWith("a"));
    await first;
    useAgentSettingsStore.getState().applySaved(savedWith("ab"));
    answers[1]!(savedWith("ab"));
    await second;
    expect(useAgentSettingsStore.getState().settings?.agents.claude?.customFlags).toBe("ab");
  });

  it("takes a reset's answer without writing anything back (#14702)", async () => {
    const answer: AgentSettings = { agents: { claude: {}, codex: {} } };
    clientMock.reset.mockResolvedValueOnce(answer);
    const reset = useAgentSettingsStore.getState().reset();
    useAgentSettingsStore.getState().applySaved(answer);
    await reset;
    await Promise.resolve();

    expect(useAgentSettingsStore.getState().settings?.agents).toEqual(answer.agents);
    expect(clientMock.set).not.toHaveBeenCalled();
    expect(clientMock.stampVersion).not.toHaveBeenCalled();
  });

  it("keeps a newer change heard before a write's slower answer", async () => {
    useAgentSettingsStore.getState().applySaved({ settingsVersion: 3, agents: {} });
    let answer: (value: unknown) => void = () => {};
    clientMock.set.mockImplementationOnce(() => new Promise((resolve) => (answer = resolve)));
    const save = useAgentSettingsStore.getState().updateAgent("claude", { customFlags: "S1" });

    const savedWith = (customFlags: string): AgentSettings => ({
      settingsVersion: 3,
      agents: { claude: { customFlags } },
    });
    useAgentSettingsStore.getState().applySaved(savedWith("S1"));
    useAgentSettingsStore.getState().applySaved(savedWith("S2"));
    answer(savedWith("S1"));
    await save;

    expect(useAgentSettingsStore.getState().settings?.agents.claude?.customFlags).toBe("S2");
  });

  it("shows a newer change once its own write settles", async () => {
    useAgentSettingsStore
      .getState()
      .applySaved({ settingsVersion: 3, agents: {}, globalSkipPermissions: false });
    let answer: () => void = () => {};
    clientMock.setGlobal.mockImplementationOnce(() => new Promise<void>((r) => (answer = r)));
    const save = useAgentSettingsStore.getState().setGlobalSkipPermissions(true);

    useAgentSettingsStore
      .getState()
      .applySaved({ settingsVersion: 3, agents: {}, globalSkipPermissions: true });
    useAgentSettingsStore
      .getState()
      .applySaved({ settingsVersion: 3, agents: {}, globalSkipPermissions: false });
    expect(useAgentSettingsStore.getState().settings?.globalSkipPermissions).toBe(true);
    answer();
    await save;

    expect(useAgentSettingsStore.getState().settings?.globalSkipPermissions).toBe(false);
  });

  it("keeps another view's preset for a different worktree while this one's is saving", async () => {
    const withPresets = (worktreePresets: Record<string, string>): AgentSettings => ({
      settingsVersion: 3,
      agents: { claude: { worktreePresets } },
    });
    useAgentSettingsStore.getState().applySaved(withPresets({ b: "old" }));
    clientMock.set.mockImplementationOnce(() => new Promise(() => {}));
    void useAgentSettingsStore.getState().updateWorktreePreset("claude", "a", "mine");

    useAgentSettingsStore.getState().applySaved(withPresets({ b: "theirs" }));

    expect(useAgentSettingsStore.getState().settings?.agents.claude?.worktreePresets).toEqual({
      a: "mine",
      b: "theirs",
    });
  });

  it("keeps a write made before boot finished once its answer lands", async () => {
    let answer: (value: unknown) => void = () => {};
    clientMock.set.mockImplementationOnce(() => new Promise((resolve) => (answer = resolve)));
    useAgentSettingsStore.setState({ settings: { settingsVersion: 3, agents: {} } });
    const save = useAgentSettingsStore.getState().updateAgent("claude", { customFlags: "new" });
    clientMock.get.mockResolvedValueOnce({ settingsVersion: 3, agents: {} });
    await useAgentSettingsStore.getState().initialize();

    answer({ settingsVersion: 3, agents: { claude: { customFlags: "new" } } });
    await save;

    expect(useAgentSettingsStore.getState().settings?.agents.claude?.customFlags).toBe("new");
  });

  it("takes only the newest of this view's root writes when answers come back reversed", async () => {
    useAgentSettingsStore.getState().applySaved({ settingsVersion: 3, agents: {} });
    const answers: Array<() => void> = [];
    clientMock.setGlobal.mockImplementation(() => new Promise<void>((r) => answers.push(r)));
    const first = useAgentSettingsStore.getState().setGlobalSkipPermissions(true);
    const second = useAgentSettingsStore.getState().setGlobalSkipPermissions(false);

    answers[1]!();
    await second;
    answers[0]!();
    await first;

    expect(useAgentSettingsStore.getState().settings?.globalSkipPermissions).toBe(false);
  });

  it("reports a failed save that a saved change overtook, and shows what's saved", async () => {
    let rejectSave: (error: Error) => void = () => {};
    clientMock.set.mockImplementationOnce(() => new Promise((_, reject) => (rejectSave = reject)));
    useAgentSettingsStore.getState().applySaved({ settingsVersion: 3, agents: {} });
    const save = useAgentSettingsStore.getState().updateAgent("claude", { dangerousArgs: "mine" });

    useAgentSettingsStore.getState().applySaved(savedElsewhere);
    expect(useAgentSettingsStore.getState().settings?.agents.claude).toMatchObject({
      dangerousArgs: "mine",
    });
    rejectSave(new Error("disk full"));

    await expect(save).rejects.toThrow("disk full");
    const state = useAgentSettingsStore.getState();
    expect(state.settings?.agents.claude?.customFlags).toBe("--from-another-view");
    expect(state.settings?.agents.claude).not.toHaveProperty("dangerousArgs");
    expect(state.error).toContain("disk full");
  });
});
