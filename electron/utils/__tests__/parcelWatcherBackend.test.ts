import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const { existsSyncMock, fsWatchMock, subscribeMock } = vi.hoisted(() => ({
  existsSyncMock: vi.fn(),
  fsWatchMock: vi.fn(),
  subscribeMock: vi.fn(),
}));

vi.mock("node:fs", () => ({
  existsSync: existsSyncMock,
  watch: fsWatchMock,
}));

vi.mock("@parcel/watcher", () => ({
  default: { subscribe: subscribeMock },
}));

import {
  MAX_PARCEL_EXCLUSION_PATHS,
  closeAllParcelWatcherSubscriptions,
  getParcelWatcherLifecycleStats,
  parcelWatcherBackendOption,
  resolveParcelWatcherExclusions,
  subscribeParcelWatcher,
} from "../parcelWatcherBackend.js";

const originalPlatform = process.platform;

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, "platform", { value: platform, configurable: true });
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("subscribeParcelWatcher", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Exercise the native lifecycle queue even when this suite itself runs on
    // a Windows CI host; Windows subscriptions intentionally take the fs.watch
    // path tested separately below.
    setPlatform("linux");
  });

  afterEach(() => setPlatform(originalPlatform));

  it.each([
    ["darwin", { backend: "fs-events" }],
    ["linux", { backend: "inotify" }],
    ["win32", {}],
    ["freebsd", {}],
  ] as const)("selects the safe backend contract on %s", (platform, expected) => {
    setPlatform(platform);
    expect(parcelWatcherBackendOption()).toEqual(expected);
  });

  it("waits for native unsubscribe before beginning the next lifecycle operation", async () => {
    const firstStop = deferred<void>();
    const firstNative = { unsubscribe: vi.fn(() => firstStop.promise) };
    const secondNative = { unsubscribe: vi.fn().mockResolvedValue(undefined) };
    subscribeMock.mockResolvedValueOnce(firstNative).mockResolvedValueOnce(secondNative);

    const first = await subscribeParcelWatcher("/first", vi.fn());
    const stopping = first.unsubscribe();
    const secondPending = subscribeParcelWatcher("/second", vi.fn());

    await vi.waitFor(() => expect(firstNative.unsubscribe).toHaveBeenCalledTimes(1));
    expect(subscribeMock).toHaveBeenCalledTimes(1);

    firstStop.resolve();
    await stopping;
    const second = await secondPending;

    expect(subscribeMock).toHaveBeenCalledTimes(2);
    await second.unsubscribe();
  });

  it("reports a native teardown as pending until it finishes, not when it is requested (#12460)", async () => {
    await closeAllParcelWatcherSubscriptions();
    expect(getParcelWatcherLifecycleStats()).toEqual({ subscriptions: 0, lifecycleOps: 0 });

    const stop = deferred<void>();
    const armed = deferred<{ unsubscribe: () => Promise<void> }>();
    subscribeMock
      .mockResolvedValueOnce({ unsubscribe: vi.fn(() => stop.promise) })
      .mockReturnValueOnce(armed.promise);
    try {
      const subscription = await subscribeParcelWatcher("/repo", vi.fn());
      expect(getParcelWatcherLifecycleStats()).toEqual({ subscriptions: 1, lifecycleOps: 0 });

      const stopping = subscription.unsubscribe();
      // Queued behind the teardown by the serialization lock.
      const queued = subscribeParcelWatcher("/other", vi.fn());
      expect(getParcelWatcherLifecycleStats()).toEqual({ subscriptions: 0, lifecycleOps: 2 });

      let drained = false;
      const draining = closeAllParcelWatcherSubscriptions().then(() => {
        drained = true;
      });
      await new Promise((done) => setImmediate(done));
      expect(drained).toBe(false);

      stop.resolve();
      await stopping;
      armed.resolve({ unsubscribe: vi.fn().mockResolvedValue(undefined) });
      await queued;
      await draining;
      expect(getParcelWatcherLifecycleStats()).toEqual({ subscriptions: 0, lifecycleOps: 0 });
    } finally {
      // A failed assertion above must not leave the process-global queue
      // blocked for the tests after this one.
      stop.resolve();
      armed.resolve({ unsubscribe: vi.fn().mockResolvedValue(undefined) });
      await closeAllParcelWatcherSubscriptions();
    }
  });

  it("coalesces repeated unsubscribe calls onto one native teardown", async () => {
    const native = { unsubscribe: vi.fn().mockResolvedValue(undefined) };
    subscribeMock.mockResolvedValueOnce(native);
    const subscription = await subscribeParcelWatcher("/repo", vi.fn());

    const first = subscription.unsubscribe();
    const second = subscription.unsubscribe();

    expect(first).toBe(second);
    await first;
    expect(native.unsubscribe).toHaveBeenCalledTimes(1);
  });

  it("uses recursive fs.watch on Windows and closes it idempotently", async () => {
    setPlatform("win32");
    const root = resolve("watcher-test-repo");
    const close = vi.fn();
    const on = vi.fn();
    const watcher = { close, on };
    on.mockReturnValue(watcher);
    fsWatchMock.mockReturnValue(watcher);
    existsSyncMock.mockReturnValue(true);
    const callback = vi.fn();

    const subscription = await subscribeParcelWatcher(root, callback, {
      ignore: ["**/node_modules/**"],
    });

    expect(subscribeMock).not.toHaveBeenCalled();
    expect(fsWatchMock).toHaveBeenCalledWith(
      root,
      { recursive: true, encoding: "utf8" },
      expect.any(Function)
    );

    const listener = fsWatchMock.mock.calls[0]?.[2] as (
      eventType: "rename" | "change",
      filename: string | null
    ) => void;
    listener("change", "src/index.ts");
    listener("change", "node_modules/pkg/index.js");
    listener("rename", "src/new.ts");

    expect(callback).toHaveBeenNthCalledWith(1, null, [
      { path: resolve(root, "src/index.ts"), type: "update" },
    ]);
    expect(callback).toHaveBeenNthCalledWith(2, null, [
      { path: resolve(root, "src/new.ts"), type: "create" },
    ]);

    const first = subscription.unsubscribe();
    const second = subscription.unsubscribe();
    expect(first).toBe(second);
    await first;
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("routes Windows fs.watch runtime errors through the subscription callback", async () => {
    setPlatform("win32");
    const root = resolve("watcher-error-test-repo");
    const on = vi.fn();
    const watcher = { close: vi.fn(), on };
    on.mockReturnValue(watcher);
    fsWatchMock.mockReturnValue(watcher);
    const callback = vi.fn();

    const subscription = await subscribeParcelWatcher(root, callback);
    const errorHandler = on.mock.calls.find(([event]) => event === "error")?.[1] as (
      error: Error
    ) => void;
    const error = new Error("watch failed");
    errorHandler(error);

    expect(callback).toHaveBeenCalledWith(error, []);
    await subscription.unsubscribe();
  });
});

