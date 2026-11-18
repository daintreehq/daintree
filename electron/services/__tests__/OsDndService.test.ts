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

/** Assertions.json as `plutil -convert json` prints it while a Focus mode is on. */
function focusAssertions(modeIdentifier: string): string {
  return JSON.stringify({
    data: [
      {
        storeAssertionRecords: [
          {
            assertionUUID: "8C1D0A54-6A43-4C4B-9F57-3D2C1B0A9E11",
            assertionStartDateTimestamp: 784393200.5,
            assertionDetails: {
              assertionDetailsIdentifier: "com.apple.control-center.focus",
              assertionDetailsModeIdentifier: modeIdentifier,
              assertionDetailsReason: "user-action",
            },
          },
        ],
        storeInvalidationRecords: [],
      },
    ],
    header: { timestamp: 784393200.5, version: 2 },
  });
}

const ACTIVE = focusAssertions("com.apple.focus.work");

// Ending a Focus drops `storeAssertionRecords` rather than emptying it.
function inactiveAssertions(invalidations: number): string {
  return JSON.stringify({
    data: [
      {
        storeInvalidationRecords: Array.from({ length: invalidations }, (_, index) => ({
          invalidationAssertion: {
            assertionUUID: `8C1D0A54-6A43-4C4B-9F57-${String(index).padStart(12, "0")}`,
            assertionStartDateTimestamp: 784393200.5 + index,
            assertionDetails: {
              assertionDetailsIdentifier: "com.apple.control-center.focus",
              assertionDetailsModeIdentifier: "com.apple.focus.work",
              assertionDetailsReason: "user-action",
            },
          },
          invalidationDate: 784396800.5 + index,
          invalidationReason: "user-action",
        })),
      },
    ],
    header: { timestamp: 784393200.5, version: 2 },
  });
}

const INACTIVE = inactiveAssertions(1);
// Invalidation history accumulates, so the probe's output cap must hold it.
const INACTIVE_LONG_HISTORY = inactiveAssertions(200);

