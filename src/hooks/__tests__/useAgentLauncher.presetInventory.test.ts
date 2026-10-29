// @vitest-environment jsdom
/**
 * A saved preset that isn't found while its inventory is still loading is
 * waited for, never cleared or launched without (#15025).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import type { AgentPreset } from "@shared/config/agentRegistry";
import type { AgentSettings, AgentSettingsEntry } from "@shared/types";
import { useCcrPresetsStore } from "@/store/ccrPresetsStore";
import { useProjectPresetsStore } from "@/store/projectPresetsStore";

interface PanelOptions {
  agentPresetId?: string;
  env?: Record<string, string>;
  worktreeId?: string;
  requestedId?: string;
  launchPrompt?: unknown;
}
interface NotifyPayload {
  type?: string;
  action?: { label: string; onClick: () => void };
}

const addPanel = vi.fn<(options: PanelOptions) => Promise<string | null>>();
const notify = vi.fn<(payload: NotifyPayload) => void>();
const updateAgent = vi.fn<(...args: unknown[]) => void>();
const updateWorktreePreset = vi.fn<(...args: unknown[]) => void>();

vi.mock("@/store/panelStore", () => {
  const state = { addPanel: (options: PanelOptions) => addPanel(options), panelsById: {} };
  const usePanelStore = Object.assign((selector: (s: typeof state) => unknown) => selector(state), {
    getState: () => state,
  });
  return { usePanelStore };
});

vi.mock("../useWorktreeStore", () => ({
  useWorktreeStoreApi: () => ({
    getState: () => ({ worktrees: new Map(), isInitialized: false }),
  }),
}));

vi.mock("@/store/worktreeStore", () => ({
  useWorktreeSelectionStore: (selector: (s: unknown) => unknown) =>
    selector({ activeWorktreeId: "wt-1", deletedWorktrees: new Set() }),
}));

vi.mock("@/store/projectStore", () => ({
  useProjectStore: (selector: (s: unknown) => unknown) =>
    selector({ currentProject: { id: "proj-1", path: "/repo" } }),
}));

vi.mock("@/store/scratchStore", () => ({
  useScratchStore: (selector: (s: unknown) => unknown) => selector({ currentScratch: null }),
}));

vi.mock("@/hooks/app/useHomeDir", () => ({ useHomeDir: () => ({ homeDir: "/home/u" }) }));

vi.mock("@/store/cliAvailabilityStore", () => {
  const state = {
    availability: {},
    details: {},
    isLoading: false,
    isRefreshing: false,
    initialize: vi.fn().mockResolvedValue(undefined),
    refresh: vi.fn().mockResolvedValue(undefined),
  };
  return {
    useCliAvailabilityStore: Object.assign(
      (selector: (s: typeof state) => unknown) => selector(state),
      { getState: () => state }
    ),
  };
});

vi.mock("@/store/agentSettingsStore", async () => {
  const { create } = await import("zustand");
  const useAgentSettingsStore = create(() => ({
    settings: null as AgentSettings | null,
    isInitialized: true,
    initialize: vi.fn().mockResolvedValue(undefined),
    refresh: vi.fn().mockResolvedValue(undefined),
    updateAgent: (...args: unknown[]) => updateAgent(...args),
    updateWorktreePreset: (...args: unknown[]) => updateWorktreePreset(...args),
  }));
  return { useAgentSettingsStore };
});

vi.mock("@/utils/agentLaunchCommand", () => ({
  getCurrentLaunchCliDetail: vi.fn().mockResolvedValue(undefined),
  resolveAgentLaunchBaseCommand: (command: string) => command,
}));

vi.mock("@/lib/notify", () => ({ notify: (payload: NotifyPayload) => notify(payload) }));

vi.mock("@/clients", () => ({
  systemClient: { onWake: vi.fn(() => () => {}), getTmpDir: vi.fn().mockResolvedValue("/tmp") },
  terminalClient: { getHostAgentLimit: vi.fn() },
}));

vi.mock("@/utils/logger", () => ({
  logError: vi.fn(),
  logWarn: vi.fn(),
  logInfo: vi.fn(),
  logDebug: vi.fn(),
}));

const { useAgentLauncher } = await import("../useAgentLauncher");
const { useAgentSettingsStore } = await import("@/store/agentSettingsStore");

const TEAM: AgentPreset = { id: "team", name: "Team", env: { WHO: "team" } };
const MINE: AgentPreset = { id: "mine", name: "Mine", env: { WHO: "mine" } };
const OPUS: AgentPreset = { id: "ccr-opus", name: "CCR: Opus", env: { WHO: "ccr" } };

function saveChoices(entry: AgentSettingsEntry): void {
  const settings: AgentSettings = { agents: { claude: entry } };
  useAgentSettingsStore.setState({ settings });
}

function launchedPresetIds(): Array<string | undefined> {
  return addPanel.mock.calls.map(([options]) => options.agentPresetId);
}

describe("useAgentLauncher — a saved preset whose inventory hasn't loaded (#15025)", () => {
  beforeEach(() => {
    addPanel.mockReset().mockResolvedValue(null);
    notify.mockReset();
    updateAgent.mockReset();
    updateWorktreePreset.mockReset();
    Reflect.set(window, "electron", {});
    useCcrPresetsStore.setState({ ccrPresetsByAgent: {}, isInitialized: true });
    useProjectPresetsStore.setState({ presetsByAgent: {}, hydratedProjectId: null });
    saveChoices({ presetId: "mine", customPresets: [MINE], worktreePresets: { "wt-1": "team" } });
  });

  afterEach(() => {
    vi.useRealTimers();
    Reflect.set(window, "electron", undefined);
  });

  it("waits for the project's presets and launches the worktree's pick, clearing nothing", async () => {
    addPanel.mockResolvedValue("terminal-1");
    const onDecline = vi.fn();
    const { result } = renderHook(() => useAgentLauncher());

    let launch: Promise<unknown> = Promise.resolve();
    await act(async () => {
      launch = result.current.launchAgent("claude", { force: true, onDecline });
      await Promise.resolve();
    });
    expect(addPanel).not.toHaveBeenCalled();

    let launched: unknown;
    await act(async () => {
      useProjectPresetsStore.getState().setPresetsByAgent("proj-1", { claude: [TEAM] });
      launched = await launch;
    });

    expect(launched).toMatchObject({ terminalId: "terminal-1", worktreeId: "wt-1" });
    expect(onDecline).not.toHaveBeenCalled();
    expect(launchedPresetIds()).toEqual(["team"]);
    expect(addPanel.mock.calls[0]?.[0]).toMatchObject({ env: { WHO: "team" } });
    expect(updateWorktreePreset).not.toHaveBeenCalled();
    expect(updateAgent).not.toHaveBeenCalled();
  });

  it("refuses, and says so, when the presets never load", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const onDecline = vi.fn();
    const { result } = renderHook(() => useAgentLauncher());

    let launched: unknown = "pending";
    await act(async () => {
      const launch = result.current.launchAgent("claude", { force: true, onDecline });
      await vi.advanceTimersByTimeAsync(3_000);
      launched = await launch;
    });

    expect(launched).toBeNull();
    expect(onDecline).toHaveBeenCalledExactlyOnceWith({
      reason: "presets-loading",
      panelLimit: null,
    });
    expect(addPanel).not.toHaveBeenCalled();
    expect(updateWorktreePreset).not.toHaveBeenCalled();
    expect(updateAgent).not.toHaveBeenCalled();
    expect(notify).toHaveBeenCalledOnce();
    expect(notify.mock.calls[0]?.[0]).toMatchObject({
      type: "error",
      action: { label: "Try again" },
    });
  });

  it("starts the agent afresh from the refusal's Try again, where the first launch was headed", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const onDecline = vi.fn();
    const { result } = renderHook(() => useAgentLauncher());
    await act(async () => {
      const launch = result.current.launchAgent("claude", {
        force: true,
        onDecline,
        prompt: "fix the build",
        requestedId: "job-1",
      });
      await vi.advanceTimersByTimeAsync(3_000);
      await launch;
    });

    vi.useRealTimers();
    useProjectPresetsStore.getState().setPresetsByAgent("proj-1", { claude: [TEAM] });
    const action = notify.mock.calls[0]?.[0]?.action;
    await act(async () => {
      action?.onClick();
      await vi.waitFor(() => expect(addPanel).toHaveBeenCalled());
    });

    expect(launchedPresetIds()).toEqual(["team"]);
    // A caller's prompt and requested id belong to the dispatch that was
    // already answered, so the retry carries neither.
    expect(addPanel.mock.calls[0]?.[0]).toMatchObject({ worktreeId: "wt-1" });
    expect(addPanel.mock.calls[0]?.[0]).not.toHaveProperty("requestedId", "job-1");
    expect(addPanel.mock.calls[0]?.[0]?.launchPrompt).toBeUndefined();
    expect(onDecline).toHaveBeenCalledOnce();
  });

  it("waits for the CCR routes and launches a saved route once they arrive", async () => {
    useCcrPresetsStore.setState({ ccrPresetsByAgent: {}, isInitialized: false });
    useProjectPresetsStore.getState().setPresetsByAgent("proj-1", {});
    saveChoices({ presetId: "ccr-opus" });
    const { result } = renderHook(() => useAgentLauncher());

    let launch: Promise<unknown> = Promise.resolve();
    await act(async () => {
      launch = result.current.launchAgent("claude", { force: true });
      await Promise.resolve();
    });
    expect(addPanel).not.toHaveBeenCalled();

    await act(async () => {
      useCcrPresetsStore.getState().setCcrPresets("claude", [OPUS]);
      await launch;
    });

    expect(launchedPresetIds()).toEqual(["ccr-opus"]);
    expect(addPanel.mock.calls[0]?.[0]).toMatchObject({ env: { WHO: "ccr" } });
    expect(updateAgent).not.toHaveBeenCalled();
  });

  it("waits for CCR routes only for a CCR id, so a deleted custom pick is still cleaned up", async () => {
    useCcrPresetsStore.setState({ ccrPresetsByAgent: {}, isInitialized: false });
    useProjectPresetsStore.getState().setPresetsByAgent("proj-1", {});
    saveChoices({
      presetId: "mine",
      customPresets: [MINE],
      worktreePresets: { "wt-1": "user-gone" },
    });
    const { result } = renderHook(() => useAgentLauncher());

    await act(async () => {
      await result.current.launchAgent("claude", { force: true });
    });

    expect(updateWorktreePreset).toHaveBeenCalledExactlyOnceWith("claude", "wt-1", undefined);
    expect(launchedPresetIds()).toEqual(["mine"]);
  });

  it("still clears a pick that is really gone once the presets have loaded", async () => {
    useProjectPresetsStore.getState().setPresetsByAgent("proj-1", { claude: [] });
    const { result } = renderHook(() => useAgentLauncher());

    await act(async () => {
      await result.current.launchAgent("claude", { force: true });
    });

    expect(updateWorktreePreset).toHaveBeenCalledExactlyOnceWith("claude", "wt-1", undefined);
    expect(launchedPresetIds()).toEqual(["mine"]);
    expect(notify).not.toHaveBeenCalled();
  });

  it("doesn't wait for a launch that asks for no preset", async () => {
    const { result } = renderHook(() => useAgentLauncher());

    await act(async () => {
      await result.current.launchAgent("claude", { force: true, presetId: null });
    });

    expect(launchedPresetIds()).toEqual([undefined]);
    expect(updateWorktreePreset).not.toHaveBeenCalled();
  });
});
