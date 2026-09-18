import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { promises as fsp } from "fs";
import os from "os";
import path from "path";

import type { SubscribeCallback } from "@parcel/watcher";

/**
 * Subscription errors cannot be provoked from outside a real native watcher, so
 * this suite captures the callback and fires them itself. Fingerprints and the
 * settle still run against a real temp directory.
 */
const { subscriptions } = vi.hoisted(() => ({
  subscriptions: [] as Array<{
    callback: SubscribeCallback;
    unsubscribe: ReturnType<typeof vi.fn<() => Promise<void>>>;
  }>,
}));

vi.mock("../../../utils/parcelWatcherBackend.js", () => ({
  subscribeParcelWatcher: vi.fn(async (_dir: string, callback: SubscribeCallback) => {
    const unsubscribe = vi.fn(async () => {});
    subscriptions.push({ callback, unsubscribe });
    return { unsubscribe };
  }),
}));

import { subscribeParcelWatcher } from "../../../utils/parcelWatcherBackend.js";
import {
  PluginDevArtifactWatcher,
  type PluginDevArtifactWatcherTimings,
} from "../PluginDevArtifactWatcher.js";

const PLUGIN_ID = "acme.dev";

const RESCAN_MESSAGES = [
  "Events were dropped by the FSEvents client. File system must be re-scanned.",
  "Events were dropped by the kernel. File system must be re-scanned.",
  "Too many events. File system must be re-scanned.",
];

