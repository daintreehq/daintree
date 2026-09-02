import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolve } from "node:path";

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

import { parcelWatcherBackendOption, subscribeParcelWatcher } from "../parcelWatcherBackend.js";

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
