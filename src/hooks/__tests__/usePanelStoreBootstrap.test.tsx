// @vitest-environment jsdom
import { renderHook, act } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { usePanelStoreBootstrap } from "../app/usePanelStoreBootstrap";
import { useResourceMonitoringStore } from "@/store/resourceMonitoringStore";
import { useCachedProjectViewsStore } from "@/store/cachedProjectViewsStore";
import {
  useMemoryLeakConfigStore,
  DEFAULT_AUTO_RESTART_THRESHOLD_MB,
} from "@/store/memoryLeakConfigStore";
import type { TerminalConfig } from "@shared/types/ipc/config";

vi.mock("@/store/panelStore", () => ({
  setupTerminalStoreListeners: vi.fn(() => () => {}),
}));
vi.mock("@/store/projectStatsStore", () => ({
  setupProjectStatsListeners: vi.fn(() => () => {}),
}));
vi.mock("@/store/fleetSnapshotStore", () => ({
  setupFleetSnapshotListeners: vi.fn(() => () => {}),
}));
vi.mock("@/store/systemWakeStore", () => ({
  setupSystemWakeListeners: vi.fn(() => () => {}),
}));
vi.mock("../useMemoryLeakDetection", () => ({
  useMemoryLeakDetection: vi.fn(),
}));

function installElectron(opts?: { config?: TerminalConfig }) {
  const get = vi.fn(async () => opts?.config ?? ({} as TerminalConfig));
  const setResourceMonitoring = vi.fn(async () => {});
  Object.defineProperty(window, "electron", {
    configurable: true,
    writable: true,
    value: {
      terminalConfig: {
        get,
        setResourceMonitoring,
      },
    },
  });
  return { get, setResourceMonitoring };
}

beforeEach(() => {
  vi.clearAllMocks();
  useResourceMonitoringStore.setState({ enabled: false });
  useCachedProjectViewsStore.setState({ cachedProjectViews: 1 });
  useMemoryLeakConfigStore.setState({
    enabled: false,
    autoRestartThresholdMb: DEFAULT_AUTO_RESTART_THRESHOLD_MB,
  });
});

describe("usePanelStoreBootstrap", () => {
  it("hydrates resource monitoring + cached views from the boot terminalConfig (no IPC)", async () => {
    const { get, setResourceMonitoring } = installElectron();
    const config: TerminalConfig = {
      resourceMonitoringEnabled: true,
      memoryLeakDetectionEnabled: true,
      memoryLeakAutoRestartThresholdMb: 768,
      cachedProjectViews: 4,
    } as TerminalConfig;

    renderHook(() => usePanelStoreBootstrap(config));

    await act(async () => {
      await Promise.resolve();
    });

    expect(get).not.toHaveBeenCalled();
    expect(useResourceMonitoringStore.getState().enabled).toBe(true);
    expect(setResourceMonitoring).toHaveBeenCalledWith(true);
    expect(useMemoryLeakConfigStore.getState().enabled).toBe(true);
    expect(useMemoryLeakConfigStore.getState().autoRestartThresholdMb).toBe(768);
    expect(useCachedProjectViewsStore.getState().cachedProjectViews).toBe(4);
  });

  it("falls back to terminalConfig.get() when boot payload is null (boot IPC failed)", async () => {
    const { get } = installElectron({
      config: {
        resourceMonitoringEnabled: true,
        cachedProjectViews: 2,
      } as TerminalConfig,
    });

    renderHook(() => usePanelStoreBootstrap(null));

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(get).toHaveBeenCalledTimes(1);
    expect(useResourceMonitoringStore.getState().enabled).toBe(true);
    expect(useCachedProjectViewsStore.getState().cachedProjectViews).toBe(2);
  });

  it("skips the fallback IPC when terminalConfig prop arrives later (race)", async () => {
    const { get } = installElectron();
    const initialConfig: TerminalConfig = {
      resourceMonitoringEnabled: true,
      cachedProjectViews: 3,
    } as TerminalConfig;

    const { rerender } = renderHook(
      ({ cfg }: { cfg: TerminalConfig | null }) => usePanelStoreBootstrap(cfg),
      { initialProps: { cfg: null as TerminalConfig | null } }
    );

    // First render: fallback IPC fires
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(get).toHaveBeenCalledTimes(1);

    // Boot eventually delivers terminalConfig — must not double-hydrate
    rerender({ cfg: initialConfig });
    await act(async () => {
      await Promise.resolve();
    });
    expect(get).toHaveBeenCalledTimes(1);
  });
});
