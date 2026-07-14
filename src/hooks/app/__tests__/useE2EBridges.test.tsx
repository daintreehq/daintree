// @vitest-environment jsdom
import { renderHook } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import type { NotificationsE2EApi } from "@/lib/e2eNotificationBackdoor";

const installE2EActionDispatchBridgeMock = vi.hoisted(() => vi.fn());
// Sentinel presence-only stub — the test only checks the global is set/cleared,
// not the shape of the real 16-member NotificationsE2EApi.
const notificationsE2EApiSentinel = vi.hoisted(
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- deliberate presence-only test sentinel, not a real NotificationsE2EApi
  () => ({}) as NotificationsE2EApi
);
// Mirrors the real installE2ENotificationBackdoor(), which sets this global —
// needed so the unmount-cleanup test can verify it's actually removed rather
// than asserting on a key that was never set.
const installE2ENotificationBackdoorMock = vi.hoisted(() =>
  vi.fn(() => {
    window.__daintreeNotificationsE2E = notificationsE2EApiSentinel;
  })
);
const loadE2ENotificationBackdoorMock = vi.hoisted(() =>
  vi.fn(() =>
    Promise.resolve({ installE2ENotificationBackdoor: installE2ENotificationBackdoorMock })
  )
);

const errorStoreState = vi.hoisted(() => ({
  errors: [
    {
      id: "err-1",
      source: "test",
      message: "boom",
      fromPreviousSession: false,
    },
  ],
  addError: vi.fn(),
  reset: vi.fn(),
}));
const requestConflictMock = vi.hoisted(() => vi.fn());
const diagnosticsState = vi.hoisted(() => ({ isOpen: false, openDock: vi.fn() }));
const perfMetricsState = vi.hoisted(() => ({
  fps: 60,
  lafCount30s: 0,
  cls30s: 0,
  setLiveMetrics: vi.fn(),
}));
const performanceModeState = vi.hoisted(() => ({
  performanceMode: false,
  setPerformanceMode: vi.fn(),
}));
const worktreeStoreState = vi.hoisted(() => ({
  worktrees: new Map([
    [
      "wt-1",
      {
        id: "wt-1",
        branch: "feature/e2e",
        resourceConnectCommand: "ssh e2e-host",
      },
    ],
  ]),
}));

vi.mock("@/store", () => ({
  useErrorStore: { getState: () => errorStoreState },
  useDiagnosticsStore: { getState: () => diagnosticsState },
  usePerformanceModeStore: { getState: () => performanceModeState },
}));
vi.mock("@/store/recipeConflictStore", () => ({
  useRecipeConflictStore: { getState: () => ({ requestConflict: requestConflictMock }) },
}));
vi.mock("@/store/perfMetricsStore", () => ({
  usePerfMetricsStore: { getState: () => perfMetricsState },
}));
vi.mock("@/store/createWorktreeStore", () => ({
  getCurrentViewStore: () => ({ getState: () => worktreeStoreState }),
}));
vi.mock("@/services/ActionService", () => ({
  installE2EActionDispatchBridge: installE2EActionDispatchBridgeMock,
}));
vi.mock("@/lazyPanels", () => ({
  loadE2ENotificationBackdoor: loadE2ENotificationBackdoorMock,
}));

import { useE2EBridges } from "../useE2EBridges";

const E2E_GLOBAL_KEYS = [
  "__DAINTREE_E2E_ERROR_STORE__",
  "__DAINTREE_E2E_ADD_ERROR__",
  "__DAINTREE_E2E_CLEAR_ERRORS__",
  "__DAINTREE_E2E_WORKTREES__",
  "__DAINTREE_E2E_TRIGGER_RECIPE_CONFLICT__",
  "__DAINTREE_E2E_DIAGNOSTICS_STATE__",
  "__DAINTREE_E2E_OPEN_DIAGNOSTICS__",
  "__DAINTREE_E2E_PERF_METRICS_STATE__",
  "__DAINTREE_E2E_SET_PERF_METRIC__",
  "__DAINTREE_E2E_PERF_MODE_STATE__",
  "__DAINTREE_E2E_SET_PERF_MODE__",
] as const;

describe("useE2EBridges", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.__DAINTREE_E2E_MODE__ = undefined;
    for (const key of E2E_GLOBAL_KEYS) {
      delete window[key];
    }
    delete window.__daintreeNotificationsE2E;
  });

  it("always installs the ActionService dispatch bridge, regardless of E2E mode", () => {
    renderHook(() => useE2EBridges());
    expect(installE2EActionDispatchBridgeMock).toHaveBeenCalledTimes(1);
  });

  it("attaches no E2E store globals when __DAINTREE_E2E_MODE__ is not true", () => {
    renderHook(() => useE2EBridges());
    for (const key of E2E_GLOBAL_KEYS) {
      expect(window[key]).toBeUndefined();
    }
    expect(loadE2ENotificationBackdoorMock).not.toHaveBeenCalled();
  });

  it("attaches all E2E store globals and lazy-loads the notification backdoor when E2E mode is true", async () => {
    window.__DAINTREE_E2E_MODE__ = true;
    renderHook(() => useE2EBridges());

    for (const key of E2E_GLOBAL_KEYS) {
      expect(typeof window[key]).toBe("function");
    }

    expect(loadE2ENotificationBackdoorMock).toHaveBeenCalledTimes(1);
    await Promise.resolve();
    await Promise.resolve();
    expect(installE2ENotificationBackdoorMock).toHaveBeenCalledTimes(1);
  });

  it("exposes the error store accessor via __DAINTREE_E2E_ERROR_STORE__", () => {
    window.__DAINTREE_E2E_MODE__ = true;
    renderHook(() => useE2EBridges());

    const result = window.__DAINTREE_E2E_ERROR_STORE__?.();
    expect(result).toEqual([
      { id: "err-1", source: "test", message: "boom", fromPreviousSession: false },
    ]);
  });

  it("exposes the renderer worktree snapshot via __DAINTREE_E2E_WORKTREES__", () => {
    window.__DAINTREE_E2E_MODE__ = true;
    renderHook(() => useE2EBridges());

    expect(window.__DAINTREE_E2E_WORKTREES__?.()).toEqual([
      {
        id: "wt-1",
        branch: "feature/e2e",
        resourceConnectCommand: "ssh e2e-host",
      },
    ]);
  });

  it("routes __DAINTREE_E2E_TRIGGER_RECIPE_CONFLICT__ to the recipe conflict store", () => {
    window.__DAINTREE_E2E_MODE__ = true;
    renderHook(() => useE2EBridges());

    window.__DAINTREE_E2E_TRIGGER_RECIPE_CONFLICT__?.("my-recipe");
    expect(requestConflictMock).toHaveBeenCalledWith({
      recipeId: "inrepo-my-recipe",
      recipeName: "my-recipe",
      updates: { name: "my-recipe" },
    });
  });

  it("deletes every E2E global on unmount", async () => {
    window.__DAINTREE_E2E_MODE__ = true;
    const { unmount } = renderHook(() => useE2EBridges());

    for (const key of E2E_GLOBAL_KEYS) {
      expect(window[key]).toBeDefined();
    }
    await Promise.resolve();
    await Promise.resolve();
    expect(window.__daintreeNotificationsE2E).toBeDefined();

    unmount();

    for (const key of E2E_GLOBAL_KEYS) {
      expect(window[key]).toBeUndefined();
    }
    expect(window.__daintreeNotificationsE2E).toBeUndefined();
  });
});
