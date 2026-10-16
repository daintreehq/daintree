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
  const usePanelStore = Object.assign(
    (selector: (s: typeof state) => unknown) => selector(state),
    { getState: () => state }
  );
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

vi.mock("@/clients", () => ({ systemClient: { onWake: vi.fn(() => () => {}) } }));

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
  (window as unknown as { electron?: unknown }).electron = available ? {} : undefined;
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
