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

const notify = vi.fn();
vi.mock("@/lib/notify", () => ({ notify: (...args: unknown[]) => notify(...args) }));

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

describe("useAgentLauncher — the host's agent ceiling (#14704)", () => {
  beforeEach(() => {
    addPanel.mockReset();
    addPanel.mockResolvedValue("terminal-1");
    getHostAgentLimit.mockReset();
    notify.mockReset();
    setElectron(true);
  });

  afterEach(() => {
    setElectron(false);
  });

  it("declines an agent on a full host before any pane opens, and says which host", async () => {
    const hostAgentLimit = { host: "Studio", count: 10, limit: 10 };
    getHostAgentLimit.mockResolvedValue(hostAgentLimit);
    const onDecline = vi.fn();
    const { result } = renderHook(() => useAgentLauncher());

    let launched: unknown = "unset";
    await act(async () => {
      launched = await result.current.launchAgent("claude", { force: true, onDecline });
    });

    expect(launched).toBeNull();
    expect(addPanel).not.toHaveBeenCalled();
    expect(onDecline).toHaveBeenCalledExactlyOnceWith({
      reason: "host-agent-limit",
      panelLimit: null,
      hostAgentLimit,
    });
    expect(notify).toHaveBeenCalledOnce();
    expect(notify.mock.calls[0]?.[0]).toMatchObject({ type: "warning" });
    expect(String(notify.mock.calls[0]?.[0]?.message)).toContain("Studio");
  });

  it("launches with room to spare and hands back the count it was judged on", async () => {
    const hostAgentLimit = { host: "Studio", count: 9, limit: 10 };
    getHostAgentLimit.mockResolvedValue(hostAgentLimit);
    const { result } = renderHook(() => useAgentLauncher());

    let launched: unknown;
    await act(async () => {
      launched = await result.current.launchAgent("claude", { force: true });
    });

    expect(addPanel).toHaveBeenCalledOnce();
    expect(launched).toMatchObject({ terminalId: "terminal-1", hostAgentLimit });
    expect(notify).not.toHaveBeenCalled();
  });

  it("launches as before on a machine that isn't hosting, or a host that can't say", async () => {
    getHostAgentLimit.mockResolvedValueOnce(null);
    getHostAgentLimit.mockRejectedValueOnce(new Error("no such channel"));
    const { result } = renderHook(() => useAgentLauncher());

    const launches: unknown[] = [];
    await act(async () => {
      launches.push(await result.current.launchAgent("claude", { force: true }));
      launches.push(await result.current.launchAgent("claude", { force: true }));
    });

    expect(addPanel).toHaveBeenCalledTimes(2);
    for (const launched of launches) {
      expect(launched).toMatchObject({ terminalId: "terminal-1" });
      expect(launched).not.toHaveProperty("hostAgentLimit");
    }
  });

  it("never asks for a plain shell or a panel", async () => {
    const { result } = renderHook(() => useAgentLauncher());

    await act(async () => {
      await result.current.launchAgent("terminal");
      await result.current.launchAgent("browser");
    });

    expect(getHostAgentLimit).not.toHaveBeenCalled();
  });
});