describe("resolveParcelWatcherExclusions", () => {
  // node:fs is mocked for the subscription tests above; node:fs/promises is
  // real, so these run against an actual directory tree.
  let root: string;

  beforeEach(async () => {
    setPlatform("darwin");
    root = await mkdtemp(join(tmpdir(), "daintree-exclusions-"));
  });

  afterEach(async () => {
    setPlatform(originalPlatform);
    await rm(root, { recursive: true, force: true });
  });

  it("keeps only candidates that are real directories, in priority order", async () => {
    const outside = await mkdtemp(join(tmpdir(), "daintree-exclusions-target-"));
    try {
      await mkdir(join(root, "dist"));
      await mkdir(join(root, "node_modules"));
      // A linked worktree's `.git` is a pointer file, not the repository.
      await writeFile(join(root, ".git"), "gitdir: /elsewhere/.git/worktrees/wt\n");
      // A symlinked directory's contents are not under the watched tree.
      await symlink(outside, join(root, "build"), "dir");
      await writeFile(join(root, "out"), "not a directory\n");

      await expect(
        resolveParcelWatcherExclusions(root, [
          "node_modules",
          ".git",
          "dist",
          "build",
          "out",
          "coverage",
        ])
      ).resolves.toEqual(["node_modules", "dist"]);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it("caps at the FSEvents limit after skipping candidates that are absent", async () => {
    const candidates = ["absent", ".git", "a", "b", "c", "d", "e", "f", "g", "h"];
    for (const name of candidates.slice(1)) await mkdir(join(root, name));

    const exclusions = await resolveParcelWatcherExclusions(root, candidates);

    // Over the limit FSEvents applies none of them, so the cap is exact.
    expect(exclusions).toHaveLength(MAX_PARCEL_EXCLUSION_PATHS);
    expect(exclusions).toEqual([".git", "a", "b", "c", "d", "e", "f", "g"]);
  });

  it("skips a directory whose name differs only in case", async () => {
    // On case-insensitive APFS a lookup of `build` would find `Build/`, which
    // the case-sensitive globs leave visible; excluding it would silence it.
    await mkdir(join(root, "Build"));
    await mkdir(join(root, "dist"));

    await expect(resolveParcelWatcherExclusions(root, ["build", "dist"])).resolves.toEqual([
      "dist",
    ]);
  });

  it("excludes nothing off macOS, where literals add no OS-level exclusion", async () => {
    await mkdir(join(root, "node_modules"));

    for (const platform of ["linux", "win32"] as const) {
      setPlatform(platform);
      await expect(resolveParcelWatcherExclusions(root, ["node_modules"])).resolves.toEqual([]);
    }
  });

  it("returns nothing for a root that does not exist", async () => {
    await expect(
      resolveParcelWatcherExclusions(join(root, "missing"), ["node_modules", ".git"])
    ).resolves.toEqual([]);
  });
});
