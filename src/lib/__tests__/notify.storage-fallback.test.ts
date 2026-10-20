// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";

const originalLocalStorageDescriptor = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
const originalElectronDescriptor = Object.getOwnPropertyDescriptor(window, "electron");

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  if (originalLocalStorageDescriptor) {
    Object.defineProperty(globalThis, "localStorage", originalLocalStorageDescriptor);
  }
  if (originalElectronDescriptor) {
    Object.defineProperty(window, "electron", originalElectronDescriptor);
  } else {
    delete (window as Partial<Window>).electron;
  }
  vi.resetModules();
  vi.restoreAllMocks();
});

describe("storage fallback warning at cold boot (#13590)", () => {
  it("surfaces a hydration-time read failure once notify.ts registers its handler", async () => {
    vi.useFakeTimers();
    vi.resetModules();
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      writable: true,
      value: {
        getItem: () => {
          throw new Error("SecurityError");
        },
        setItem: () => {},
        removeItem: () => {},
      },
    });
    Object.defineProperty(window, "electron", {
      value: {
        notification: {
          showNative: vi.fn(),
          setSettings: vi.fn().mockResolvedValue(undefined),
          setSessionMuteUntil: vi.fn(),
        },
      },
      writable: true,
      configurable: true,
    });
    vi.spyOn(document, "hasFocus").mockReturnValue(true);

    // Importing notify.ts hydrates the notification stores (whose reads fail)
    // before its bottom-of-module handler registration flushes the latched notice.
    await import("../notify");
    const { useNotificationHistoryStore } =
      await import("../../store/slices/notificationHistorySlice");

    const warnings = useNotificationHistoryStore
      .getState()
      .entries.filter((entry) => entry.title === "Settings won't be saved");
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.type).toBe("warning");
  });
});
