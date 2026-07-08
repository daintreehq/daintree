import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BrowserWindow } from "electron";
import {
  installOpenDirConsumer,
  drainPendingOpenDirs,
  _resetOpenDirConsumerForTest,
} from "../openDirHandler.js";

// Spy on the environment.ts queue primitives openDirHandler drives. Mocking the
// module keeps this test free of environment.ts's heavy main-process init while
// exercising the REAL openDirHandler logic (not a re-stated simulation).
const envMock = vi.hoisted(() => ({
  getPendingOpenDirPaths: vi.fn<() => string[]>(() => []),
  clearPendingOpenDirPaths: vi.fn(),
  setOpenDirConsumer: vi.fn(),
  queuePendingOpenDirPath: vi.fn(),
}));

vi.mock("../../setup/environment.js", () => envMock);

function makeWindow(destroyed = false): BrowserWindow {
  return { isDestroyed: () => destroyed } as unknown as BrowserWindow;
}

// Untyped return so the vi.fn() mocks keep their MockInstance type (mockReturnValue/
// mockRejectedValue/toHaveBeenCalledBefore are visible to tsc). The deps object is
// still structurally checked at the installOpenDirConsumer/drainPendingOpenDirs
// call sites, which take OpenDirHandlerDeps.
function makeDeps() {
  return {
    openDirectory: vi
      .fn<(dir: string, win: BrowserWindow) => Promise<void>>()
      .mockResolvedValue(undefined),
    resolvePrimaryWindow: vi.fn<() => BrowserWindow | null>(() => null),
  };
}

// Opens run on a serialized async chain, so consumer/drain effects settle on a
// microtask — wait for them rather than asserting synchronously.
function captureConsumer(): (d: string) => void {
  let captured: ((d: string) => void) | null = null;
  envMock.setOpenDirConsumer.mockImplementation((c: (d: string) => void) => {
    captured = c;
  });
  return (d: string) => captured!(d);
}

describe("installOpenDirConsumer (#10976)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _resetOpenDirConsumerForTest();
  });

  it("registers a consumer exactly once (idempotent)", () => {
    const deps = makeDeps();
    installOpenDirConsumer(deps);
    installOpenDirConsumer(deps);
    expect(envMock.setOpenDirConsumer).toHaveBeenCalledTimes(1);
  });

  it("warm drop with a live primary window opens it in that window", async () => {
    const primary = makeWindow();
    const deps = makeDeps();
    deps.resolvePrimaryWindow.mockReturnValue(primary);
    const drop = captureConsumer();

    installOpenDirConsumer(deps);
    drop("/projects/foo");
    await vi.waitFor(() =>
      expect(deps.openDirectory).toHaveBeenCalledWith("/projects/foo", primary)
    );

    expect(envMock.queuePendingOpenDirPath).not.toHaveBeenCalled();
  });

  it("warm drop with no primary window re-queues for the next drain", async () => {
    const deps = makeDeps();
    deps.resolvePrimaryWindow.mockReturnValue(null);
    const drop = captureConsumer();

    installOpenDirConsumer(deps);
    drop("/projects/foo");
    await vi.waitFor(() =>
      expect(envMock.queuePendingOpenDirPath).toHaveBeenCalledWith("/projects/foo")
    );

    expect(deps.openDirectory).not.toHaveBeenCalled();
  });

  it("warm drop with a destroyed primary window re-queues", async () => {
    const destroyed = makeWindow(true);
    const deps = makeDeps();
    deps.resolvePrimaryWindow.mockReturnValue(destroyed);
    const drop = captureConsumer();

    installOpenDirConsumer(deps);
    drop("/projects/foo");
    await vi.waitFor(() =>
      expect(envMock.queuePendingOpenDirPath).toHaveBeenCalledWith("/projects/foo")
    );

    expect(deps.openDirectory).not.toHaveBeenCalled();
  });

  it("a failed open is caught and logged, not thrown", async () => {
    const primary = makeWindow();
    const deps = makeDeps();
    deps.openDirectory.mockRejectedValue(new Error("boom"));
    deps.resolvePrimaryWindow.mockReturnValue(primary);
    const drop = captureConsumer();
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    installOpenDirConsumer(deps);
    drop("/projects/foo");
    await vi.waitFor(() => expect(errSpy).toHaveBeenCalled());

    errSpy.mockRestore();
  });
});

