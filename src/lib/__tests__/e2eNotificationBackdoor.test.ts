import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/store/notificationStore", () => ({
  GRID_BAR_DWELL_FLOOR_MS: 750,
  MAX_VISIBLE_TOASTS: 3,
  useNotificationStore: {
    getState: () => ({
      addNotification: vi.fn(() => "toast-id"),
      reset: vi.fn(),
    }),
    setState: vi.fn(),
  },
}));

vi.mock("@/store/slices/notificationHistorySlice", () => ({
  useNotificationHistoryStore: {
    getState: () => ({
      addEntry: vi.fn(() => "history-id"),
      archiveEntry: vi.fn(),
      clearAll: vi.fn(),
      snoozeThread: vi.fn(),
    }),
  },
}));

vi.mock("@/lib/notify", () => ({
  _resetCoalesceMap: vi.fn(),
  _resetEscalationTrackers: vi.fn(),
  _resetOverflowAnnouncements: vi.fn(),
  _resetPendingSuppressedForTest: vi.fn(),
  _resetRateLimitBuckets: vi.fn(),
  _setQuietUntil: vi.fn(),
}));

vi.mock("@/store/panelStore", () => ({
  usePanelStore: { setState: vi.fn() },
}));

vi.mock("@/store/safeModeStore", () => ({
  useSafeModeStore: { setState: vi.fn() },
}));

vi.mock("@/store/restoreConfirmationStore", () => ({
  useRestoreConfirmationStore: { setState: vi.fn() },
}));

type WindowSlot = { window?: unknown };

function setWindow(value: unknown): () => void {
  const original = (globalThis as WindowSlot).window;
  Object.defineProperty(globalThis, "window", {
    value,
    writable: true,
    configurable: true,
  });
  return () => {
    Object.defineProperty(globalThis, "window", {
      value: original,
      writable: true,
      configurable: true,
    });
  };
}

describe("e2eNotificationBackdoor gate", () => {
  let restore: (() => void) | null = null;

  afterEach(() => {
    restore?.();
    restore = null;
    vi.resetModules();
  });

  it("does not attach when __DAINTREE_E2E_MODE__ is absent", async () => {
    const fakeWindow: Record<string, unknown> = {};
    restore = setWindow(fakeWindow);

    vi.resetModules();
    await import("../e2eNotificationBackdoor");

    expect(fakeWindow.__daintreeNotificationsE2E).toBeUndefined();
  });

  it("can attach after the E2E mode flag appears", async () => {
    const fakeWindow: Record<string, unknown> = {};
    restore = setWindow(fakeWindow);

    vi.resetModules();
    const mod = await import("../e2eNotificationBackdoor");
    expect(fakeWindow.__daintreeNotificationsE2E).toBeUndefined();

    fakeWindow.__DAINTREE_E2E_MODE__ = true;
    mod.installE2ENotificationBackdoor();

    expect(fakeWindow.__daintreeNotificationsE2E).toMatchObject({
      GRID_BAR_DWELL_FLOOR_MS: 750,
      MAX_VISIBLE_TOASTS: 3,
    });
  });
});
