import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync, watch, type FSWatcher } from "fs";
import { join as pathJoin } from "path";
import parcelWatcher from "@parcel/watcher";
import { getGitDir } from "../gitUtils.js";
import { GitFileWatcher } from "../gitFileWatcher.js";

const { subscribeMock } = vi.hoisted(() => ({ subscribeMock: vi.fn() }));

vi.mock("@parcel/watcher", () => ({
  default: { subscribe: subscribeMock },
}));

vi.mock("fs", () => ({
  watch: vi.fn(),
  readFileSync: vi.fn(),
}));

vi.mock("../gitUtils.js", () => ({
  getGitDir: vi.fn(),
}));

vi.mock("../logger.js", () => ({
  logWarn: vi.fn(),
}));

function createMockWatcher() {
  return {
    on: vi.fn(),
    close: vi.fn(),
  } as unknown as FSWatcher;
}

function createMockSubscription(): { unsubscribe: () => Promise<void> } {
  return { unsubscribe: vi.fn().mockResolvedValue(undefined) };
}

/**
 * Configures the subscribe mock to capture the callback and options
 * for test-driven event injection. Returns helpers to resolve/reject the
 * subscribe promise and access the captured callback.
 */
function setupSubscribeMock() {
  let capturedCallback: ((err: Error | null, events: Array<{ type: string }>) => void) | undefined;
  let capturedOptions: Record<string, unknown> | undefined;
  let resolvePromise: ((sub: { unsubscribe: () => Promise<void> }) => void) | undefined;
  let rejectPromise: ((err: Error) => void) | undefined;

  subscribeMock.mockImplementation(((
    _dir: string,
    cb: (err: Error | null, events: Array<{ type: string }>) => void,
    opts?: Record<string, unknown>
  ) => {
    capturedCallback = cb;
    capturedOptions = opts;
    return new Promise<{ unsubscribe: () => Promise<void> }>((resolve, reject) => {
      resolvePromise = resolve;
      rejectPromise = reject;
    });
  }) as unknown as typeof parcelWatcher.subscribe);

  return {
    getCallback: () => capturedCallback,
    getOptions: () => capturedOptions,
    resolve: (sub?: { unsubscribe: () => Promise<void> }) => {
      if (resolvePromise) {
        resolvePromise(sub ?? createMockSubscription());
      }
    },
    reject: (err: Error) => {
      if (rejectPromise) {
        rejectPromise(err);
      }
    },
    resolveSub: (sub?: { unsubscribe: () => Promise<void> }) => {
      const s = sub ?? createMockSubscription();
      if (resolvePromise) resolvePromise(s);
      return s;
    },
  };
}

/** Fire synthetic events through the captured parcel file watcher callback. */
function fireEvents(
  cb: ((err: Error | null, events: Array<{ type: string }>) => void) | undefined,
  events: Array<{ type: string }>
) {
  cb?.(null, events);
}

/** Fire a synthetic error through the captured parcel file watcher callback. */
function fireError(
  cb: ((err: Error | null, events: Array<{ type: string }>) => void) | undefined,
  err: Error
) {
  cb?.(err, []);
}