describe("drainPendingOpenDirs (#10976)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    envMock.getPendingOpenDirPaths.mockReturnValue([]);
    _resetOpenDirConsumerForTest();
  });

  it("is a no-op when nothing is queued", () => {
    const deps = makeDeps();
    drainPendingOpenDirs(makeWindow(), deps);
    expect(envMock.clearPendingOpenDirPaths).not.toHaveBeenCalled();
    expect(deps.openDirectory).not.toHaveBeenCalled();
  });

  it("clears the queue before opening, then opens each folder in FIFO order", async () => {
    envMock.getPendingOpenDirPaths.mockReturnValue(["/a", "/b", "/c"]);
    const win = makeWindow();
    const deps = makeDeps();

    drainPendingOpenDirs(win, deps);
    await vi.waitFor(() => expect(deps.openDirectory).toHaveBeenCalledTimes(3));

    // clear runs synchronously before the async opens begin.
    expect(envMock.clearPendingOpenDirPaths).toHaveBeenCalledBefore(deps.openDirectory);
    expect(deps.openDirectory).toHaveBeenNthCalledWith(1, "/a", win);
    expect(deps.openDirectory).toHaveBeenNthCalledWith(2, "/b", win);
    expect(deps.openDirectory).toHaveBeenNthCalledWith(3, "/c", win);
  });

  it("opens sequentially — the second waits for the first to settle", async () => {
    envMock.getPendingOpenDirPaths.mockReturnValue(["/a", "/b"]);
    const win = makeWindow();
    let resolveFirst: (() => void) | null = null;
    const deps = makeDeps();
    deps.openDirectory
      .mockImplementationOnce(() => new Promise<void>((resolve) => (resolveFirst = resolve)))
      .mockResolvedValue(undefined);

    drainPendingOpenDirs(win, deps);
    // First open pending; the second must not have started yet. waitFor is safe
    // here because task 2 is blocked behind task 1's unresolved open.
    await vi.waitFor(() => expect(deps.openDirectory).toHaveBeenCalledTimes(1));

    resolveFirst!();
    await vi.waitFor(() => expect(deps.openDirectory).toHaveBeenCalledTimes(2));
  });

  it("re-queues remaining folders if the window is destroyed before each open", async () => {
    envMock.getPendingOpenDirPaths.mockReturnValue(["/a", "/b"]);
    const destroyed = makeWindow(true);
    const deps = makeDeps();

    drainPendingOpenDirs(destroyed, deps);
    await vi.waitFor(() => expect(envMock.queuePendingOpenDirPath).toHaveBeenCalledTimes(2));

    expect(deps.openDirectory).not.toHaveBeenCalled();
    expect(envMock.queuePendingOpenDirPath).toHaveBeenCalledWith("/a");
    expect(envMock.queuePendingOpenDirPath).toHaveBeenCalledWith("/b");
  });

  it("continues draining when one open rejects", async () => {
    envMock.getPendingOpenDirPaths.mockReturnValue(["/a", "/b"]);
    const win = makeWindow();
    const deps = makeDeps();
    deps.openDirectory.mockRejectedValueOnce(new Error("nope")).mockResolvedValue(undefined);
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    drainPendingOpenDirs(win, deps);
    await vi.waitFor(() => expect(deps.openDirectory).toHaveBeenCalledTimes(2));

    expect(deps.openDirectory).toHaveBeenCalledWith("/a", win);
    expect(deps.openDirectory).toHaveBeenCalledWith("/b", win);
    errSpy.mockRestore();
  });

  it("warm drop mid-drain is serialized after the queued folders (no race)", async () => {
    // Two queued cold-launch folders [/a, /b]; while /a is pending, a warm drop
    // /c arrives via the consumer. All three must open in order a, b, c on the
    // shared chain — the consumer does not jump ahead of the drain.
    envMock.getPendingOpenDirPaths.mockReturnValue(["/a", "/b"]);
    const win = makeWindow();
    const primary = makeWindow();
    let resolveA: (() => void) | null = null;
    const deps = makeDeps();
    deps.openDirectory
      .mockImplementationOnce(() => new Promise<void>((resolve) => (resolveA = resolve)))
      .mockResolvedValue(undefined);
    deps.resolvePrimaryWindow.mockReturnValue(primary);
    const drop = captureConsumer();
    installOpenDirConsumer(deps);

    drainPendingOpenDirs(win, deps);
    await vi.waitFor(() => expect(deps.openDirectory).toHaveBeenCalledTimes(1));
    // /a is pending; warm-drop /c now — it must NOT open before /b.
    drop("/c");
    await Promise.resolve();
    expect(deps.openDirectory).toHaveBeenCalledTimes(1);

    resolveA!();
    await vi.waitFor(() => expect(deps.openDirectory).toHaveBeenCalledTimes(3));
    expect(deps.openDirectory).toHaveBeenNthCalledWith(1, "/a", win);
    expect(deps.openDirectory).toHaveBeenNthCalledWith(2, "/b", win);
    expect(deps.openDirectory).toHaveBeenNthCalledWith(3, "/c", primary);
  });
});
