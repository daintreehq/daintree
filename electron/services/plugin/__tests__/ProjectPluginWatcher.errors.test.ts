import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { promises as fsp } from "fs";
import os from "os";
import path from "path";

import type { SubscribeCallback } from "@parcel/watcher";

/**
 * Subscription errors cannot be provoked from outside a real native watcher, so
 * this suite captures the callback and fires them itself. Everything else —
 * discovery, fingerprints, the settle — runs against a real temp directory.
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
import { ProjectPluginWatcher, type ProjectPluginWatcherTimings } from "../ProjectPluginWatcher.js";
import { discoverProjectPlugins } from "../projectPluginDiscovery.js";

const PROJECT_ID = "project";
const PLUGIN = "acme.hello";
/** Distinct from every other delay in play, so a scheduled re-arm is identifiable. */
const REARM_DELAY_MS = 13;

const RESCAN_MESSAGES = [
  "Events were dropped by the FSEvents client. File system must be re-scanned.",
  "Events were dropped by the kernel. File system must be re-scanned.",
  "Too many events. File system must be re-scanned.",
];

describe("ProjectPluginWatcher subscription errors", () => {
  let root: string;
  let pluginDir: string;
  let watcher: ProjectPluginWatcher;
  let reload: ReturnType<typeof vi.fn<() => Promise<void>>>;
  let now: number;

  function makeWatcher(timings: Partial<ProjectPluginWatcherTimings> = {}): void {
    watcher = new ProjectPluginWatcher({
      discover: discoverProjectPlugins,
      loadedManifestIds: () => [PLUGIN],
      reload,
      viewGenerationsAllocated: () => 0,
      resolveGitDir: async () => null,
      timings: { debounceMs: 5, rearmDelayMs: REARM_DELAY_MS, ...timings },
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
    const state = internals.states.get(PROJECT_ID);
    return state !== undefined && state.timer === null && !state.running;
  }

  /**
   * Fire a fatal error and require that it schedules no re-arm. Checked at the
   * scheduling call rather than by waiting, which a slow machine could turn
   * into a false pass.
   */
  function fireFatalExpectingNoRetry(): void {
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    latest().callback(new Error("Unable to watch directory"), []);
    const retried = setTimeoutSpy.mock.calls.some(([, delay]) => delay === REARM_DELAY_MS);
    setTimeoutSpy.mockRestore();
    expect(retried).toBe(false);
    expect(watcher.isWatching(PROJECT_ID)).toBe(false);
  }

  async function fireFatalAndAwaitRearm(): Promise<void> {
    const count = subscriptions.length;
    latest().callback(new Error("Unable to watch directory"), []);
    expect(await waitFor(() => subscriptions.length === count + 1)).toBe(true);
    expect(await waitFor(() => watcher.isWatching(PROJECT_ID))).toBe(true);
  }

  beforeEach(async () => {
    subscriptions.length = 0;
    vi.clearAllMocks();
    now = 1_000;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    // Realpath, because the watcher attributes events against the resolved root.
    root = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), "dt-ppw-errors-")));
    pluginDir = path.join(root, ".daintree", "plugins", PLUGIN);
    await fsp.mkdir(path.join(pluginDir, "dist"), { recursive: true });
    await fsp.writeFile(
      path.join(pluginDir, "plugin.json"),
      JSON.stringify({
        name: PLUGIN,
        version: "1.0.0",
        displayName: PLUGIN,
        main: "dist/index.js",
        scope: "project",
        activationEvents: [],
        contributes: {},
      })
    );
    await fsp.writeFile(path.join(pluginDir, "dist", "index.js"), "export function activate() {}\n");
    reload = vi.fn(async () => {});
  });

  afterEach(async () => {
    watcher.dispose();
    vi.restoreAllMocks();
    await fsp.rm(root, { recursive: true, force: true });
  });

  it.each(RESCAN_MESSAGES)("keeps the stream and rescans on %s", async (message) => {
    makeWatcher();
    await watcher.ensure(PROJECT_ID, root);
    expect(watcher.isWatching(PROJECT_ID)).toBe(true);

    // Written with no event for it: only a full rescan can find this.
    await fsp.writeFile(path.join(pluginDir, "dist", "index.js"), "//rebuilt while dropped\n");
    latest().callback(new Error(message), []);

    expect(await waitFor(() => reload.mock.calls.length === 1)).toBe(true);
    expect(reload).toHaveBeenCalledWith(PROJECT_ID, root, [PLUGIN]);
    expect(subscribeParcelWatcher).toHaveBeenCalledTimes(1);
    expect(latest().unsubscribe).not.toHaveBeenCalled();
    expect(watcher.isWatching(PROJECT_ID)).toBe(true);
  });

  it("keeps delivering events on the same stream after a rescan notice", async () => {
    makeWatcher();
    await watcher.ensure(PROJECT_ID, root);
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
    await watcher.ensure(PROJECT_ID, root);
    const first = latest();

    // FSEvents stops the stream on a root removal, notice or not.
    const count = subscriptions.length;
    first.callback(new Error(RESCAN_MESSAGES[0]), [
      { type: "delete", path: path.join(root, ".daintree", "plugins") },
    ]);

    expect(await waitFor(() => subscriptions.length === count + 1)).toBe(true);
    expect(first.unsubscribe).toHaveBeenCalledTimes(1);
  });

  it("still tears down and re-arms on a fatal error", async () => {
    makeWatcher();
    await watcher.ensure(PROJECT_ID, root);
    const first = latest();

    await fireFatalAndAwaitRearm();

    expect(first.unsubscribe).toHaveBeenCalledTimes(1);
    expect(subscribeParcelWatcher).toHaveBeenCalledTimes(2);
  });

  it("does not refund the budget to a subscription that fails again within the healthy interval", async () => {
    makeWatcher({ rearmMaxAttempts: 2, rearmHealthyMs: 60_000 });
    await watcher.ensure(PROJECT_ID, root);

    // Each re-arm succeeds, then dies just short of the healthy interval.
    for (let i = 0; i < 2; i++) {
      now += 59_999;
      await fireFatalAndAwaitRearm();
    }
    now += 59_999;
    fireFatalExpectingNoRetry();
    expect(subscribeParcelWatcher).toHaveBeenCalledTimes(3);
  });

  it("restores the budget once a subscription has stayed up for the healthy interval", async () => {
    makeWatcher({ rearmMaxAttempts: 1, rearmHealthyMs: 60_000 });
    await watcher.ensure(PROJECT_ID, root);

    await fireFatalAndAwaitRearm();
    // The budget is spent, but this subscription has now proven itself.
    now += 60_000;
    await fireFatalAndAwaitRearm();
    expect(subscribeParcelWatcher).toHaveBeenCalledTimes(3);

    // And a failure straight after that re-arm is back on a spent budget.
    fireFatalExpectingNoRetry();
  });
});