describe("GitFileWatcher", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();

    vi.mocked(getGitDir).mockReturnValue(pathJoin("/repo", ".git"));
    vi.mocked(readFileSync).mockImplementation(() => {
      throw new Error("commondir missing");
    });
    vi.mocked(watch).mockImplementation(() => createMockWatcher());
    // Default subscribe: resolve immediately so non-worktree tests don't hang
    subscribeMock.mockResolvedValue(createMockSubscription());
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // ---- Per-file .git/ arm tests (unchanged semantics) ----

  it("watches correct directories and de-duplicates shared paths", () => {
    const gitDir = pathJoin("/repo", ".git");
    const gitWatcher = new GitFileWatcher({
      worktreePath: "/repo",
      branch: "main",
      debounceMs: 300,
      onChange: vi.fn(),
    });

    expect(gitWatcher.start()).toBe(true);

    const watchedPaths = vi.mocked(watch).mock.calls.map(([path]) => path);
    expect(watchedPaths).toContain(gitDir);
    expect(watchedPaths).toContain(pathJoin(gitDir, "refs", "heads"));
    expect(watchedPaths).toContain(pathJoin(gitDir, "logs"));
    expect(watchedPaths.filter((path) => path === gitDir)).toHaveLength(1);

    // HEAD and the branch ref are watched through the gitDir / refs/heads
    // directory watchers, never as standalone fs.watch handles per file.
    expect(watchedPaths).not.toContain(pathJoin(gitDir, "HEAD"));
    expect(watchedPaths).not.toContain(pathJoin(gitDir, "refs", "heads", "main"));
  });

  it("triggers on index changes so external `git add` surfaces without waiting for a poll", async () => {
    const gitDir = pathJoin("/repo", ".git");
    const onChange = vi.fn();
    const gitWatcher = new GitFileWatcher({
      worktreePath: "/repo",
      branch: "main",
      debounceMs: 200,
      onChange,
    });

    expect(gitWatcher.start()).toBe(true);

    const dotGitCall = vi.mocked(watch).mock.calls.find(([path]) => path === gitDir) as
      | [unknown, unknown, unknown]
      | undefined;
    expect(dotGitCall).toBeDefined();
    const dotGitCallback = dotGitCall?.[2] as
      | ((eventType: string, filename: string | Buffer | null) => void)
      | undefined;
    expect(dotGitCallback).toBeDefined();

    // index.lock → index is the atomic-rename pattern git uses for index
    // writes. Both events debounce into a single onChange call.
    dotGitCallback?.("rename", "index.lock");
    dotGitCallback?.("rename", "index");
    await vi.advanceTimersByTimeAsync(250);
    expect(onChange).toHaveBeenCalledTimes(1);

    dotGitCallback?.("rename", "HEAD");
    await vi.advanceTimersByTimeAsync(200);
    expect(onChange).toHaveBeenCalledTimes(2);
  });

  it("filters unrelated directory events and debounces matching events", async () => {
    const gitDir = pathJoin("/repo", ".git");
    const onChange = vi.fn();
    const gitWatcher = new GitFileWatcher({
      worktreePath: "/repo",
      branch: "main",
      debounceMs: 200,
      onChange,
    });

    expect(gitWatcher.start()).toBe(true);

    const dotGitCall = vi.mocked(watch).mock.calls.find(([path]) => path === gitDir) as
      | [unknown, unknown, unknown]
      | undefined;
    expect(dotGitCall).toBeDefined();
    const dotGitCallback = dotGitCall?.[2] as
      | ((eventType: string, filename: string | Buffer | null) => void)
      | undefined;
    expect(dotGitCallback).toBeDefined();

    dotGitCallback?.("rename", "description");
    await vi.advanceTimersByTimeAsync(250);
    expect(onChange).not.toHaveBeenCalled();

    dotGitCallback?.("rename", "HEAD");
    await vi.advanceTimersByTimeAsync(199);
    expect(onChange).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(onChange).toHaveBeenCalledTimes(1);

    dotGitCallback?.("rename", "HEAD");
    dotGitCallback?.("rename", "packed-refs");
    await vi.advanceTimersByTimeAsync(200);
    expect(onChange).toHaveBeenCalledTimes(2);
  });

  it("triggers onChange when .git/config changes (catches `git push -u`)", async () => {
    const gitDir = pathJoin("/repo", ".git");
    const onChange = vi.fn();
    const gitWatcher = new GitFileWatcher({
      worktreePath: "/repo",
      branch: "main",
      debounceMs: 150,
      onChange,
    });

    expect(gitWatcher.start()).toBe(true);

    const dotGitCall = vi.mocked(watch).mock.calls.find(([path]) => path === gitDir) as
      | [unknown, unknown, unknown]
      | undefined;
    expect(dotGitCall).toBeDefined();
    const dotGitCallback = dotGitCall?.[2] as
      | ((eventType: string, filename: string | Buffer | null) => void)
      | undefined;

    dotGitCallback?.("rename", "config");
    await vi.advanceTimersByTimeAsync(150);
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it("detects commits via reflog changes", async () => {
    const gitDir = pathJoin("/repo", ".git");
    const onChange = vi.fn();
    const gitWatcher = new GitFileWatcher({
      worktreePath: "/repo",
      branch: "main",
      debounceMs: 150,
      onChange,
    });

    expect(gitWatcher.start()).toBe(true);

    const logsCall = vi
      .mocked(watch)
      .mock.calls.find(([path]) => path === pathJoin(gitDir, "logs")) as
      | [unknown, unknown, unknown]
      | undefined;
    expect(logsCall).toBeDefined();
    const logsCallback = logsCall?.[2] as
      | ((eventType: string, filename: string | Buffer | null) => void)
      | undefined;
    expect(logsCallback).toBeDefined();

    logsCallback?.("rename", "HEAD");
    await vi.advanceTimersByTimeAsync(150);
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  // ---- Worktree debounce tests ----

  it("worktree events debounce normally for short bursts", async () => {
    const onChange = vi.fn();
    const mock = setupSubscribeMock();

    const gitWatcher = new GitFileWatcher({
      worktreePath: "/repo",
      branch: "main",
      debounceMs: 300,
      onChange,
      watchWorktree: true,
      worktreeMinDebounceMs: 500,
      worktreeMaxDebounceMs: 500,
      worktreeMaxWaitMs: 2000,
    });

    expect(gitWatcher.start()).toBe(true);

    mock.resolve();
    const cb = mock.getCallback();
    expect(cb).toBeDefined();

    fireEvents(cb, [{ type: "update" }, { type: "update" }, { type: "update" }]);

    await vi.advanceTimersByTimeAsync(500);
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it("sustained burst fires onChange at max-wait ceiling", async () => {
    const onChange = vi.fn();
    const mock = setupSubscribeMock();

    const gitWatcher = new GitFileWatcher({
      worktreePath: "/repo",
      branch: "main",
      debounceMs: 300,
      onChange,
      watchWorktree: true,
      worktreeMinDebounceMs: 500,
      worktreeMaxDebounceMs: 500,
      worktreeMaxWaitMs: 2000,
    });

    expect(gitWatcher.start()).toBe(true);
    mock.resolve();
    const cb = mock.getCallback();
    expect(cb).toBeDefined();

    fireEvents(cb, [{ type: "update" }]);

    for (let i = 0; i < 9; i++) {
      await vi.advanceTimersByTimeAsync(200);
      fireEvents(cb, [{ type: "update" }]);
    }
    expect(onChange).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(200);
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it("max-wait timer is cleared when trailing debounce fires", async () => {
    const onChange = vi.fn();
    const mock = setupSubscribeMock();

    const gitWatcher = new GitFileWatcher({
      worktreePath: "/repo",
      branch: "main",
      debounceMs: 300,
      onChange,
      watchWorktree: true,
      worktreeMinDebounceMs: 500,
      worktreeMaxDebounceMs: 500,
      worktreeMaxWaitMs: 2000,
    });

    expect(gitWatcher.start()).toBe(true);
    mock.resolve();
    const cb = mock.getCallback();

    fireEvents(cb, [{ type: "update" }, { type: "update" }]);
    await vi.advanceTimersByTimeAsync(500);
    expect(onChange).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(2000);
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it("git-internal events still use fast debounce without max-wait", async () => {
    const gitDir = pathJoin("/repo", ".git");
    const onChange = vi.fn();
    const gitWatcher = new GitFileWatcher({
      worktreePath: "/repo",
      branch: "main",
      debounceMs: 300,
      onChange,
      watchWorktree: true,
      worktreeMinDebounceMs: 500,
      worktreeMaxDebounceMs: 500,
      worktreeMaxWaitMs: 2000,
    });

    expect(gitWatcher.start()).toBe(true);

    const dotGitCall = vi.mocked(watch).mock.calls.find(([path]) => path === gitDir) as
      | [unknown, unknown, unknown]
      | undefined;
    const dotGitCallback = dotGitCall?.[2] as
      | ((eventType: string, filename: string | Buffer | null) => void)
      | undefined;
    expect(dotGitCallback).toBeDefined();

    dotGitCallback?.("rename", "HEAD");
    await vi.advanceTimersByTimeAsync(300);
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it("single worktree event flushes at minimum debounce", async () => {
    const onChange = vi.fn();
    const mock = setupSubscribeMock();

    const gitWatcher = new GitFileWatcher({
      worktreePath: "/repo",
      branch: "main",
      debounceMs: 300,
      onChange,
      watchWorktree: true,
      worktreeMinDebounceMs: 150,
      worktreeMaxDebounceMs: 800,
      worktreeMaxWaitMs: 1500,
    });

    expect(gitWatcher.start()).toBe(true);
    mock.resolve();
    const cb = mock.getCallback();

    fireEvents(cb, [{ type: "update" }]);

    await vi.advanceTimersByTimeAsync(149);
    expect(onChange).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it("burst ramps debounce delay proportional to event count", async () => {
    const onChange = vi.fn();
    const mock = setupSubscribeMock();

    const gitWatcher = new GitFileWatcher({
      worktreePath: "/repo",
      branch: "main",
      debounceMs: 300,
      onChange,
      watchWorktree: true,
      worktreeMinDebounceMs: 150,
      worktreeMaxDebounceMs: 800,
      worktreeMaxWaitMs: 1500,
    });

    expect(gitWatcher.start()).toBe(true);
    mock.resolve();
    const cb = mock.getCallback();

    // Emit 5 events — delay = 150 + (5-1)*10 = 190ms
    fireEvents(cb, [
      { type: "update" },
      { type: "update" },
      { type: "update" },
      { type: "update" },
      { type: "update" },
    ]);

    await vi.advanceTimersByTimeAsync(189);
    expect(onChange).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it("ramp saturates at worktreeMaxDebounceMs ceiling", async () => {
    const onChange = vi.fn();
    const mock = setupSubscribeMock();

    const gitWatcher = new GitFileWatcher({
      worktreePath: "/repo",
      branch: "main",
      debounceMs: 300,
      onChange,
      watchWorktree: true,
      worktreeMinDebounceMs: 150,
      worktreeMaxDebounceMs: 800,
    });

    expect(gitWatcher.start()).toBe(true);
    mock.resolve();
    const cb = mock.getCallback();

    const events = Array.from({ length: 200 }, () => ({ type: "update" }));
    fireEvents(cb, events);

    await vi.advanceTimersByTimeAsync(799);
    expect(onChange).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it("burst count resets after flush so next session starts at min debounce", async () => {
    const onChange = vi.fn();
    const mock = setupSubscribeMock();

    const gitWatcher = new GitFileWatcher({
      worktreePath: "/repo",
      branch: "main",
      debounceMs: 300,
      onChange,
      watchWorktree: true,
      worktreeMinDebounceMs: 150,
      worktreeMaxDebounceMs: 800,
      worktreeMaxWaitMs: 1500,
    });

    expect(gitWatcher.start()).toBe(true);
    mock.resolve();
    const cb = mock.getCallback();

    fireEvents(
      cb,
      Array.from({ length: 10 }, () => ({ type: "update" }))
    );
    await vi.advanceTimersByTimeAsync(240);
    expect(onChange).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(5000);
    expect(onChange).toHaveBeenCalledTimes(1);

    fireEvents(cb, [{ type: "update" }]);
    await vi.advanceTimersByTimeAsync(149);
    expect(onChange).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(onChange).toHaveBeenCalledTimes(2);
  });

  it("leaves no pending timers after trailing debounce flush", async () => {
    const onChange = vi.fn();
    const mock = setupSubscribeMock();

    const gitWatcher = new GitFileWatcher({
      worktreePath: "/repo",
      branch: "main",
      debounceMs: 300,
      onChange,
      watchWorktree: true,
      worktreeMinDebounceMs: 150,
      worktreeMaxDebounceMs: 800,
      worktreeMaxWaitMs: 1500,
    });

    expect(gitWatcher.start()).toBe(true);
    mock.resolve();
    const cb = mock.getCallback();

    fireEvents(cb, [{ type: "update" }, { type: "update" }]);
    await vi.advanceTimersByTimeAsync(200);
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("leaves no pending timers after max-wait flush", async () => {
    const onChange = vi.fn();
    const mock = setupSubscribeMock();

    const gitWatcher = new GitFileWatcher({
      worktreePath: "/repo",
      branch: "main",
      debounceMs: 300,
      onChange,
      watchWorktree: true,
      worktreeMinDebounceMs: 500,
      worktreeMaxDebounceMs: 500,
      worktreeMaxWaitMs: 1500,
    });

    expect(gitWatcher.start()).toBe(true);
    mock.resolve();
    const cb = mock.getCallback();

    fireEvents(cb, [{ type: "update" }]);
    for (let i = 0; i < 9; i++) {
      await vi.advanceTimersByTimeAsync(150);
      fireEvents(cb, [{ type: "update" }]);
    }
    await vi.advanceTimersByTimeAsync(200);
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("dispose during active burst prevents callback and clears timers", async () => {
    const onChange = vi.fn();
    const mock = setupSubscribeMock();

    const gitWatcher = new GitFileWatcher({
      worktreePath: "/repo",
      branch: "main",
      debounceMs: 300,
      onChange,
      watchWorktree: true,
      worktreeMinDebounceMs: 150,
      worktreeMaxDebounceMs: 800,
      worktreeMaxWaitMs: 1500,
    });

    expect(gitWatcher.start()).toBe(true);
    mock.resolve();
    const cb = mock.getCallback();

    fireEvents(cb, [{ type: "update" }, { type: "update" }]);
    gitWatcher.dispose();

    await vi.advanceTimersByTimeAsync(2000);
    expect(onChange).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  // ---- Error handling tests (adapted to async Promise rejection) ----

  describe("startup error handling", () => {
    it("onWatcherFailed is called when subscribe rejects on Linux ENOSPC", async () => {
      const onChange = vi.fn();
      const onWatcherFailed = vi.fn();
      const mock = setupSubscribeMock();

      const origPlatform = process.platform;
      Object.defineProperty(process, "platform", { value: "linux", configurable: true });

      try {
        const gitWatcher = new GitFileWatcher({
          worktreePath: "/repo",
          branch: "main",
          debounceMs: 300,
          onChange,
          watchWorktree: true,
          onWatcherFailed,
        });

        gitWatcher.start();

        const enospcError = new Error("ENOSPC") as NodeJS.ErrnoException;
        enospcError.code = "ENOSPC";
        mock.reject(enospcError);

        await Promise.resolve();
        await vi.runAllTicks();

        expect(onWatcherFailed).toHaveBeenCalledTimes(1);
      } finally {
        Object.defineProperty(process, "platform", { value: origPlatform, configurable: true });
      }
    });

    it("onInotifyLimitReached fires alongside onWatcherFailed on Linux ENOSPC rejection", async () => {
      const onChange = vi.fn();
      const onWatcherFailed = vi.fn();
      const onInotifyLimitReached = vi.fn();
      const mock = setupSubscribeMock();

      const origPlatform = process.platform;
      Object.defineProperty(process, "platform", { value: "linux", configurable: true });

      try {
        const gitWatcher = new GitFileWatcher({
          worktreePath: "/repo",
          branch: "main",
          debounceMs: 300,
          onChange,
          watchWorktree: true,
          onWatcherFailed,
          onInotifyLimitReached,
        });

        gitWatcher.start();

        const enospcError = new Error("ENOSPC") as NodeJS.ErrnoException;
        enospcError.code = "ENOSPC";
        mock.reject(enospcError);

        await Promise.resolve();
        await vi.runAllTicks();

        expect(onInotifyLimitReached).toHaveBeenCalledTimes(1);
        expect(onWatcherFailed).toHaveBeenCalledTimes(1);
      } finally {
        Object.defineProperty(process, "platform", { value: origPlatform, configurable: true });
      }
    });

    it("does not call onInotifyLimitReached for unknown rejection on Linux", async () => {
      const onChange = vi.fn();
      const onWatcherFailed = vi.fn();
      const onInotifyLimitReached = vi.fn();
      const mock = setupSubscribeMock();

      const origPlatform = process.platform;
      Object.defineProperty(process, "platform", { value: "linux", configurable: true });

      try {
        const gitWatcher = new GitFileWatcher({
          worktreePath: "/repo",
          branch: "main",
          debounceMs: 300,
          onChange,
          watchWorktree: true,
          onWatcherFailed,
          onInotifyLimitReached,
        });

        gitWatcher.start();

        const otherError = new Error("permission denied") as NodeJS.ErrnoException;
        otherError.code = "EACCES";
        mock.reject(otherError);

        await Promise.resolve();
        await vi.runAllTicks();

        expect(onInotifyLimitReached).not.toHaveBeenCalled();
        expect(onWatcherFailed).toHaveBeenCalledTimes(1);
      } finally {
        Object.defineProperty(process, "platform", { value: origPlatform, configurable: true });
      }
    });

    it("startup ENOSPC on Linux no longer returns false — callbacks fire async", async () => {
      const onChange = vi.fn();
      const onWatcherFailed = vi.fn();
      const onInotifyLimitReached = vi.fn();
      const mock = setupSubscribeMock();

      const origPlatform = process.platform;
      Object.defineProperty(process, "platform", { value: "linux", configurable: true });

      try {
        const gitWatcher = new GitFileWatcher({
          worktreePath: "/repo",
          branch: "main",
          debounceMs: 300,
          onChange,
          watchWorktree: true,
          onWatcherFailed,
          onInotifyLimitReached,
        });

        expect(gitWatcher.start()).toBe(true);

        const enospcError = new Error("ENOSPC") as NodeJS.ErrnoException;
        enospcError.code = "ENOSPC";
        mock.reject(enospcError);

        expect(onInotifyLimitReached).not.toHaveBeenCalled();
        expect(onWatcherFailed).not.toHaveBeenCalled();

        await Promise.resolve();
        await vi.runAllTicks();

        expect(onInotifyLimitReached).toHaveBeenCalledTimes(1);
        expect(onWatcherFailed).toHaveBeenCalledTimes(1);
      } finally {
        Object.defineProperty(process, "platform", { value: origPlatform, configurable: true });
      }
    });

    it("onEmfileLimitReached fires alongside onWatcherFailed on macOS EMFILE rejection", async () => {
      const onChange = vi.fn();
      const onWatcherFailed = vi.fn();
      const onEmfileLimitReached = vi.fn();
      const mock = setupSubscribeMock();

      const origPlatform = process.platform;
      Object.defineProperty(process, "platform", { value: "darwin", configurable: true });

      try {
        const gitWatcher = new GitFileWatcher({
          worktreePath: "/repo",
          branch: "main",
          debounceMs: 300,
          onChange,
          watchWorktree: true,
          onWatcherFailed,
          onEmfileLimitReached,
        });

        gitWatcher.start();

        const emfileError = new Error("EMFILE") as NodeJS.ErrnoException;
        emfileError.code = "EMFILE";
        mock.reject(emfileError);

        await Promise.resolve();
        await vi.runAllTicks();

        expect(onEmfileLimitReached).toHaveBeenCalledTimes(1);
        expect(onWatcherFailed).toHaveBeenCalledTimes(1);
      } finally {
        Object.defineProperty(process, "platform", { value: origPlatform, configurable: true });
      }
    });

    it("onEmfileLimitReached fires on macOS from message matching when .code is missing", async () => {
      const onChange = vi.fn();
      const onWatcherFailed = vi.fn();
      const onEmfileLimitReached = vi.fn();
      const mock = setupSubscribeMock();

      const origPlatform = process.platform;
      Object.defineProperty(process, "platform", { value: "darwin", configurable: true });

      try {
        const gitWatcher = new GitFileWatcher({
          worktreePath: "/repo",
          branch: "main",
          debounceMs: 300,
          onChange,
          watchWorktree: true,
          onWatcherFailed,
          onEmfileLimitReached,
        });

        gitWatcher.start();

        const fseventError = new Error("file descriptor limit reached") as NodeJS.ErrnoException;
        mock.reject(fseventError);

        await Promise.resolve();
        await vi.runAllTicks();

        expect(onEmfileLimitReached).toHaveBeenCalledTimes(1);
        expect(onWatcherFailed).toHaveBeenCalledTimes(1);
      } finally {
        Object.defineProperty(process, "platform", { value: origPlatform, configurable: true });
      }
    });

    it("does not call onEmfileLimitReached for unknown rejection on macOS", async () => {
      const onChange = vi.fn();
      const onWatcherFailed = vi.fn();
      const onEmfileLimitReached = vi.fn();
      const mock = setupSubscribeMock();

      const origPlatform = process.platform;
      Object.defineProperty(process, "platform", { value: "darwin", configurable: true });

      try {
        const gitWatcher = new GitFileWatcher({
          worktreePath: "/repo",
          branch: "main",
          debounceMs: 300,
          onChange,
          watchWorktree: true,
          onWatcherFailed,
          onEmfileLimitReached,
        });

        gitWatcher.start();

        const otherError = new Error("permission denied") as NodeJS.ErrnoException;
        otherError.code = "EACCES";
        mock.reject(otherError);

        await Promise.resolve();
        await vi.runAllTicks();

        expect(onEmfileLimitReached).not.toHaveBeenCalled();
        expect(onWatcherFailed).toHaveBeenCalledTimes(1);
      } finally {
        Object.defineProperty(process, "platform", { value: origPlatform, configurable: true });
      }
    });

    it("startup EMFILE on macOS no longer returns false — callbacks fire async", async () => {
      const onChange = vi.fn();
      const onWatcherFailed = vi.fn();
      const onEmfileLimitReached = vi.fn();
      const mock = setupSubscribeMock();

      const origPlatform = process.platform;
      Object.defineProperty(process, "platform", { value: "darwin", configurable: true });

      try {
        const gitWatcher = new GitFileWatcher({
          worktreePath: "/repo",
          branch: "main",
          debounceMs: 300,
          onChange,
          watchWorktree: true,
          onWatcherFailed,
          onEmfileLimitReached,
        });

        expect(gitWatcher.start()).toBe(true);

        const emfileError = new Error("EMFILE") as NodeJS.ErrnoException;
        emfileError.code = "EMFILE";
        mock.reject(emfileError);

        expect(onEmfileLimitReached).not.toHaveBeenCalled();
        expect(onWatcherFailed).not.toHaveBeenCalled();

        await Promise.resolve();
        await vi.runAllTicks();

        expect(onEmfileLimitReached).toHaveBeenCalledTimes(1);
        expect(onWatcherFailed).toHaveBeenCalledTimes(1);
      } finally {
        Object.defineProperty(process, "platform", { value: origPlatform, configurable: true });
      }
    });
  });

  describe("runtime error handling", () => {
    it("runtime error on Linux ENOSPC fires callbacks", async () => {
      const onChange = vi.fn();
      const onWatcherFailed = vi.fn();
      const onInotifyLimitReached = vi.fn();
      const mock = setupSubscribeMock();

      const origPlatform = process.platform;
      Object.defineProperty(process, "platform", { value: "linux", configurable: true });

      try {
        const gitWatcher = new GitFileWatcher({
          worktreePath: "/repo",
          branch: "main",
          debounceMs: 300,
          onChange,
          watchWorktree: true,
          onWatcherFailed,
          onInotifyLimitReached,
        });

        expect(gitWatcher.start()).toBe(true);
        mock.resolve();
        const cb = mock.getCallback();

        const enospcError = new Error("ENOSPC") as NodeJS.ErrnoException;
        enospcError.code = "ENOSPC";
        fireError(cb, enospcError);

        expect(onInotifyLimitReached).toHaveBeenCalledTimes(1);
        expect(onWatcherFailed).toHaveBeenCalledTimes(1);
      } finally {
        Object.defineProperty(process, "platform", { value: origPlatform, configurable: true });
      }
    });

    it("runtime error on macOS EMFILE fires callbacks", async () => {
      const onChange = vi.fn();
      const onWatcherFailed = vi.fn();
      const onEmfileLimitReached = vi.fn();
      const mock = setupSubscribeMock();

      const origPlatform = process.platform;
      Object.defineProperty(process, "platform", { value: "darwin", configurable: true });

      try {
        const gitWatcher = new GitFileWatcher({
          worktreePath: "/repo",
          branch: "main",
          debounceMs: 300,
          onChange,
          watchWorktree: true,
          onWatcherFailed,
          onEmfileLimitReached,
        });

        expect(gitWatcher.start()).toBe(true);
        mock.resolve();
        const cb = mock.getCallback();

        const emfileError = new Error("EMFILE") as NodeJS.ErrnoException;
        emfileError.code = "EMFILE";
        fireError(cb, emfileError);

        expect(onEmfileLimitReached).toHaveBeenCalledTimes(1);
        expect(onWatcherFailed).toHaveBeenCalledTimes(1);
      } finally {
        Object.defineProperty(process, "platform", { value: origPlatform, configurable: true });
      }
    });

    it("does not signal emfile-limit on non-Darwin platforms for EMFILE runtime error", () => {
      const onChange = vi.fn();
      const onWatcherFailed = vi.fn();
      const onEmfileLimitReached = vi.fn();
      const mock = setupSubscribeMock();

      const origPlatform = process.platform;
      Object.defineProperty(process, "platform", { value: "linux", configurable: true });

      try {
        const gitWatcher = new GitFileWatcher({
          worktreePath: "/repo",
          branch: "main",
          debounceMs: 300,
          onChange,
          watchWorktree: true,
          onWatcherFailed,
          onEmfileLimitReached,
        });

        expect(gitWatcher.start()).toBe(true);
        mock.resolve();
        const cb = mock.getCallback();

        const emfileError = new Error("EMFILE") as NodeJS.ErrnoException;
        emfileError.code = "EMFILE";
        fireError(cb, emfileError);

        expect(onEmfileLimitReached).not.toHaveBeenCalled();
      } finally {
        Object.defineProperty(process, "platform", { value: origPlatform, configurable: true });
      }
    });

    it("does not signal inotify-limit on non-Linux platforms for ENOSPC runtime error", () => {
      const onChange = vi.fn();
      const onWatcherFailed = vi.fn();
      const onInotifyLimitReached = vi.fn();
      const mock = setupSubscribeMock();

      const origPlatform = process.platform;
      Object.defineProperty(process, "platform", { value: "darwin", configurable: true });

      try {
        const gitWatcher = new GitFileWatcher({
          worktreePath: "/repo",
          branch: "main",
          debounceMs: 300,
          onChange,
          watchWorktree: true,
          onWatcherFailed,
          onInotifyLimitReached,
        });

        expect(gitWatcher.start()).toBe(true);
        mock.resolve();
        const cb = mock.getCallback();

        const enospcError = new Error("ENOSPC") as NodeJS.ErrnoException;
        enospcError.code = "ENOSPC";
        fireError(cb, enospcError);

        expect(onInotifyLimitReached).not.toHaveBeenCalled();
      } finally {
        Object.defineProperty(process, "platform", { value: origPlatform, configurable: true });
      }
    });

    it("unknown runtime errors do not fire platform-specific callbacks", () => {
      const onChange = vi.fn();
      const onWatcherFailed = vi.fn();
      const onInotifyLimitReached = vi.fn();
      const onEmfileLimitReached = vi.fn();
      const mock = setupSubscribeMock();

      const gitWatcher = new GitFileWatcher({
        worktreePath: "/repo",
        branch: "main",
        debounceMs: 300,
        onChange,
        watchWorktree: true,
        onWatcherFailed,
        onInotifyLimitReached,
        onEmfileLimitReached,
      });

      expect(gitWatcher.start()).toBe(true);
      mock.resolve();
      const cb = mock.getCallback();

      const otherError = new Error("permission denied") as NodeJS.ErrnoException;
      otherError.code = "EACCES";
      fireError(cb, otherError);

      expect(onInotifyLimitReached).not.toHaveBeenCalled();
      expect(onEmfileLimitReached).not.toHaveBeenCalled();
      expect(onWatcherFailed).not.toHaveBeenCalled();
    });
  });

  // ---- Sentinels & branch ref tests (unchanged, use per-file .git/ arm) ----

  it("fires onChange when an operation sentinel appears or disappears", async () => {
    const gitDir = pathJoin("/repo", ".git");
    const onChange = vi.fn();
    const gitWatcher = new GitFileWatcher({
      worktreePath: "/repo",
      branch: "main",
      debounceMs: 100,
      onChange,
    });

    expect(gitWatcher.start()).toBe(true);

    const dotGitCalls = vi
      .mocked(watch)
      .mock.calls.filter(([path]) => path === gitDir) as unknown as Array<
      [unknown, unknown, unknown]
    >;
    expect(dotGitCalls).toHaveLength(1);
    const dotGitCallback = dotGitCalls[0][2] as
      | ((eventType: string, filename: string | Buffer | null) => void)
      | undefined;
    expect(dotGitCallback).toBeDefined();

    for (const sentinel of [
      "MERGE_HEAD",
      "rebase-merge",
      "rebase-apply",
      "CHERRY_PICK_HEAD",
      "REVERT_HEAD",
    ]) {
      onChange.mockClear();
      dotGitCallback?.("rename", sentinel);
      await vi.advanceTimersByTimeAsync(100);
      expect(onChange).toHaveBeenCalledTimes(1);
    }
  });

  it("detects commits via branch ref changes", async () => {
    const gitDir = pathJoin("/repo", ".git");
    const onChange = vi.fn();
    const gitWatcher = new GitFileWatcher({
      worktreePath: "/repo",
      branch: "main",
      debounceMs: 150,
      onChange,
    });

    expect(gitWatcher.start()).toBe(true);

    const refsCall = vi
      .mocked(watch)
      .mock.calls.find(([path]) => path === pathJoin(gitDir, "refs", "heads")) as
      | [unknown, unknown, unknown]
      | undefined;
    expect(refsCall).toBeDefined();
    const refsCallback = refsCall?.[2] as
      | ((eventType: string, filename: string | Buffer | null) => void)
      | undefined;
    expect(refsCallback).toBeDefined();

    refsCallback?.("rename", "main");
    await vi.advanceTimersByTimeAsync(150);
    expect(onChange).toHaveBeenCalledTimes(1);

    refsCallback?.("rename", "main.lock");
    await vi.advanceTimersByTimeAsync(150);
    expect(onChange).toHaveBeenCalledTimes(2);
  });

  // ---- Ignore filter tests ----

  describe("worktree ignore filter", () => {
    it("passes WORKTREE_IGNORE_GLOBS to subscribe as native ignore option", () => {
      const mock = setupSubscribeMock();

      const gitWatcher = new GitFileWatcher({
        worktreePath: "/repo",
        branch: "main",
        debounceMs: 300,
        onChange: vi.fn(),
        watchWorktree: true,
        worktreeMinDebounceMs: 100,
        worktreeMaxDebounceMs: 100,
      });

      gitWatcher.start();

      const options = mock.getOptions();
      expect(options).toBeDefined();
      expect(options?.ignore).toBeDefined();

      const ignore = options?.ignore as string[];
      const expectedDirs = [
        "node_modules",
        "dist",
        "build",
        ".next",
        "target",
        "coverage",
        ".cache",
        ".turbo",
        "out",
        "__pycache__",
        ".venv",
      ];
      for (const dir of expectedDirs) {
        expect(ignore).toContain(`**/${dir}/**`);
      }
      expect(ignore).toContain("**/.git");
      expect(ignore).toContain("**/.git/**");
      expect(ignore).toHaveLength(13);
    });

    it("events from non-ignored paths still fire onChange", async () => {
      const onChange = vi.fn();
      const mock = setupSubscribeMock();

      const gitWatcher = new GitFileWatcher({
        worktreePath: "/repo",
        branch: "main",
        debounceMs: 300,
        onChange,
        watchWorktree: true,
        worktreeMinDebounceMs: 100,
        worktreeMaxDebounceMs: 100,
      });

      expect(gitWatcher.start()).toBe(true);
      mock.resolve();
      const cb = mock.getCallback();

      fireEvents(cb, [{ type: "update" }]);
      await vi.advanceTimersByTimeAsync(100);
      expect(onChange).toHaveBeenCalledTimes(1);
    });

    it("multiple events in a batch each increment burstCount", async () => {
      const onChange = vi.fn();
      const mock = setupSubscribeMock();

      const gitWatcher = new GitFileWatcher({
        worktreePath: "/repo",
        branch: "main",
        debounceMs: 300,
        onChange,
        watchWorktree: true,
        worktreeMinDebounceMs: 150,
        worktreeMaxDebounceMs: 800,
      });

      expect(gitWatcher.start()).toBe(true);
      mock.resolve();
      const cb = mock.getCallback();

      fireEvents(
        cb,
        Array.from({ length: 10 }, () => ({ type: "update" }))
      );

      await vi.advanceTimersByTimeAsync(239);
      expect(onChange).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(onChange).toHaveBeenCalledTimes(1);
    });

    it("empty events array does not trigger onChange", async () => {
      const onChange = vi.fn();
      const mock = setupSubscribeMock();

      const gitWatcher = new GitFileWatcher({
        worktreePath: "/repo",
        branch: "main",
        debounceMs: 300,
        onChange,
        watchWorktree: true,
        worktreeMinDebounceMs: 100,
        worktreeMaxDebounceMs: 100,
      });

      expect(gitWatcher.start()).toBe(true);
      mock.resolve();
      const cb = mock.getCallback();

      fireEvents(cb, []);
      await vi.advanceTimersByTimeAsync(150);
      expect(onChange).not.toHaveBeenCalled();
    });
  });

  // ---- Disposal & lifecycle tests ----

  it("dispose after subscribe resolves calls unsubscribe", async () => {
    const onChange = vi.fn();
    const mock = setupSubscribeMock();

    const gitWatcher = new GitFileWatcher({
      worktreePath: "/repo",
      branch: "main",
      debounceMs: 300,
      onChange,
      watchWorktree: true,
    });

    gitWatcher.start();

    const sub = mock.resolveSub();
    // Flush microtasks so the .then() callback stores worktreeSubscription
    await vi.runAllTicks();
    gitWatcher.dispose();

    expect(sub.unsubscribe).toHaveBeenCalledTimes(1);
  });

  it("dispose before subscribe resolves: unsubscribes when promise settles", async () => {
    const onChange = vi.fn();
    const mock = setupSubscribeMock();

    const gitWatcher = new GitFileWatcher({
      worktreePath: "/repo",
      branch: "main",
      debounceMs: 300,
      onChange,
      watchWorktree: true,
    });

    gitWatcher.start();
    gitWatcher.dispose();

    const sub = createMockSubscription();
    mock.resolve(sub);

    await Promise.resolve();
    await vi.runAllTicks();

    expect(sub.unsubscribe).toHaveBeenCalledTimes(1);
  });

  it("events after dispose are ignored", async () => {
    const onChange = vi.fn();
    const mock = setupSubscribeMock();

    const gitWatcher = new GitFileWatcher({
      worktreePath: "/repo",
      branch: "main",
      debounceMs: 300,
      onChange,
      watchWorktree: true,
      worktreeMinDebounceMs: 100,
      worktreeMaxDebounceMs: 100,
    });

    expect(gitWatcher.start()).toBe(true);
    mock.resolve();
    const cb = mock.getCallback();

    gitWatcher.dispose();

    fireEvents(cb, [{ type: "update" }]);
    await vi.advanceTimersByTimeAsync(200);
    expect(onChange).not.toHaveBeenCalled();
  });

  it("dispose before subscribe rejection prevents callbacks", async () => {
    const onWatcherFailed = vi.fn();
    const onInotifyLimitReached = vi.fn();
    const mock = setupSubscribeMock();

    const origPlatform = process.platform;
    Object.defineProperty(process, "platform", { value: "linux", configurable: true });

    try {
      const gitWatcher = new GitFileWatcher({
        worktreePath: "/repo",
        branch: "main",
        debounceMs: 300,
        onChange: vi.fn(),
        watchWorktree: true,
        onWatcherFailed,
        onInotifyLimitReached,
      });

      gitWatcher.start();
      gitWatcher.dispose();

      const enospcError = new Error("ENOSPC") as NodeJS.ErrnoException;
      enospcError.code = "ENOSPC";
      mock.reject(enospcError);

      await Promise.resolve();
      await vi.runAllTicks();

      expect(onWatcherFailed).not.toHaveBeenCalled();
      expect(onInotifyLimitReached).not.toHaveBeenCalled();
    } finally {
      Object.defineProperty(process, "platform", {
        value: origPlatform,
        configurable: true,
      });
    }
  });

  it("runtime error after dispose is ignored", async () => {
    const onWatcherFailed = vi.fn();
    const onInotifyLimitReached = vi.fn();
    const mock = setupSubscribeMock();

    const origPlatform = process.platform;
    Object.defineProperty(process, "platform", { value: "linux", configurable: true });

    try {
      const gitWatcher = new GitFileWatcher({
        worktreePath: "/repo",
        branch: "main",
        debounceMs: 300,
        onChange: vi.fn(),
        watchWorktree: true,
        onWatcherFailed,
        onInotifyLimitReached,
      });

      expect(gitWatcher.start()).toBe(true);
      mock.resolve();
      const cb = mock.getCallback();

      gitWatcher.dispose();

      const enospcError = new Error("ENOSPC") as NodeJS.ErrnoException;
      enospcError.code = "ENOSPC";
      fireError(cb, enospcError);

      expect(onWatcherFailed).not.toHaveBeenCalled();
      expect(onInotifyLimitReached).not.toHaveBeenCalled();
    } finally {
      Object.defineProperty(process, "platform", {
        value: origPlatform,
        configurable: true,
      });
    }
  });

  it("macOS non-EMFILE message does not fire onEmfileLimitReached", async () => {
    const onWatcherFailed = vi.fn();
    const onEmfileLimitReached = vi.fn();
    const mock = setupSubscribeMock();

    const origPlatform = process.platform;
    Object.defineProperty(process, "platform", { value: "darwin", configurable: true });

    try {
      const gitWatcher = new GitFileWatcher({
        worktreePath: "/repo",
        branch: "main",
        debounceMs: 300,
        onChange: vi.fn(),
        watchWorktree: true,
        onWatcherFailed,
        onEmfileLimitReached,
      });

      gitWatcher.start();

      const enoentError = new Error("file not found") as NodeJS.ErrnoException;
      enoentError.code = "ENOENT";
      mock.reject(enoentError);

      await Promise.resolve();
      await vi.runAllTicks();

      expect(onEmfileLimitReached).not.toHaveBeenCalled();
      expect(onWatcherFailed).toHaveBeenCalledTimes(1);
    } finally {
      Object.defineProperty(process, "platform", {
        value: origPlatform,
        configurable: true,
      });
    }
  });

  it("unsubscribe rejection does not produce unhandled promise rejection", async () => {
    const mock = setupSubscribeMock();

    const gitWatcher = new GitFileWatcher({
      worktreePath: "/repo",
      branch: "main",
      debounceMs: 300,
      onChange: vi.fn(),
      watchWorktree: true,
    });

    gitWatcher.start();

    const sub = {
      unsubscribe: vi.fn().mockRejectedValue(new Error("native teardown failed")),
    };
    mock.resolve(sub);

    await vi.runAllTicks();

    // dispose() calls unsubscribe().catch(() => {}) — should not throw
    expect(() => gitWatcher.dispose()).not.toThrow();
  });
});
