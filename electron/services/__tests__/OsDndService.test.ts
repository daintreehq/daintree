import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type ExecFileCallback = (err: Error | null, stdout: string, stderr: string) => void;

const childProcessMock = vi.hoisted(() => {
  const pending: ExecFileCallback[] = [];
  const children: Array<{ kill: ReturnType<typeof vi.fn> }> = [];
  const launch = (
    _file: string,
    _args: string[],
    _options: unknown,
    callback: ExecFileCallback
  ): { kill: ReturnType<typeof vi.fn> } => {
    pending.push(callback);
    const child = { kill: vi.fn() };
    children.push(child);
    return child;
  };
  const execFile = vi.fn(launch);
  const execFileSync = vi.fn();
  return {
    execFile,
    execFileSync,
    pending,
    children,
    __reset(): void {
      pending.length = 0;
      children.length = 0;
      // mockReset, not mockClear: an unconsumed mockImplementationOnce must
      // not leak into the next test.
      execFile.mockReset();
      execFile.mockImplementation(launch);
      execFileSync.mockReset();
    },
  };
});

vi.mock("node:child_process", () => ({
  execFile: childProcessMock.execFile,
  execFileSync: childProcessMock.execFileSync,
}));

const systemPreferencesMock = vi.hoisted(() => {
  const subscriptions = new Map<number, { name: string; callback: () => void }>();
  let nextId = 1;
  const subscribe = (name: string, callback: () => void): number => {
    const id = nextId++;
    subscriptions.set(id, { name, callback });
    return id;
  };
  const subscribeNotification = vi.fn(subscribe);
  const unsubscribeNotification = vi.fn((id: number): void => {
    subscriptions.delete(id);
  });
  return {
    subscribeNotification,
    unsubscribeNotification,
    __fireByName(name: string): void {
      for (const subscription of [...subscriptions.values()]) {
        if (subscription.name === name) subscription.callback();
      }
    },
    /** IDs handed back by successful subscribe calls, in call order. */
    __returnedIds(): number[] {
      return subscribeNotification.mock.results
        .filter((result) => result.type === "return")
        .map((result) => result.value as number);
    },
    /** The raw callback a subscribe call registered, even after unsubscribe. */
    __callbackAt(callIndex: number): () => void {
      const callback = subscribeNotification.mock.calls[callIndex]?.[1];
      if (!callback) throw new Error(`no subscribe call at ${callIndex}`);
      return callback;
    },
    __reset(): void {
      subscriptions.clear();
      nextId = 1;
      subscribeNotification.mockReset();
      subscribeNotification.mockImplementation(subscribe);
      unsubscribeNotification.mockClear();
    },
  };
});

vi.mock("electron", () => ({
  systemPreferences: systemPreferencesMock,
}));

import os from "node:os";
import path from "node:path";
import { __resetOsDndServiceForTests, getOsDndService } from "../OsDndService.js";

const originalPlatform = process.platform;

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, "platform", { value: platform, configurable: true });
}

function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/** Completes the oldest in-flight plutil probe and lets its continuation run. */
async function settleProbe(stdout: string, err: Error | null = null): Promise<void> {
  const callback = childProcessMock.pending.shift();
  if (!callback) throw new Error("no plutil probe in flight");
  callback(err, stdout, "");
  await flush();
}

async function initializeWithProbe(stdout: string): Promise<ReturnType<typeof getOsDndService>> {
  const svc = getOsDndService();
  svc.initialize();
  await settleProbe(stdout);
  return svc;
}

beforeEach(() => {
  __resetOsDndServiceForTests();
  childProcessMock.__reset();
  systemPreferencesMock.__reset();
});

afterEach(() => {
  __resetOsDndServiceForTests();
  setPlatform(originalPlatform);
});

