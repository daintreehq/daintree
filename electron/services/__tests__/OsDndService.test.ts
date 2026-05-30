import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const execFileSyncMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", () => ({
  execFileSync: execFileSyncMock,
}));

const systemPreferencesMock = vi.hoisted(() => {
  const handlers = new Map<number, () => void>();
  let nextId = 1;
  const subscribeNotification = vi.fn((_name: string, cb: () => void): number => {
    const id = nextId++;
    handlers.set(id, cb);
    return id;
  });
  const unsubscribeNotification = vi.fn((id: number): void => {
    handlers.delete(id);
  });
  return {
    subscribeNotification,
    unsubscribeNotification,
    __fireByName(name: string): void {
      // Each subscribe call records its name on the mock's call list; find
      // the id by index and invoke its handler.
      const calls = subscribeNotification.mock.calls;
      for (let i = 0; i < calls.length; i++) {
        if (calls[i]?.[0] === name) {
          const id = i + 1;
          handlers.get(id)?.();
        }
      }
    },
    __reset(): void {
      handlers.clear();
      nextId = 1;
      subscribeNotification.mockClear();
      unsubscribeNotification.mockClear();
    },
  };
});

vi.mock("electron", () => ({
  systemPreferences: systemPreferencesMock,
}));

import { __resetOsDndServiceForTests, getOsDndService } from "../OsDndService.js";

const originalPlatform = process.platform;

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, "platform", { value: platform, configurable: true });
}

beforeEach(() => {
  execFileSyncMock.mockReset();
  systemPreferencesMock.__reset();
  __resetOsDndServiceForTests();
});

afterEach(() => {
  __resetOsDndServiceForTests();
  setPlatform(originalPlatform);
});

describe("OsDndService — macOS", () => {
  beforeEach(() => {
    setPlatform("darwin");
  });

  it("initial probe reads Focus mode identifier from Assertions.json (active → true)", () => {
    execFileSyncMock.mockReturnValueOnce("com.apple.donotdisturb.mode.default\n");
    const svc = getOsDndService();
    svc.initialize();
    expect(svc.getState()).toBe(true);
  });

  it("initial probe with empty plutil output reports DND off", () => {
    execFileSyncMock.mockReturnValueOnce("");
    const svc = getOsDndService();
    svc.initialize();
    expect(svc.getState()).toBe(false);
  });

  it("initial probe failure (file missing / plutil throws) reports DND off (no assertion present)", () => {
    execFileSyncMock.mockImplementation(() => {
      throw new Error("ENOENT");
    });
    const svc = getOsDndService();
    svc.initialize();
    expect(svc.getState()).toBe(false);
  });

  it("subscribes to both enabled and disabled Darwin notifications", () => {
    execFileSyncMock.mockReturnValueOnce("");
    const svc = getOsDndService();
    svc.initialize();
    const names = systemPreferencesMock.subscribeNotification.mock.calls.map((c) => c[0]);
    expect(names).toContain("_NSDoNotDisturbEnabledNotification");
    expect(names).toContain("_NSDoNotDisturbDisabledNotification");
  });

  it("flips state to true on the enabled notification and notifies listeners", () => {
    execFileSyncMock.mockReturnValueOnce("");
    const svc = getOsDndService();
    svc.initialize();
    expect(svc.getState()).toBe(false);

    const listener = vi.fn();
    svc.onStateChanged(listener);

    systemPreferencesMock.__fireByName("_NSDoNotDisturbEnabledNotification");
    expect(svc.getState()).toBe(true);
    expect(listener).toHaveBeenCalledWith(true);
  });

  it("flips state to false on the disabled notification", () => {
    execFileSyncMock.mockReturnValueOnce("com.apple.focus.work\n");
    const svc = getOsDndService();
    svc.initialize();
    expect(svc.getState()).toBe(true);

    const listener = vi.fn();
    svc.onStateChanged(listener);

    systemPreferencesMock.__fireByName("_NSDoNotDisturbDisabledNotification");
    expect(svc.getState()).toBe(false);
    expect(listener).toHaveBeenCalledWith(false);
  });

  it("does not notify listeners on a no-op transition (already in the target state)", () => {
    execFileSyncMock.mockReturnValueOnce("");
    const svc = getOsDndService();
    svc.initialize();

    const listener = vi.fn();
    svc.onStateChanged(listener);

    // Service is already at `false`; firing the disabled event must not
    // re-broadcast.
    systemPreferencesMock.__fireByName("_NSDoNotDisturbDisabledNotification");
    expect(listener).not.toHaveBeenCalled();
  });

  it("initialize is idempotent — repeat calls do not re-subscribe", () => {
    execFileSyncMock.mockReturnValue("");
    const svc = getOsDndService();
    svc.initialize();
    const firstCount = systemPreferencesMock.subscribeNotification.mock.calls.length;
    svc.initialize();
    expect(systemPreferencesMock.subscribeNotification.mock.calls.length).toBe(firstCount);
  });

  it("dispose unsubscribes every notification and clears state", () => {
    execFileSyncMock.mockReturnValueOnce("");
    const svc = getOsDndService();
    svc.initialize();
    const subCount = systemPreferencesMock.subscribeNotification.mock.calls.length;
    svc.dispose();
    expect(systemPreferencesMock.unsubscribeNotification.mock.calls.length).toBe(subCount);
    expect(svc.getState()).toBeUndefined();
  });

  it("dispose is safe to call before or after initialize", () => {
    const svc = getOsDndService();
    expect(() => svc.dispose()).not.toThrow();
    execFileSyncMock.mockReturnValueOnce("");
    svc.initialize();
    expect(() => svc.dispose()).not.toThrow();
    expect(() => svc.dispose()).not.toThrow();
  });

  it("onStateChanged returns an unsubscribe that detaches the listener", () => {
    execFileSyncMock.mockReturnValueOnce("");
    const svc = getOsDndService();
    svc.initialize();

    const listener = vi.fn();
    const off = svc.onStateChanged(listener);
    off();

    systemPreferencesMock.__fireByName("_NSDoNotDisturbEnabledNotification");
    expect(listener).not.toHaveBeenCalled();
  });

  it("dispose followed by initialize re-probes and re-subscribes", () => {
    execFileSyncMock.mockReturnValueOnce("");
    const svc = getOsDndService();
    svc.initialize();
    const firstSubCount = systemPreferencesMock.subscribeNotification.mock.calls.length;

    svc.dispose();
    expect(svc.getState()).toBeUndefined();

    execFileSyncMock.mockReturnValueOnce("com.apple.focus.work\n");
    svc.initialize();
    expect(svc.getState()).toBe(true);
    expect(systemPreferencesMock.subscribeNotification.mock.calls.length).toBe(firstSubCount * 2);
  });
});

describe("OsDndService — non-macOS platforms", () => {
  it("Linux returns undefined and skips subscribeNotification entirely", () => {
    setPlatform("linux");
    const svc = getOsDndService();
    svc.initialize();
    expect(svc.getState()).toBeUndefined();
    expect(systemPreferencesMock.subscribeNotification).not.toHaveBeenCalled();
  });

  it("Windows returns undefined and skips subscribeNotification entirely", () => {
    setPlatform("win32");
    const svc = getOsDndService();
    svc.initialize();
    expect(svc.getState()).toBeUndefined();
    expect(systemPreferencesMock.subscribeNotification).not.toHaveBeenCalled();
  });
});