describe("PluginDevArtifactWatcher subscription errors", () => {
  let root: string;
  let pluginDir: string;
  let watcher: PluginDevArtifactWatcher;
  let reload: ReturnType<typeof vi.fn<() => Promise<boolean>>>;
  let now: number;

  function makeWatcher(timings: Partial<PluginDevArtifactWatcherTimings> = {}): void {
    watcher = new PluginDevArtifactWatcher({
      reload,
      onStateChange: () => {},
      timings: { settleDebounceMs: 5, stabilityMs: 5, rearmDelayMs: 5, ...timings },
    });
  }

  function latest(): (typeof subscriptions)[number] {
    const entry = subscriptions.at(-1);
    if (!entry) throw new Error("no subscription");
    return entry;
  }

  /** Real-time poll; `performance.now` is frozen by the clock spy. */
  async function waitFor(predicate: () => boolean): Promise<boolean> {
    const deadline = Date.now() + 4_000;
    while (Date.now() < deadline) {
      if (predicate()) return true;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    return predicate();
  }

  /** No timer pending and no settle running: the last scheduled rescan finished. */
  function isIdle(): boolean {
    const internals = watcher as unknown as {
      states: Map<string, { timer: unknown; running: boolean }>;
    };
    const state = internals.states.get(PLUGIN_ID);
    return state !== undefined && state.timer === null && !state.running;
  }

  async function arm(): Promise<void> {
    watcher.ensure(PLUGIN_ID, pluginDir);
    expect(await waitFor(() => watcher.stateOf(PLUGIN_ID)?.state === "watching")).toBe(true);
  }

  async function fireFatalAndAwaitRearm(): Promise<void> {
    const count = subscriptions.length;
    latest().callback(new Error("Unable to watch directory"), []);
    expect(await waitFor(() => subscriptions.length === count + 1)).toBe(true);
  }

  beforeEach(async () => {
    subscriptions.length = 0;
    vi.clearAllMocks();
    // Drops any one-shot rejection a failed test left queued, and restores the
    // factory implementation.
    vi.mocked(subscribeParcelWatcher).mockReset();
    now = 1_000;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    // Realpath, because the watcher attributes events against the resolved root.
    root = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), "dt-pdaw-errors-")));
    pluginDir = path.join(root, PLUGIN_ID);
    await fsp.mkdir(path.join(pluginDir, "dist"), { recursive: true });
    await fsp.writeFile(
      path.join(pluginDir, "plugin.json"),
      JSON.stringify({ name: PLUGIN_ID, version: "1.0.0", main: "dist/index.js" })
    );
    await fsp.writeFile(
      path.join(pluginDir, "dist", "index.js"),
      "export function activate() {}\n"
    );
    reload = vi.fn(async () => true);
  });

  afterEach(async () => {
    watcher.dispose();
    vi.restoreAllMocks();
    await fsp.rm(root, { recursive: true, force: true });
  });

  it.each(RESCAN_MESSAGES)("keeps the stream and rescans on %s", async (message) => {
    makeWatcher();
    await arm();

    // Written with no event for it: only a rescan can find this.
    await fsp.writeFile(path.join(pluginDir, "dist", "index.js"), "//rebuilt while dropped\n");
    latest().callback(new Error(message), []);

    expect(await waitFor(() => reload.mock.calls.length === 1)).toBe(true);
    expect(subscribeParcelWatcher).toHaveBeenCalledTimes(1);
    expect(latest().unsubscribe).not.toHaveBeenCalled();
    expect(watcher.stateOf(PLUGIN_ID)?.state).toBe("watching");
  });

  it("keeps delivering events on the same stream after a rescan notice", async () => {
    makeWatcher();
    await arm();
    const entry = latest();

    entry.callback(new Error(RESCAN_MESSAGES[0]), []);
    // Let the notice's own rescan finish first, so it cannot be what finds the
    // write below.
    expect(await waitFor(isIdle)).toBe(true);
    expect(reload).not.toHaveBeenCalled();

    const entryPath = path.join(pluginDir, "dist", "index.js");
    await fsp.writeFile(entryPath, "//saved after the notice\n");
    entry.callback(null, [{ type: "update", path: entryPath }]);

    expect(await waitFor(() => reload.mock.calls.length === 1)).toBe(true);
    expect(subscribeParcelWatcher).toHaveBeenCalledTimes(1);
    expect(entry.unsubscribe).not.toHaveBeenCalled();
  });

  it("re-arms when the rescan notice arrives with the removal of the watched root", async () => {
    makeWatcher();
    await arm();
    const first = latest();

    // FSEvents stops the stream on a root removal, notice or not.
    const count = subscriptions.length;
    first.callback(new Error(RESCAN_MESSAGES[0]), [{ type: "delete", path: pluginDir }]);

    expect(await waitFor(() => subscriptions.length === count + 1)).toBe(true);
    expect(first.unsubscribe).toHaveBeenCalledTimes(1);
  });

  it("still tears down and re-arms on a fatal error", async () => {
    makeWatcher();
    await arm();
    const first = latest();

    await fireFatalAndAwaitRearm();

    expect(first.unsubscribe).toHaveBeenCalledTimes(1);
    expect(subscribeParcelWatcher).toHaveBeenCalledTimes(2);
    expect(watcher.stateOf(PLUGIN_ID)?.state).toBe("watching");
  });

  it("does not refund the budget to a subscription that fails again within the healthy interval", async () => {
    makeWatcher({ rearmMaxAttempts: 2, rearmHealthyMs: 60_000 });
    await arm();

    // Each re-arm succeeds, then dies just short of the healthy interval.
    for (let i = 0; i < 2; i++) {
      now += 59_999;
      await fireFatalAndAwaitRearm();
    }
    now += 59_999;
    latest().callback(new Error("Unable to watch directory"), []);

    expect(watcher.stateOf(PLUGIN_ID)?.state).toBe("degraded");
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(subscribeParcelWatcher).toHaveBeenCalledTimes(3);
  });

  it("gives no healthy credit to re-arms whose subscribe is rejected", async () => {
    makeWatcher({ rearmMaxAttempts: 2, rearmHealthyMs: 60_000 });
    await arm();
    vi.mocked(subscribeParcelWatcher)
      .mockRejectedValueOnce(new Error("EACCES"))
      .mockRejectedValueOnce(new Error("EACCES"));

    // Long after the arm, so this failure earns a fresh budget — but the
    // rejected attempts that follow never held a subscription and must not.
    now += 120_000;
    latest().callback(new Error("Unable to watch directory"), []);

    expect(await waitFor(() => watcher.stateOf(PLUGIN_ID)?.state === "degraded")).toBe(true);
    expect(subscribeParcelWatcher).toHaveBeenCalledTimes(3);
  });

  it("restores the budget once a subscription has stayed up for the healthy interval", async () => {
    makeWatcher({ rearmMaxAttempts: 1, rearmHealthyMs: 60_000 });
    await arm();

    await fireFatalAndAwaitRearm();
    // The budget is spent, but this subscription has now proven itself.
    now += 60_000;
    await fireFatalAndAwaitRearm();
    expect(watcher.stateOf(PLUGIN_ID)?.state).toBe("watching");

    // And a failure straight after that re-arm is back on a spent budget.
    latest().callback(new Error("Unable to watch directory"), []);
    expect(watcher.stateOf(PLUGIN_ID)?.state).toBe("degraded");
  });
});