function execError(message: string, extra: Record<string, unknown> = {}): Error {
  return Object.assign(new Error(message), extra);
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

  it("starts the plutil probe asynchronously, bounded in time and output, never via execFileSync", () => {
    const svc = getOsDndService();
    svc.initialize();

    expect(childProcessMock.execFileSync).not.toHaveBeenCalled();
    expect(childProcessMock.execFile).toHaveBeenCalledTimes(1);
    const [file, args, options] = childProcessMock.execFile.mock.calls[0]!;
    expect(file).toBe("/usr/bin/plutil");
    // The whole file, not one key path: a missing key path fails plutil the
    // same way an unreadable file does, and Focus being off removes the key.
    expect(args).toEqual([
      "-convert",
      "json",
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
    expect(maxBuffer).toBeGreaterThanOrEqual(Buffer.byteLength(INACTIVE_LONG_HISTORY));
    expect(maxBuffer).toBeLessThanOrEqual(1024 * 1024);
    // Unknown until the probe settles: the sync audio gate treats this as
    // "do not gate".
    expect(svc.getState()).toBeUndefined();
  });

  it.each(["com.apple.donotdisturb.mode.default", "com.apple.focus.work"])(
    "an assertion naming %s reports Focus on",
    async (mode) => {
      const svc = await initializeWithProbe(focusAssertions(mode));
      expect(svc.getState()).toBe(true);
      await expect(svc.getStateWhenReady()).resolves.toBe(true);
    }
  );

  it.each([
    ["a store without assertions", {}],
    ["a store that is not an object", "store"],
    ["a store whose records are not an array", { storeAssertionRecords: {} }],
  ])("an active assertion after %s still reports Focus on", async (_case, sibling) => {
    const active = JSON.parse(ACTIVE) as { data: unknown[] };
    const svc = await initializeWithProbe(JSON.stringify({ data: [sibling, ...active.data] }));
    expect(svc.getState()).toBe(true);
  });

  it("an active assertion before a store without assertions still reports Focus on", async () => {
    const active = JSON.parse(ACTIVE) as { data: unknown[] };
    const svc = await initializeWithProbe(
      JSON.stringify({ data: [...active.data, {}, { storeAssertionRecords: [] }] })
    );
    expect(svc.getState()).toBe(true);
  });

  it("an active assertion after a malformed record in the same store reports Focus on", async () => {
    const svc = await initializeWithProbe(
      JSON.stringify({
        data: [
          {
            storeAssertionRecords: [
              null,
              { assertionDetails: null },
              { assertionDetails: { assertionDetailsModeIdentifier: "com.apple.focus.work" } },
            ],
          },
        ],
      })
    );
    expect(svc.getState()).toBe(true);
  });

  it.each([
    ["the assertion records key is absent", INACTIVE],
    [
      "the assertion records are empty",
      JSON.stringify({ data: [{ storeAssertionRecords: [] }], header: { version: 2 } }),
    ],
    [
      "no store holds assertions",
      JSON.stringify({ data: [{}, { storeAssertionRecords: [] }], header: { version: 2 } }),
    ],
    ["only a long invalidation history remains", INACTIVE_LONG_HISTORY],
  ])("a readable file where %s reports Focus off", async (_case, stdout) => {
    const svc = getOsDndService();
    svc.initialize();
    const listener = vi.fn();
    svc.onStateChanged(listener);

    await settleProbe(stdout);
    expect(svc.getState()).toBe(false);
    await expect(svc.getStateWhenReady()).resolves.toBe(false);
    expect(listener).toHaveBeenCalledWith(false);
  });

  it.each([
    // A non-FDA read of the TCC-protected DB can surface as a missing file.
    ["plutil cannot open the file", execError("Command failed", { code: 1 })],
    [
      "plutil cannot be spawned",
      execError("spawn /usr/bin/plutil ENOENT", {
        code: "ENOENT",
        errno: -2,
        syscall: "spawn /usr/bin/plutil",
      }),
    ],
    [
      "plutil times out",
      execError("Command failed", { killed: true, signal: "SIGTERM", code: null }),
    ],
    [
      "the output overflows maxBuffer",
      execError("stdout maxBuffer length exceeded", { code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" }),
    ],
  ])("leaves Focus unknown when %s, whatever stdout holds", async (_case, err) => {
    const svc = getOsDndService();
    svc.initialize();
    const listener = vi.fn();
    svc.onStateChanged(listener);

    // A killed or overflowing probe can leave partial output behind.
    await settleProbe(ACTIVE, err);
    expect(svc.getState()).toBeUndefined();
    await expect(svc.getStateWhenReady()).resolves.toBeUndefined();
    expect(listener).not.toHaveBeenCalled();
  });

  it.each([
    ["empty output", ""],
    ["whitespace-only output", "  \n"],
    ["output that is not JSON", "com.apple.focus.work\n"],
    ["a null root", "null"],
    ["a JSON array root", "[]"],
    ["a root without a data array", JSON.stringify({ header: { version: 2 } })],
    ["a data value that is not an array", JSON.stringify({ data: {} })],
    ["an empty data array", JSON.stringify({ data: [] })],
    ["a store that is not an object", JSON.stringify({ data: ["store"] })],
    ["a null store", JSON.stringify({ data: [null] })],
    ["a store that is an array", JSON.stringify({ data: [[]] })],
    [
      "assertion records that are not an array",
      JSON.stringify({ data: [{ storeAssertionRecords: {} }] }),
    ],
    ["null assertion records", JSON.stringify({ data: [{ storeAssertionRecords: null }] })],
    [
      "a malformed store followed by an empty one",
      JSON.stringify({ data: [{ storeAssertionRecords: {} }, {}] }),
    ],
    ["a null record", JSON.stringify({ data: [{ storeAssertionRecords: [null] }] })],
    [
      "a record with null details",
      JSON.stringify({ data: [{ storeAssertionRecords: [{ assertionDetails: null }] }] }),
    ],
    [
      "a record with a numeric mode identifier",
      JSON.stringify({
        data: [
          { storeAssertionRecords: [{ assertionDetails: { assertionDetailsModeIdentifier: 1 } }] },
        ],
      }),
    ],
    [
      "a record whose mode identifier is not under assertionDetails",
      JSON.stringify({
        data: [
          { storeAssertionRecords: [{ assertionDetailsModeIdentifier: "com.apple.focus.work" }] },
        ],
      }),
    ],
    [
      "a record with a blank mode identifier",
      JSON.stringify({
        data: [
          {
            storeAssertionRecords: [{ assertionDetails: { assertionDetailsModeIdentifier: " " } }],
          },
        ],
      }),
    ],
  ])("leaves Focus unknown for unreadable data: %s", async (_case, stdout) => {
    const svc = getOsDndService();
    svc.initialize();
    const listener = vi.fn();
    svc.onStateChanged(listener);

    await settleProbe(stdout);
    expect(svc.getState()).toBeUndefined();
    await expect(svc.getStateWhenReady()).resolves.toBeUndefined();
    expect(listener).not.toHaveBeenCalled();
  });

  it("a synchronous execFile throw leaves Focus unknown and settles readiness", async () => {
    childProcessMock.execFile.mockImplementationOnce(() => {
      throw new Error("spawn EAGAIN");
    });
    const svc = getOsDndService();
    svc.initialize();
    expect(svc.getState()).toBeUndefined();
    await expect(svc.getStateWhenReady()).resolves.toBeUndefined();
  });

  it("a live transition after an unknown probe sets the state", async () => {
    const svc = getOsDndService();
    svc.initialize();
    await settleProbe(ACTIVE, execError("Command failed", { code: 1 }));
    expect(svc.getState()).toBeUndefined();

    const listener = vi.fn();
    svc.onStateChanged(listener);
    systemPreferencesMock.__fireByName("_NSDoNotDisturbEnabledNotification");
    expect(svc.getState()).toBe(true);
    expect(listener).toHaveBeenCalledWith(true);
  });

  it("an unknown probe result never clears a live notification that landed first", async () => {
    const svc = getOsDndService();
    svc.initialize();
    const ready = svc.getStateWhenReady();

    systemPreferencesMock.__fireByName("_NSDoNotDisturbEnabledNotification");
    await settleProbe(INACTIVE, execError("Command failed", { killed: true, signal: "SIGTERM" }));

    expect(svc.getState()).toBe(true);
    await expect(ready).resolves.toBe(true);
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

    await settleProbe(ACTIVE);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith(true);
  });

  it("concurrent readiness callers share the single probe", async () => {
    const svc = getOsDndService();
    svc.initialize();
    const first = svc.getStateWhenReady();
    const second = svc.getStateWhenReady();

    await settleProbe(INACTIVE);
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

    await settleProbe(ACTIVE);
    await expect(ready).resolves.toBe(true);
  });

  it("getStateWhenReady resolves immediately once the probe has settled", async () => {
    const svc = await initializeWithProbe(INACTIVE);
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

    await settleProbe(INACTIVE);
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
    await settleProbe(ACTIVE);

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
      await settleProbe(ACTIVE);
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

    await settleProbe(ACTIVE);
    expect(svc.getState()).toBe(false);
    await expect(ready).resolves.toBe(false);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("flips state to true on the enabled notification and notifies listeners", async () => {
    const svc = await initializeWithProbe(INACTIVE);
    expect(svc.getState()).toBe(false);

    const listener = vi.fn();
    svc.onStateChanged(listener);

    systemPreferencesMock.__fireByName("_NSDoNotDisturbEnabledNotification");
    expect(svc.getState()).toBe(true);
    expect(listener).toHaveBeenCalledWith(true);
  });

  it("flips state to false on the disabled notification", async () => {
    const svc = await initializeWithProbe(ACTIVE);
    expect(svc.getState()).toBe(true);

    const listener = vi.fn();
    svc.onStateChanged(listener);

    systemPreferencesMock.__fireByName("_NSDoNotDisturbDisabledNotification");
    expect(svc.getState()).toBe(false);
    expect(listener).toHaveBeenCalledWith(false);
  });

  it("does not notify listeners on a no-op transition (already in the target state)", async () => {
    const svc = await initializeWithProbe(INACTIVE);

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
    const svc = await initializeWithProbe(INACTIVE);
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
    const svc = await initializeWithProbe(INACTIVE);
    const staleListener = vi.fn();
    svc.onStateChanged(staleListener);
    svc.dispose();

    svc.initialize();
    await settleProbe(ACTIVE);
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

    await settleProbe(INACTIVE); // the disposed lifecycle's probe: discarded
    await settleProbe(INACTIVE); // the fresh probe: accepted
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

    await settleProbe(ACTIVE);
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
    await settleProbe(ACTIVE);
    expect(svc.getState()).toBeUndefined();
    expect(listener).not.toHaveBeenCalled();

    await settleProbe(INACTIVE);
    expect(svc.getState()).toBe(false);
    await expect(ready).resolves.toBe(false);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith(false);
  });

  it("onStateChanged returns an unsubscribe that detaches the listener", async () => {
    const svc = await initializeWithProbe(INACTIVE);

    const listener = vi.fn();
    const off = svc.onStateChanged(listener);
    off();

    systemPreferencesMock.__fireByName("_NSDoNotDisturbEnabledNotification");
    expect(listener).not.toHaveBeenCalled();
  });

  it("dispose followed by initialize re-probes and re-subscribes", async () => {
    const svc = await initializeWithProbe(INACTIVE);
    const firstSubCount = systemPreferencesMock.subscribeNotification.mock.calls.length;

    svc.dispose();
    expect(svc.getState()).toBeUndefined();

    svc.initialize();
    await settleProbe(ACTIVE);
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
