// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("@/utils/logger", () => ({
  logError: vi.fn(),
  logDebug: vi.fn(),
  logInfo: vi.fn(),
  logWarn: vi.fn(),
}));

let disabledCallback:
  | ((payload: { attemptCount: number; lastExitCode: number | null; timestamp: number }) => void)
  | null = null;
let activeCallback: (() => void) | null = null;
const disabledUnsubscribe = vi.fn();
const activeUnsubscribe = vi.fn();

vi.mock("@/clients/watchdogClient", () => ({
  watchdogClient: {
    restart: vi.fn().mockResolvedValue(undefined),
    onDisabled: vi.fn((cb) => {
      disabledCallback = cb;
      return disabledUnsubscribe;
    }),
    onActive: vi.fn((cb) => {
      activeCallback = cb;
      return activeUnsubscribe;
    }),
  },
}));

import { setupWatchdogHealthListeners } from "../watchdogHealth";
import { usePanelStore } from "@/store/panelStore";

beforeEach(() => {
  disabledCallback = null;
  activeCallback = null;
  disabledUnsubscribe.mockClear();
  activeUnsubscribe.mockClear();
  usePanelStore.setState({ watchdogStatus: "active", watchdogDisabledInfo: null });
});

describe("setupWatchdogHealthListeners", () => {
  it("registers a watchdog:disabled subscriber that updates the store", () => {
    setupWatchdogHealthListeners();
    expect(disabledCallback).not.toBeNull();

    disabledCallback?.({ attemptCount: 3, lastExitCode: 137, timestamp: 1700000000000 });

    const state = usePanelStore.getState();
    expect(state.watchdogStatus).toBe("disabled");
    expect(state.watchdogDisabledInfo).toEqual({
      attemptCount: 3,
      lastExitCode: 137,
      timestamp: 1700000000000,
    });
  });

  it("registers a watchdog:active subscriber that clears the store", () => {
    setupWatchdogHealthListeners();
    usePanelStore.setState({
      watchdogStatus: "disabled",
      watchdogDisabledInfo: { attemptCount: 3, lastExitCode: 1, timestamp: 0 },
    });

    activeCallback?.();

    const state = usePanelStore.getState();
    expect(state.watchdogStatus).toBe("active");
    expect(state.watchdogDisabledInfo).toBeNull();
  });

  it("disposing the store releases both subscriptions", () => {
    const store = setupWatchdogHealthListeners();
    store.dispose();
    expect(disabledUnsubscribe).toHaveBeenCalledTimes(1);
    expect(activeUnsubscribe).toHaveBeenCalledTimes(1);
  });
});
