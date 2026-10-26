// @vitest-environment jsdom
import { renderHook, act } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { usePanelStoreBootstrap } from "../app/usePanelStoreBootstrap";
import { useResourceMonitoringStore } from "@/store/resourceMonitoringStore";
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
vi.mock("@/store/terminalAdoptionStore", () => ({
  setupTerminalAdoptionListeners: vi.fn(() => () => {}),
}));
vi.mock("@/store/rateLimitObservationStore", () => ({
  setupRateLimitObservationListeners: vi.fn(() => () => {}),
}));
vi.mock("@/store/systemWakeStore", () => ({
  setupSystemWakeListeners: vi.fn(() => () => {}),
}));
vi.mock("../useMemoryLeakDetection", () => ({
  useMemoryLeakDetection: vi.fn(),
}));

const { useMemoryLeakDetection } = await import("../useMemoryLeakDetection");

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
  useMemoryLeakConfigStore.setState({
    enabled: false,
    autoRestartThresholdMb: DEFAULT_AUTO_RESTART_THRESHOLD_MB,
  });
});

// Seeding and keeping these settings current is terminalConfigSync's job (#14699).
describe("usePanelStoreBootstrap", () => {
  it("neither reads nor writes terminal settings, so boot can't switch monitoring back on", async () => {
    const { get, setResourceMonitoring } = installElectron();

    renderHook(() => usePanelStoreBootstrap());
    await act(async () => {
      await Promise.resolve();
    });

    expect(get).not.toHaveBeenCalled();
    expect(setResourceMonitoring).not.toHaveBeenCalled();
    expect(useResourceMonitoringStore.getState().enabled).toBe(false);
  });

  it("runs leak detection on the settings the store holds, and follows a change", async () => {
    installElectron();
    useMemoryLeakConfigStore.setState({ enabled: true, autoRestartThresholdMb: 768 });

    renderHook(() => usePanelStoreBootstrap());
    expect(vi.mocked(useMemoryLeakDetection)).toHaveBeenLastCalledWith(true, 768);

    act(() => {
      useMemoryLeakConfigStore.setState({ enabled: false });
    });
    expect(vi.mocked(useMemoryLeakDetection)).toHaveBeenLastCalledWith(false, 768);
  });
});
