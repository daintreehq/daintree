// @vitest-environment jsdom
/**
 * Every launch `launchAgent` declines without throwing resolves to `null`, and
 * `agent.launch` can only tell its caller why through `onDecline` (#13382).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import type { PanelLimitSnapshot } from "@/store/panelLimitStore";

const addPanel = vi.fn();

vi.mock("@/store/panelStore", () => {
  const state = { addPanel: (...args: unknown[]) => addPanel(...args), panelsById: {} };
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
    selector({ activeWorktreeId: null, deletedWorktrees: new Set() }),
}));

vi.mock("@/store/projectStore", () => ({
  useProjectStore: (selector: (s: unknown) => unknown) =>
    selector({ currentProject: { path: "/repo" } }),
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

vi.mock("@/store/agentSettingsStore", () => {
  const state = {
    settings: null,
    initialize: vi.fn().mockResolvedValue(undefined),
    refresh: vi.fn().mockResolvedValue(undefined),
  };
  return {
    useAgentSettingsStore: Object.assign(
      (selector: (s: typeof state) => unknown) => selector(state),
      { getState: () => state }
    ),
  };
});

const getHostAgentLimit = vi.fn();
vi.mock("@/clients", () => ({
  systemClient: { onWake: vi.fn(() => () => {}) },
  terminalClient: { getHostAgentLimit: () => getHostAgentLimit() },
}));

const getCurrentLaunchCliDetail = vi.hoisted(() => vi.fn());
vi.mock("@/utils/agentLaunchCommand", async (importActual) => ({
  ...(await importActual<object>()),
  getCurrentLaunchCliDetail: (id: string) => getCurrentLaunchCliDetail(id),
}));

vi.mock("@/utils/logger", () => ({
  logError: vi.fn(),
  logWarn: vi.fn(),
  logInfo: vi.fn(),
  logDebug: vi.fn(),
}));

const { useAgentLauncher } = await import("../useAgentLauncher");

const SNAPSHOT: PanelLimitSnapshot = {
  count: 32,
  softWarningLimit: 12,
  confirmationLimit: 20,
  hardLimit: 32,
  tier: "hard",
};

function setElectron(available: boolean): void {
  Reflect.set(window, "electron", available ? {} : undefined);
}

describe("useAgentLauncher — declined launches name their reason (#13382)", () => {
  beforeEach(() => {
    addPanel.mockReset();
    getCurrentLaunchCliDetail.mockReset();
    getCurrentLaunchCliDetail.mockResolvedValue(undefined);
    setElectron(true);
  });

  afterEach(() => {
    setElectron(false);
  });

  it("reports panel-limit with the snapshot addPanel refused on", async () => {
    addPanel.mockImplementation(
      async (
        _options: unknown,
        commit?: { onLimitRefused?: (snapshot: PanelLimitSnapshot) => void }
      ) => {
        commit?.onLimitRefused?.(SNAPSHOT);
        return null;
      }
    );
    const onDecline = vi.fn();
    const { result } = renderHook(() => useAgentLauncher());

    let launched: unknown;
    await act(async () => {
      launched = await result.current.launchAgent("browser", { onDecline });
    });

    expect(launched).toBeNull();
    expect(onDecline).toHaveBeenCalledExactlyOnceWith({
      reason: "panel-limit",
      panelLimit: SNAPSHOT,
    });
  });

  it("reports panel-limit from the terminal launch path too, not only panel kinds", async () => {
    addPanel.mockImplementation(
      async (
        _options: unknown,
        commit?: { onLimitRefused?: (snapshot: PanelLimitSnapshot) => void }
      ) => {
        commit?.onLimitRefused?.(SNAPSHOT);
        return null;
      }
    );
    const onDecline = vi.fn();
    const { result } = renderHook(() => useAgentLauncher());

    await act(async () => {
      await result.current.launchAgent("terminal", { onDecline });
    });

    expect(addPanel).toHaveBeenCalledOnce();
    expect(onDecline).toHaveBeenCalledExactlyOnceWith({
      reason: "panel-limit",
      panelLimit: SNAPSHOT,
    });
  });

  it("declines a scheduled run whose agent CLI can't launch, opening no setup pane (#15978)", async () => {
    getCurrentLaunchCliDetail.mockResolvedValue({ state: "missing" });
    const onDecline = vi.fn();
    const { result } = renderHook(() => useAgentLauncher());

    let launched: unknown;
    await act(async () => {
      launched = await result.current.launchAgent("claude", {
        prompt: "Triage.",
        scheduledRun: { scheduleId: "schedule-1", runId: "run-1" },
        onDecline,
      });
    });

    expect(launched).toBeNull();
    expect(onDecline).toHaveBeenCalledExactlyOnceWith({ reason: "missing-cli", panelLimit: null });
    expect(addPanel).not.toHaveBeenCalled();
  });

  it("reports spawn-failed when addPanel declines for any other reason", async () => {
    addPanel.mockResolvedValue(null);
    const onDecline = vi.fn();
    const { result } = renderHook(() => useAgentLauncher());

    await act(async () => {
      await result.current.launchAgent("browser", { onDecline });
    });

    expect(onDecline).toHaveBeenCalledExactlyOnceWith({
      reason: "spawn-failed",
      panelLimit: null,
    });
  });

  it("reports spawn-failed when creating the panel throws", async () => {
    addPanel.mockRejectedValue(new Error("boom"));
    const onDecline = vi.fn();
    const { result } = renderHook(() => useAgentLauncher());

    await act(async () => {
      await result.current.launchAgent("browser", { onDecline });
    });

    expect(onDecline).toHaveBeenCalledExactlyOnceWith({
      reason: "spawn-failed",
      panelLimit: null,
    });
  });

  it("reports already-launching for a second launch of the same id while the first is in flight", async () => {
    let release: (id: string) => void = () => {};
    addPanel.mockImplementationOnce(
      () =>
        new Promise<string>((resolve) => {
          release = resolve;
        })
    );
    const onDecline = vi.fn();
    const { result } = renderHook(() => useAgentLauncher());

    let first: Promise<unknown> = Promise.resolve();
    let second: unknown;
    await act(async () => {
      first = result.current.launchAgent("browser");
      second = await result.current.launchAgent("browser", { onDecline });
    });

    expect(second).toBeNull();
    expect(onDecline).toHaveBeenCalledExactlyOnceWith({
      reason: "already-launching",
      panelLimit: null,
    });

    await act(async () => {
      release("browser-1");
      await first;
    });
  });

  it("reports unavailable without Electron, and never calls addPanel", async () => {
    setElectron(false);
    const onDecline = vi.fn();
    const { result } = renderHook(() => useAgentLauncher());

    await act(async () => {
      await result.current.launchAgent("browser", { onDecline });
    });

    expect(onDecline).toHaveBeenCalledExactlyOnceWith({ reason: "unavailable", panelLimit: null });
    expect(addPanel).not.toHaveBeenCalled();
  });

  it("stays silent for a launch that lands", async () => {
    addPanel.mockResolvedValue("browser-1");
    const onDecline = vi.fn();
    const { result } = renderHook(() => useAgentLauncher());

    let launched: unknown;
    await act(async () => {
      launched = await result.current.launchAgent("browser", { onDecline });
    });

    expect(launched).toMatchObject({ terminalId: "browser-1", location: "grid" });
    expect(onDecline).not.toHaveBeenCalled();
  });
});

describe("useAgentLauncher — the launching plugin (#14017)", () => {
  beforeEach(() => {
    addPanel.mockReset();
    addPanel.mockResolvedValue("terminal-1");
    setElectron(true);
  });

  afterEach(() => {
    setElectron(false);
  });

  it("stamps it on an agent pane, so only that plugin may hold the pane later", async () => {
    const { result } = renderHook(() => useAgentLauncher());

    await act(async () => {
      await result.current.launchAgent("claude", {
        force: true,
        launchedByPluginId: "acme.orchestrator",
      });
    });

    expect(addPanel).toHaveBeenCalledWith(
      expect.objectContaining({ launchAgentId: "claude", launchedByPluginId: "acme.orchestrator" }),
      expect.anything()
    );
  });

  it("leaves a plain shell unowned, since restore never holds one", async () => {
    const { result } = renderHook(() => useAgentLauncher());

    await act(async () => {
      await result.current.launchAgent("terminal", { launchedByPluginId: "acme.orchestrator" });
    });

    expect(addPanel).toHaveBeenCalledOnce();
    expect(addPanel.mock.calls[0]?.[0]).not.toHaveProperty("launchedByPluginId");
  });
});

describe("useAgentLauncher — a scheduled run (#15977)", () => {
  const RUN = { scheduleId: "schedule-1", runId: "run-1" };

  beforeEach(() => {
    addPanel.mockReset();
    addPanel.mockResolvedValue("terminal-1");
    setElectron(true);
  });

  afterEach(() => {
    setElectron(false);
  });

  it("marks the pane with the schedule and its run, over the source it was given", async () => {
    const { result } = renderHook(() => useAgentLauncher());

    await act(async () => {
      await result.current.launchAgent("claude", {
        force: true,
        spawnedBy: "mcp",
        scheduledRun: RUN,
      });
    });

    expect(addPanel).toHaveBeenCalledWith(
      expect.objectContaining({ spawnedBy: "schedule", scheduledRun: RUN }),
      expect.anything()
    );
  });

  it("never stamps a schedule source that came without its run", async () => {
    const { result } = renderHook(() => useAgentLauncher());

    await act(async () => {
      await result.current.launchAgent("claude", { force: true, spawnedBy: "schedule" });
    });

    const options = addPanel.mock.calls[0]?.[0];
    expect(options).not.toHaveProperty("spawnedBy");
    expect(options).not.toHaveProperty("scheduledRun");
  });
});

describe("useAgentLauncher — no host agent ceiling (#14810)", () => {
  beforeEach(() => {
    addPanel.mockReset();
    addPanel.mockResolvedValue("terminal-1");
    getHostAgentLimit.mockReset();
    setElectron(true);
  });

  afterEach(() => {
    setElectron(false);
  });

  it("launches an agent without asking the host how many are live", async () => {
    getHostAgentLimit.mockResolvedValue({ host: "Studio", count: 40, limit: 2 });
    const onDecline = vi.fn();
    const { result } = renderHook(() => useAgentLauncher());

    let launched: unknown;
    await act(async () => {
      launched = await result.current.launchAgent("claude", { force: true, onDecline });
    });

    expect(getHostAgentLimit).not.toHaveBeenCalled();
    expect(addPanel).toHaveBeenCalledOnce();
    expect(launched).toMatchObject({ terminalId: "terminal-1" });
    expect(launched).not.toHaveProperty("hostAgentLimit");
    expect(onDecline).not.toHaveBeenCalled();
  });
});

describe("useAgentLauncher — the launch prompt record (#14592)", () => {
  beforeEach(() => {
    addPanel.mockReset();
    addPanel.mockResolvedValue("terminal-1");
    setElectron(true);
  });

  afterEach(() => {
    setElectron(false);
  });

  const launchedOptions = (): Record<string, unknown> =>
    addPanel.mock.calls[0]?.[0] as Record<string, unknown>;

  it("records the prompt as the caller wrote it, not with the handback instruction", async () => {
    const { result } = renderHook(() => useAgentLauncher());

    await act(async () => {
      await result.current.launchAgent("claude", {
        force: true,
        prompt: "Fix the flaky test\n\nWhen you have finished…",
        promptAsWritten: "Fix the flaky test",
        handbackCode: "abc123",
      });
    });

    expect(launchedOptions().launchPrompt).toEqual({
      text: "Fix the flaky test",
      via: "launch",
      at: expect.any(Number),
    });
  });

  it("records a prompt passed with no handback as it is", async () => {
    const { result } = renderHook(() => useAgentLauncher());

    await act(async () => {
      await result.current.launchAgent("claude", { force: true, prompt: "Line one\nline two" });
    });

    expect(launchedOptions().launchPrompt).toMatchObject({ text: "Line one\nline two" });
  });

  it("writes no record for a launch with no prompt, or one that starts no agent", async () => {
    const { result } = renderHook(() => useAgentLauncher());

    await act(async () => {
      await result.current.launchAgent("claude", { force: true });
    });
    await act(async () => {
      await result.current.launchAgent("terminal", { prompt: "ls" });
    });

    expect(addPanel).toHaveBeenCalledTimes(2);
    expect(addPanel.mock.calls[0]?.[0]).not.toHaveProperty("launchPrompt");
    expect(addPanel.mock.calls[1]?.[0]).not.toHaveProperty("launchPrompt");
  });
});