describe("OsDndService — macOS", () => {
  beforeEach(() => {
    setPlatform("darwin");
  });

  it("starts the plutil probe asynchronously and never blocks on execFileSync", () => {
    const svc = getOsDndService();
    svc.initialize();

    expect(childProcessMock.execFileSync).not.toHaveBeenCalled();
    expect(childProcessMock.execFile).toHaveBeenCalledTimes(1);
    const [file, args, options] = childProcessMock.execFile.mock.calls[0]!;
    expect(file).toBe("/usr/bin/plutil");
    expect(args).toEqual([
      "-extract",
      "data.0.storeAssertionRecords.0.assertionDetailsModeIdentifier",
      "raw",
      "-o",
      "-",
      path.join(os.homedir(), "Library", "DoNotDisturb", "DB", "Assertions.json"),
    ]);
    // Hydration awaits this probe, so it must be bounded in time and output.
    const { encoding, timeout, maxBuffer } = options as {
      encoding: string;
      timeout: number;
      maxBuffer: number;
    };
    expect(encoding).toBe("utf8");
    expect(timeout).toBeGreaterThan(0);
    expect(timeout).toBeLessThanOrEqual(5000);
    expect(maxBuffer).toBeGreaterThan(0);
    expect(maxBuffer).toBeLessThanOrEqual(1024 * 1024);
    // Unknown until the probe settles: the sync audio gate treats this as
    // "do not gate".
    expect(svc.getState()).toBeUndefined();
  });

  it("initial probe reads Focus mode identifier from Assertions.json (active → true)", async () => {
    const svc = await initializeWithProbe("com.apple.donotdisturb.mode.default\n");
    expect(svc.getState()).toBe(true);
  });

  it("initial probe with empty plutil output reports DND off", async () => {
    const svc = await initializeWithProbe("");
    expect(svc.getState()).toBe(false);
  });

  it("initial probe with whitespace-only plutil output reports DND off", async () => {
    const svc = await initializeWithProbe("  \n");
    expect(svc.getState()).toBe(false);
  });

  it("initial probe failure (file missing / plutil errors or times out) reports DND off", async () => {
    const svc = getOsDndService();
    svc.initialize();
    // stdout is ignored on error: a timeout or maxBuffer overflow can leave
    // partial output behind.
    await settleProbe("com.apple.focus.work\n", new Error("ENOENT"));
    expect(svc.getState()).toBe(false);
  });

  it("a synchronous execFile throw reports DND off and settles readiness", async () => {
    childProcessMock.execFile.mockImplementationOnce(() => {
      throw new Error("spawn EAGAIN");
    });
    const svc = getOsDndService();
    svc.initialize();
    expect(svc.getState()).toBe(false);
    await expect(svc.getStateWhenReady()).resolves.toBe(false);
  });

  it("subscribes to both notifications before launching the probe", () => {
    getOsDndService().initialize();
    const subscribeOrders = systemPreferencesMock.subscribeNotification.mock.invocationCallOrder;
    const probeOrder = childProcessMock.execFile.mock.invocationCallOrder[0]!;
    expect(subscribeOrders).toHaveLength(2);
    for (const order of subscribeOrders) {
      expect(order).toBeLessThan(probeOrder);
    }
  });

  it("publishes the accepted probe result to listeners exactly once", async () => {
    const svc = getOsDndService();
    svc.initialize();
    const listener = vi.fn();
    svc.onStateChanged(listener);

    await settleProbe("com.apple.focus.work\n");
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith(true);
  });

  it("concurrent readiness callers share the single probe", async () => {
    const svc = getOsDndService();
    svc.initialize();
    const first = svc.getStateWhenReady();
    const second = svc.getStateWhenReady();

    await settleProbe("");
    await expect(Promise.all([first, second])).resolves.toEqual([false, false]);
    expect(childProcessMock.execFile).toHaveBeenCalledTimes(1);
  });

  it("getStateWhenReady waits for the in-flight probe and returns its boolean", async () => {
    const svc = getOsDndService();
    svc.initialize();

    let resolved: boolean | undefined | "pending" = "pending";
    const ready = svc.getStateWhenReady().then((value) => {
      resolved = value;
      return value;
    });
    await flush();
    expect(resolved).toBe("pending");

    await settleProbe("com.apple.focus.work\n");
    await expect(ready).resolves.toBe(true);
  });

  it("getStateWhenReady resolves immediately once the probe has settled", async () => {
    const svc = await initializeWithProbe("");
    await expect(svc.getStateWhenReady()).resolves.toBe(false);
  });

  it("a live enabled notification during the probe is not overwritten by the older probe result", async () => {
    const svc = getOsDndService();
    svc.initialize();
    const listener = vi.fn();
    svc.onStateChanged(listener);
    const ready = svc.getStateWhenReady();

    systemPreferencesMock.__fireByName("_NSDoNotDisturbEnabledNotification");
    expect(svc.getState()).toBe(true);
    expect(listener).toHaveBeenCalledWith(true);

    await settleProbe("");
    expect(svc.getState()).toBe(true);
    await expect(ready).resolves.toBe(true);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("keeps taking live notifications while the probe is in flight, and the last one wins", async () => {
    const svc = getOsDndService();
    svc.initialize();
    const listener = vi.fn();
    svc.onStateChanged(listener);
    const ready = svc.getStateWhenReady();

    systemPreferencesMock.__fireByName("_NSDoNotDisturbEnabledNotification");
    systemPreferencesMock.__fireByName("_NSDoNotDisturbDisabledNotification");
    await settleProbe("com.apple.focus.work\n");

    expect(svc.getState()).toBe(false);
    await expect(ready).resolves.toBe(false);
    expect(listener.mock.calls).toEqual([[true], [false]]);
  });

  it("a failed subscription leaves the other subscription and the probe working", async () => {
    systemPreferencesMock.subscribeNotification.mockImplementationOnce(() => {
      throw new Error("unsupported notification");
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const svc = getOsDndService();
      svc.initialize();

      expect(systemPreferencesMock.subscribeNotification).toHaveBeenCalledTimes(2);
      expect(childProcessMock.execFile).toHaveBeenCalledTimes(1);
      await settleProbe("com.apple.focus.work\n");
      expect(svc.getState()).toBe(true);

      systemPreferencesMock.__fireByName("_NSDoNotDisturbDisabledNotification");
      expect(svc.getState()).toBe(false);
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
  });

  it("a live disabled notification during the probe is not overwritten by the older probe result", async () => {
    const svc = getOsDndService();
    svc.initialize();
    const listener = vi.fn();
    svc.onStateChanged(listener);
    const ready = svc.getStateWhenReady();

    systemPreferencesMock.__fireByName("_NSDoNotDisturbDisabledNotification");
    expect(svc.getState()).toBe(false);
    expect(listener).toHaveBeenCalledWith(false);

    await settleProbe("com.apple.focus.work\n");
    expect(svc.getState()).toBe(false);
    await expect(ready).resolves.toBe(false);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("flips state to true on the enabled notification and notifies listeners", async () => {
    const svc = await initializeWithProbe("");
    expect(svc.getState()).toBe(false);

    const listener = vi.fn();
    svc.onStateChanged(listener);

    systemPreferencesMock.__fireByName("_NSDoNotDisturbEnabledNotification");
    expect(svc.getState()).toBe(true);
    expect(listener).toHaveBeenCalledWith(true);
  });

  it("flips state to false on the disabled notification", async () => {
    const svc = await initializeWithProbe("com.apple.focus.work\n");
    expect(svc.getState()).toBe(true);

    const listener = vi.fn();
    svc.onStateChanged(listener);

    systemPreferencesMock.__fireByName("_NSDoNotDisturbDisabledNotification");
    expect(svc.getState()).toBe(false);
    expect(listener).toHaveBeenCalledWith(false);
  });

  it("does not notify listeners on a no-op transition (already in the target state)", async () => {
    const svc = await initializeWithProbe("");

    const listener = vi.fn();
    svc.onStateChanged(listener);

    // Service is already at `false`; firing the disabled event must not
    // re-broadcast.
    systemPreferencesMock.__fireByName("_NSDoNotDisturbDisabledNotification");
    expect(listener).not.toHaveBeenCalled();
  });

  it("initialize is idempotent — repeat calls neither re-subscribe nor re-probe", () => {
    const svc = getOsDndService();
    svc.initialize();
    const firstCount = systemPreferencesMock.subscribeNotification.mock.calls.length;
    svc.initialize();
    expect(systemPreferencesMock.subscribeNotification.mock.calls.length).toBe(firstCount);
    expect(childProcessMock.execFile).toHaveBeenCalledTimes(1);
  });

  it("dispose unsubscribes every notification and clears state", async () => {
    const svc = await initializeWithProbe("");
    const subscribedIds = systemPreferencesMock.__returnedIds();
    expect(subscribedIds).toHaveLength(2);
    svc.dispose();
    const unsubscribedIds = systemPreferencesMock.unsubscribeNotification.mock.calls.map(
      ([id]) => id
    );
    expect(unsubscribedIds.sort()).toEqual([...subscribedIds].sort());
    expect(svc.getState()).toBeUndefined();
  });

  it("dispose detaches listeners from the next lifecycle", async () => {
    const svc = await initializeWithProbe("");
    const staleListener = vi.fn();
    svc.onStateChanged(staleListener);
    svc.dispose();

    svc.initialize();
    await settleProbe("com.apple.focus.work\n");
    systemPreferencesMock.__fireByName("_NSDoNotDisturbDisabledNotification");
    expect(staleListener).not.toHaveBeenCalled();
  });

  it("a notification callback from a disposed lifecycle cannot write into the next one", async () => {
    const svc = getOsDndService();
    svc.initialize();
    // Capture the first lifecycle's raw enabled callback: a notification
    // already queued when dispose ran can still be delivered.
    const staleEnabled = systemPreferencesMock.__callbackAt(0);
    svc.dispose();
    svc.initialize();
    const listener = vi.fn();
    svc.onStateChanged(listener);

    staleEnabled();
    expect(svc.getState()).toBeUndefined();
    expect(listener).not.toHaveBeenCalled();

    await settleProbe(""); // the disposed lifecycle's probe: discarded
    await settleProbe(""); // the fresh probe: accepted
    expect(svc.getState()).toBe(false);
    expect(listener).toHaveBeenCalledWith(false);
  });

  it("a waiter from a disposed lifecycle never reports the next lifecycle's state", async () => {
    const svc = getOsDndService();
    svc.initialize();
    const staleWaiter = svc.getStateWhenReady();
    svc.dispose();
    svc.initialize();
    // Synchronously, before the stale waiter can resume.
    systemPreferencesMock.__fireByName("_NSDoNotDisturbEnabledNotification");
    expect(svc.getState()).toBe(true);

    await expect(staleWaiter).resolves.toBeUndefined();
  });

  it("dispose kills the in-flight probe and settles waiters without its callback", async () => {
    const svc = getOsDndService();
    svc.initialize();
    const ready = svc.getStateWhenReady();
    svc.dispose();

    expect(childProcessMock.children[0]!.kill).toHaveBeenCalledTimes(1);
    await expect(ready).resolves.toBeUndefined();
  });

  it("a probe that settles after dispose does not write state", async () => {
    const svc = getOsDndService();
    svc.initialize();
    svc.dispose();

    await settleProbe("com.apple.focus.work\n");
    expect(svc.getState()).toBeUndefined();
  });

  it("a stale probe from before dispose cannot overwrite the next lifecycle's probe", async () => {
    const svc = getOsDndService();
    svc.initialize();
    svc.dispose();
    svc.initialize();
    expect(childProcessMock.execFile).toHaveBeenCalledTimes(2);
    const listener = vi.fn();
    svc.onStateChanged(listener);
    const ready = svc.getStateWhenReady();

    // The first (stale) probe settles active; the fresh one reports off.
    await settleProbe("com.apple.focus.work\n");
    expect(svc.getState()).toBeUndefined();
    expect(listener).not.toHaveBeenCalled();

    await settleProbe("");
    expect(svc.getState()).toBe(false);
    await expect(ready).resolves.toBe(false);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith(false);
  });

  it("onStateChanged returns an unsubscribe that detaches the listener", async () => {
    const svc = await initializeWithProbe("");

    const listener = vi.fn();
    const off = svc.onStateChanged(listener);
    off();

    systemPreferencesMock.__fireByName("_NSDoNotDisturbEnabledNotification");
    expect(listener).not.toHaveBeenCalled();
  });

  it("dispose followed by initialize re-probes and re-subscribes", async () => {
    const svc = await initializeWithProbe("");
    const firstSubCount = systemPreferencesMock.subscribeNotification.mock.calls.length;

    svc.dispose();
    expect(svc.getState()).toBeUndefined();

    svc.initialize();
    await settleProbe("com.apple.focus.work\n");
    expect(svc.getState()).toBe(true);
    expect(systemPreferencesMock.subscribeNotification.mock.calls.length).toBe(firstSubCount * 2);
  });
});

describe("OsDndService — non-macOS platforms", () => {
  it.each(["linux", "win32"] as const)(
    "%s returns undefined and skips the probe and subscribeNotification entirely",
    async (platform) => {
      setPlatform(platform);
      const svc = getOsDndService();
      svc.initialize();
      expect(svc.getState()).toBeUndefined();
      await expect(svc.getStateWhenReady()).resolves.toBeUndefined();
      expect(childProcessMock.execFile).not.toHaveBeenCalled();
      expect(systemPreferencesMock.subscribeNotification).not.toHaveBeenCalled();
    }
  );
});
