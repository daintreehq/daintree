import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { watch, type FSWatcher } from "fs";
import { lstat, readFile, realpath } from "fs/promises";
import { join as pathJoin, resolve as pathResolve } from "path";
import { getGitDir } from "../gitUtils.js";
import { logWarn } from "../logger.js";
import { checkIgnoredPaths, hasTrackedIgnoredPaths } from "../gitCheckIgnore.js";
import { GitFileWatcher } from "../gitFileWatcher.js";
import { settleParcelWatcherLifecycle } from "../parcelWatcherBackend.js";

const { subscribeMock, exclusionsMock } = vi.hoisted(() => ({
  subscribeMock: vi.fn(),
  exclusionsMock: vi.fn(),
}));

/**
 * The slice of `@parcel/watcher`'s Event the watcher reads. `path` is optional
 * here on purpose: most tests only exercise debounce timing and pass `{ type }`
 * alone, which the watcher must treat as an unclassifiable burst and refresh
 * for — the conservative default the ignore classification is built on.
 */
type WatcherEvent = { type: string; path?: string };

vi.mock("../parcelWatcherBackend.js", () => ({
  subscribeParcelWatcher: subscribeMock,
  resolveParcelWatcherExclusions: exclusionsMock,
  settleParcelWatcherLifecycle: () => Promise.resolve(),
}));

vi.mock("fs", () => ({
  watch: vi.fn(),
}));

vi.mock("fs/promises", () => ({
  lstat: vi.fn(),
  readFile: vi.fn(),
  realpath: vi.fn(),
}));

/**
 * An `lstat` result for a path of the given kind. Born long before any burst by
 * default — the shape of a file being edited in place.
 */
function statOf(kind: "file" | "dir" | "symlink", birthtimeMs = 1) {
  return {
    isFile: () => kind === "file",
    isDirectory: () => kind === "dir",
    isSymbolicLink: () => kind === "symlink",
    birthtimeMs,
  };
}

vi.mock("../gitUtils.js", () => ({
  getGitDir: vi.fn(),
}));

vi.mock("../logger.js", () => ({
  logWarn: vi.fn(),
}));

vi.mock("../gitCheckIgnore.js", () => ({
  checkIgnoredPaths: vi.fn(),
  hasTrackedIgnoredPaths: vi.fn(),
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
  let capturedCallback: ((err: Error | null, events: Array<WatcherEvent>) => void) | undefined;
  let capturedDir: string | undefined;
  let capturedOptions: Record<string, unknown> | undefined;
  let resolvePromise: ((sub: { unsubscribe: () => Promise<void> }) => void) | undefined;
  let rejectPromise: ((err: Error) => void) | undefined;

  subscribeMock.mockImplementation(
    (
      dir: string,
      cb: (err: Error | null, events: Array<WatcherEvent>) => void,
      opts?: Record<string, unknown>
    ) => {
      capturedCallback = cb;
      capturedDir = dir;
      capturedOptions = opts;
      return new Promise<{ unsubscribe: () => Promise<void> }>((resolve, reject) => {
        resolvePromise = resolve;
        rejectPromise = reject;
      });
    }
  );

  return {
    getCallback: () => capturedCallback,
    getDir: () => capturedDir,
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
  cb: ((err: Error | null, events: Array<WatcherEvent>) => void) | undefined,
  events: Array<WatcherEvent>
) {
  cb?.(null, events);
}

/** Fire a synthetic error through the captured parcel file watcher callback. */
function fireError(
  cb: ((err: Error | null, events: Array<WatcherEvent>) => void) | undefined,
  err: Error
) {
  cb?.(err, []);
}

/** Drain the serialized native lifecycle and its consumer promise callbacks. */
async function flushParcelWatcherCallbacks(): Promise<void> {
  await settleParcelWatcherLifecycle();
  await Promise.resolve();
  await Promise.resolve();
}

/**
 * Drain the promise chain a classified flush starts.
 *
 * Advancing fake timers runs the debounce callback, but the flush then hands
 * off to `checkIgnoredPaths` and decides in a `.then`. Timer advancement does
 * not settle that chain, so a test asserting on `onChange` after a burst with
 * real paths has to drain the microtask queue explicitly. Kept separate from
 * `flushParcelWatcherCallbacks`, which is about subscription lifecycle.
 */
async function flushClassification(): Promise<void> {
  for (let i = 0; i < 5; i++) {
    await Promise.resolve();
  }
}

describe("GitFileWatcher", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();

    vi.mocked(getGitDir).mockResolvedValue(pathJoin("/repo", ".git"));
    vi.mocked(readFile).mockRejectedValue(new Error("commondir missing"));
    // No symlink alias by default: the configured root IS the canonical one.
    vi.mocked(realpath).mockImplementation(((p: string) => Promise.resolve(p)) as never);
    // Every path an update names is still a regular file: a plain content save.
    vi.mocked(lstat).mockResolvedValue(statOf("file") as never);
    // Default classification: nothing is ignored, so every classified burst
    // refreshes. `clearAllMocks` resets calls but not implementations, so the
    // implementation is (re)installed here rather than once at module scope.
    vi.mocked(checkIgnoredPaths).mockResolvedValue(new Set());
    // No tracked file matches an ignore rule — the state of essentially every
    // repo, and the precondition that makes check-ignore's answer trustworthy.
    vi.mocked(hasTrackedIgnoredPaths).mockResolvedValue(false);
    vi.mocked(watch).mockImplementation(() => createMockWatcher());
    // Default subscribe: resolve immediately so non-worktree tests don't hang
    subscribeMock.mockResolvedValue(createMockSubscription());
    // No hot directory exists by default, so the ignore list is the globs alone.
    exclusionsMock.mockResolvedValue([]);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // ---- Per-file .git/ arm tests (unchanged semantics) ----

  it("watches correct directories and de-duplicates shared paths", async () => {
    const gitDir = pathJoin("/repo", ".git");
    const gitWatcher = new GitFileWatcher({
      worktreePath: "/repo",
      branch: "main",
      debounceMs: 300,
      onChange: vi.fn(),
    });

    await expect(gitWatcher.start()).resolves.toBe(true);

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

    await expect(gitWatcher.start()).resolves.toBe(true);

    const dotGitCall = vi.mocked(watch).mock.calls.find(([path]) => path === gitDir) as
      [unknown, unknown, unknown] | undefined;
    expect(dotGitCall).toBeDefined();
    const dotGitCallback = dotGitCall?.[2] as
      ((eventType: string, filename: string | Buffer | null) => void) | undefined;
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

    await expect(gitWatcher.start()).resolves.toBe(true);

    const dotGitCall = vi.mocked(watch).mock.calls.find(([path]) => path === gitDir) as
      [unknown, unknown, unknown] | undefined;
    expect(dotGitCall).toBeDefined();
    const dotGitCallback = dotGitCall?.[2] as
      ((eventType: string, filename: string | Buffer | null) => void) | undefined;
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

  // ---- onGitConfigChanged: the `git remote add` signal (#11155) ----

  describe("onGitConfigChanged", () => {
    const gitDir = pathJoin("/repo", ".git");

    /** Arms a watcher and returns the gitDir directory-event callback. */
    async function armAndGetGitDirCallback(options: {
      onChange: () => void;
      onGitConfigChanged?: () => void;
      debounceMs?: number;
    }): Promise<(eventType: string, filename: string | Buffer | null) => void> {
      const gitWatcher = new GitFileWatcher({
        worktreePath: "/repo",
        branch: "main",
        debounceMs: options.debounceMs ?? 100,
        onChange: options.onChange,
        onGitConfigChanged: options.onGitConfigChanged,
      });
      await expect(gitWatcher.start()).resolves.toBe(true);

      const dotGitCall = vi.mocked(watch).mock.calls.find(([path]) => path === gitDir) as
        [unknown, unknown, unknown] | undefined;
      expect(dotGitCall).toBeDefined();
      return dotGitCall?.[2] as (eventType: string, filename: string | Buffer | null) => void;
    }

    it("fires on a config write — the file `git remote add` edits", async () => {
      const onChange = vi.fn();
      const onGitConfigChanged = vi.fn();
      const cb = await armAndGetGitDirCallback({ onChange, onGitConfigChanged });

      cb("rename", "config");
      await vi.advanceTimersByTimeAsync(100);

      expect(onGitConfigChanged).toHaveBeenCalledTimes(1);
      // The status pass still runs: a config write can also change tracking info.
      expect(onChange).toHaveBeenCalledTimes(1);
    });

    it("stays silent for non-config git files — a remote re-read costs a subprocess", async () => {
      const onChange = vi.fn();
      const onGitConfigChanged = vi.fn();
      const cb = await armAndGetGitDirCallback({ onChange, onGitConfigChanged });

      cb("rename", "HEAD");
      cb("rename", "index");
      cb("rename", "packed-refs");
      await vi.advanceTimersByTimeAsync(100);

      expect(onChange).toHaveBeenCalledTimes(1);
      expect(onGitConfigChanged).not.toHaveBeenCalled();
    });

    it("fires for the config.lock half of git's lock-then-rename write", async () => {
      const onChange = vi.fn();
      const onGitConfigChanged = vi.fn();
      const cb = await armAndGetGitDirCallback({ onChange, onGitConfigChanged });

      // git writes config.lock, then renames it over config. Both land in the
      // same debounce burst and must collapse into ONE probe.
      cb("rename", "config.lock");
      cb("rename", "config");
      await vi.advanceTimersByTimeAsync(100);

      expect(onGitConfigChanged).toHaveBeenCalledTimes(1);
    });

    it("does not leak the config flag into the next burst", async () => {
      const onChange = vi.fn();
      const onGitConfigChanged = vi.fn();
      const cb = await armAndGetGitDirCallback({ onChange, onGitConfigChanged });

      cb("rename", "config");
      await vi.advanceTimersByTimeAsync(100);
      expect(onGitConfigChanged).toHaveBeenCalledTimes(1);

      // A later HEAD-only burst must not re-fire the (already consumed) flag.
      cb("rename", "HEAD");
      await vi.advanceTimersByTimeAsync(100);
      expect(onChange).toHaveBeenCalledTimes(2);
      expect(onGitConfigChanged).toHaveBeenCalledTimes(1);
    });

    it("treats an unnamed event as possibly-config rather than missing the write", async () => {
      const onChange = vi.fn();
      const onGitConfigChanged = vi.fn();
      const cb = await armAndGetGitDirCallback({ onChange, onGitConfigChanged });

      // A null filename means the platform couldn't say what changed. A false
      // positive costs one git spawn that emits nothing; a false negative would
      // strand the toolbar pills until a reload.
      cb("rename", null);
      await vi.advanceTimersByTimeAsync(100);

      expect(onGitConfigChanged).toHaveBeenCalledTimes(1);
    });

    it("is optional — a watcher without the callback still drives onChange", async () => {
      const onChange = vi.fn();
      const cb = await armAndGetGitDirCallback({ onChange });

      expect(() => cb("rename", "config")).not.toThrow();
      await vi.advanceTimersByTimeAsync(100);
      expect(onChange).toHaveBeenCalledTimes(1);
    });
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

    await expect(gitWatcher.start()).resolves.toBe(true);

    const logsCall = vi
      .mocked(watch)
      .mock.calls.find(([path]) => path === pathJoin(gitDir, "logs")) as
      [unknown, unknown, unknown] | undefined;
    expect(logsCall).toBeDefined();
    const logsCallback = logsCall?.[2] as
      ((eventType: string, filename: string | Buffer | null) => void) | undefined;
    expect(logsCallback).toBeDefined();

    logsCallback?.("rename", "HEAD");
    await vi.advanceTimersByTimeAsync(150);
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  // ---- Remote-tracking refs arm (#11151) ----

  it("triggers a debounced onChange for any change under refs/remotes/origin", async () => {
    const originDir = pathJoin("/repo", ".git", "refs", "remotes", "origin");
    const onChange = vi.fn();
    const gitWatcher = new GitFileWatcher({
      worktreePath: "/repo",
      branch: "main",
      debounceMs: 150,
      onChange,
    });

    await expect(gitWatcher.start()).resolves.toBe(true);

    const originCall = vi.mocked(watch).mock.calls.find(([path]) => path === originDir) as
      [unknown, unknown, unknown] | undefined;
    expect(originCall).toBeDefined();
    const originCallback = originCall?.[2] as
      ((eventType: string, filename: string | Buffer | null) => void) | undefined;
    expect(originCallback).toBeDefined();

    // A fetch writing origin/main; the arm is filename-agnostic (any event here
    // means upstream may have moved), and a burst coalesces into one refresh.
    originCallback?.("rename", "main");
    originCallback?.("rename", "main.lock");
    originCallback?.("change", null);
    await vi.advanceTimersByTimeAsync(150);
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it("degrades silently when refs/remotes/origin cannot be watched", async () => {
    const originDir = pathJoin("/repo", ".git", "refs", "remotes", "origin");
    vi.mocked(watch).mockImplementation(((path: string) => {
      if (path === originDir) throw new Error("ENOENT: no such directory");
      return createMockWatcher();
    }) as unknown as typeof watch);

    const gitWatcher = new GitFileWatcher({
      worktreePath: "/repo",
      branch: "main",
      debounceMs: 150,
      onChange: vi.fn(),
    });

    // A missing origin dir (no fetch yet / all refs packed) must not fail start.
    await expect(gitWatcher.start()).resolves.toBe(true);
  });

  // ---- Upstream ref: the push signal (#13400) ----

  function callbackFor(dir: string) {
    const call = [...vi.mocked(watch).mock.calls].reverse().find(([path]) => path === dir) as
      [unknown, unknown, unknown] | undefined;
    return call?.[2] as ((eventType: string, filename: string | Buffer | null) => void) | undefined;
  }

  it("fires on a push to a nested upstream ref on any remote", async () => {
    const forkDir = pathJoin("/repo", ".git", "refs", "remotes", "fork", "feature");
    const onChange = vi.fn();
    const gitWatcher = new GitFileWatcher({
      worktreePath: "/repo",
      branch: "feature/x",
      debounceMs: 150,
      upstreamRef: "refs/remotes/fork/feature/x",
      onChange,
    });

    await expect(gitWatcher.start()).resolves.toBe(true);
    const cb = callbackFor(forkDir);
    expect(cb).toBeDefined();

    cb?.("rename", "other");
    await vi.advanceTimersByTimeAsync(150);
    expect(onChange).not.toHaveBeenCalled();

    // git's lock-then-rename ref write.
    cb?.("rename", "x.lock");
    cb?.("rename", "x");
    await vi.advanceTimersByTimeAsync(150);
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it("follows the upstream to a new ref and stops reporting the old one", async () => {
    const remotes = pathJoin("/repo", ".git", "refs", "remotes", "origin");
    const onChange = vi.fn();
    const gitWatcher = new GitFileWatcher({
      worktreePath: "/repo",
      branch: "feature/x",
      debounceMs: 150,
      onChange,
    });
    await gitWatcher.start();

    gitWatcher.setUpstreamRef("refs/remotes/origin/feature/x");
    gitWatcher.setUpstreamRef("refs/remotes/origin/feature/y");
    const cb = callbackFor(pathJoin(remotes, "feature"));
    expect(
      vi.mocked(watch).mock.calls.filter(([p]) => p === pathJoin(remotes, "feature"))
    ).toHaveLength(1);

    cb?.("rename", "x");
    await vi.advanceTimersByTimeAsync(150);
    expect(onChange).not.toHaveBeenCalled();

    cb?.("rename", "y");
    await vi.advanceTimersByTimeAsync(150);
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it("retries an upstream ref whose directory did not exist yet", async () => {
    const featureDir = pathJoin("/repo", ".git", "refs", "remotes", "origin", "feature");
    let exists = false;
    vi.mocked(watch).mockImplementation(((path: string) => {
      if (path === featureDir && !exists) throw new Error("ENOENT: no such directory");
      return createMockWatcher();
    }) as unknown as typeof watch);
    const onChange = vi.fn();
    const gitWatcher = new GitFileWatcher({
      worktreePath: "/repo",
      branch: "feature/x",
      debounceMs: 150,
      upstreamRef: "refs/remotes/origin/feature/x",
      onChange,
    });
    await expect(gitWatcher.start()).resolves.toBe(true);

    exists = true;
    gitWatcher.setUpstreamRef("refs/remotes/origin/feature/x");
    callbackFor(featureDir)?.("rename", "x");
    await vi.advanceTimersByTimeAsync(150);
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it("watches the nearest existing ancestor until the ref's directory appears", async () => {
    const remotes = pathJoin("/repo", ".git", "refs", "remotes");
    const forkDir = pathJoin(remotes, "fork");
    const featureDir = pathJoin(forkDir, "feature");
    vi.mocked(watch).mockImplementation(((path: string) => {
      if (path === featureDir) throw new Error("ENOENT: no such directory");
      return createMockWatcher();
    }) as unknown as typeof watch);
    const onChange = vi.fn();
    const gitWatcher = new GitFileWatcher({
      worktreePath: "/repo",
      branch: "feature/x",
      debounceMs: 150,
      upstreamRef: "refs/remotes/fork/feature/x",
      onChange,
    });
    await gitWatcher.start();

    const cb = callbackFor(forkDir);
    cb?.("rename", "unrelated");
    await vi.advanceTimersByTimeAsync(150);
    expect(onChange).not.toHaveBeenCalled();

    // The push creating fork/feature/ for the first time.
    cb?.("rename", "feature");
    await vi.advanceTimersByTimeAsync(150);
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it("keeps the fallback's watch when it turns out to be the ref itself", async () => {
    const forkDir = pathJoin("/repo", ".git", "refs", "remotes", "fork");
    const handles = new Map<string, FSWatcher>();
    vi.mocked(watch).mockImplementation(((path: string) => {
      if (path === pathJoin(forkDir, "topic")) throw new Error("ENOENT: no such directory");
      const handle = createMockWatcher();
      handles.set(path, handle);
      return handle;
    }) as unknown as typeof watch);
    const onChange = vi.fn();
    const gitWatcher = new GitFileWatcher({
      worktreePath: "/repo",
      branch: "topic",
      debounceMs: 150,
      upstreamRef: "refs/remotes/fork/topic/x",
      onChange,
    });
    await gitWatcher.start();

    // The fallback waits for fork/topic; the upstream becomes exactly that.
    gitWatcher.setUpstreamRef("refs/remotes/fork/topic");

    expect(handles.get(forkDir)?.close).not.toHaveBeenCalled();
    callbackFor(forkDir)?.("rename", "topic");
    await vi.advanceTimersByTimeAsync(150);
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it("closes a directory's watch once the upstream moves out of it", async () => {
    const remotes = pathJoin("/repo", ".git", "refs", "remotes");
    const handles = new Map<string, FSWatcher>();
    vi.mocked(watch).mockImplementation(((path: string) => {
      const handle = createMockWatcher();
      handles.set(path, handle);
      return handle;
    }) as unknown as typeof watch);
    const gitWatcher = new GitFileWatcher({
      worktreePath: "/repo",
      branch: "feature/x",
      debounceMs: 150,
      upstreamRef: "refs/remotes/origin/feature/x",
      onChange: vi.fn(),
    });
    await gitWatcher.start();

    gitWatcher.setUpstreamRef("refs/remotes/fork/topic/x");

    expect(handles.get(pathJoin(remotes, "origin", "feature"))?.close).toHaveBeenCalledTimes(1);
    expect(handles.get(pathJoin(remotes, "fork", "topic"))?.close).not.toHaveBeenCalled();
  });

  it("never turns a malformed upstream ref into a watch path", async () => {
    const gitWatcher = new GitFileWatcher({
      worktreePath: "/repo",
      branch: "feature/x",
      debounceMs: 150,
      upstreamRef: "refs/remotes/../../../etc/x",
      onChange: vi.fn(),
    });
    await gitWatcher.start();

    const watchedPaths = vi.mocked(watch).mock.calls.map(([path]) => String(path));
    expect(watchedPaths.some((p) => !p.startsWith(pathJoin("/repo", ".git")))).toBe(false);
  });

  // ---- Worktree debounce tests ----

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

    await expect(gitWatcher.start()).resolves.toBe(true);
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

    await expect(gitWatcher.start()).resolves.toBe(true);
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

    await expect(gitWatcher.start()).resolves.toBe(true);

    const dotGitCall = vi.mocked(watch).mock.calls.find(([path]) => path === gitDir) as
      [unknown, unknown, unknown] | undefined;
    const dotGitCallback = dotGitCall?.[2] as
      ((eventType: string, filename: string | Buffer | null) => void) | undefined;
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

    await expect(gitWatcher.start()).resolves.toBe(true);
    mock.resolve();
    const cb = mock.getCallback();

    fireEvents(cb, [{ type: "update" }]);

    await vi.advanceTimersByTimeAsync(149);
    expect(onChange).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it("leading-edge flush fires an isolated event at the short delay after quiet", async () => {
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
      worktreeLeadingDebounceMs: 50,
      worktreeQuietWindowMs: 2000,
    });

    await expect(gitWatcher.start()).resolves.toBe(true);
    mock.resolve();
    const cb = mock.getCallback();

    fireEvents(cb, [{ type: "update" }]);

    await vi.advanceTimersByTimeAsync(49);
    expect(onChange).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it("burst continuation cancels the leading flush back onto the trailing ramp", async () => {
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
      worktreeLeadingDebounceMs: 50,
      worktreeQuietWindowMs: 2000,
    });

    await expect(gitWatcher.start()).resolves.toBe(true);
    mock.resolve();
    const cb = mock.getCallback();

    fireEvents(cb, [{ type: "update" }]);
    await vi.advanceTimersByTimeAsync(20);
    // Burst continues before the 50ms leading timer fires — the recomputed
    // trailing delay (150 + (5-1)*10 = 190ms from now) replaces it.
    fireEvents(cb, [
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

  it("leading-edge does not re-fire inside the quiet window", async () => {
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
      worktreeLeadingDebounceMs: 50,
      worktreeQuietWindowMs: 2000,
    });

    await expect(gitWatcher.start()).resolves.toBe(true);
    mock.resolve();
    const cb = mock.getCallback();

    fireEvents(cb, [{ type: "update" }]);
    await vi.advanceTimersByTimeAsync(50);
    expect(onChange).toHaveBeenCalledTimes(1);

    // 500ms after the flush is still inside the 2000ms quiet window — the
    // next event waits out the normal trailing minimum, not the leading delay.
    await vi.advanceTimersByTimeAsync(500);
    fireEvents(cb, [{ type: "update" }]);

    await vi.advanceTimersByTimeAsync(149);
    expect(onChange).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1);
    expect(onChange).toHaveBeenCalledTimes(2);

    // Once the quiet window elapses the leading fast path re-arms.
    await vi.advanceTimersByTimeAsync(2000);
    fireEvents(cb, [{ type: "update" }]);

    await vi.advanceTimersByTimeAsync(50);
    expect(onChange).toHaveBeenCalledTimes(3);
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

    await expect(gitWatcher.start()).resolves.toBe(true);
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

    await expect(gitWatcher.start()).resolves.toBe(true);
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

    await expect(gitWatcher.start()).resolves.toBe(true);
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

    await expect(gitWatcher.start()).resolves.toBe(true);
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

    await expect(gitWatcher.start()).resolves.toBe(true);
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

    await expect(gitWatcher.start()).resolves.toBe(true);
    mock.resolve();
    const cb = mock.getCallback();

    fireEvents(cb, [{ type: "update" }, { type: "update" }]);
    gitWatcher.dispose();

    await vi.advanceTimersByTimeAsync(2000);
    expect(onChange).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  // ---- Working-tree-changed signal (#11330) ----

  describe("onWorktreeFilesChanged", () => {
    it("fires once per debounced worktree flush, alongside onChange", async () => {
      const onChange = vi.fn();
      const onWorktreeFilesChanged = vi.fn();
      const mock = setupSubscribeMock();

      const gitWatcher = new GitFileWatcher({
        worktreePath: "/repo",
        branch: "main",
        debounceMs: 300,
        onChange,
        onWorktreeFilesChanged,
        watchWorktree: true,
        worktreeMinDebounceMs: 500,
        worktreeMaxDebounceMs: 500,
        worktreeMaxWaitMs: 2000,
      });

      await expect(gitWatcher.start()).resolves.toBe(true);
      mock.resolve();
      const cb = mock.getCallback();

      fireEvents(cb, [{ type: "update" }, { type: "update" }, { type: "update" }]);

      await vi.advanceTimersByTimeAsync(500);
      expect(onWorktreeFilesChanged).toHaveBeenCalledTimes(1);
      // Rides the same flush as the git-status recompute — one raw-fs signal
      // per coalesced burst, not one per event.
      expect(onChange).toHaveBeenCalledTimes(1);
    });

    it("fires on a max-wait forced flush during a sustained burst", async () => {
      const onChange = vi.fn();
      const onWorktreeFilesChanged = vi.fn();
      const mock = setupSubscribeMock();

      const gitWatcher = new GitFileWatcher({
        worktreePath: "/repo",
        branch: "main",
        debounceMs: 300,
        onChange,
        onWorktreeFilesChanged,
        watchWorktree: true,
        worktreeMinDebounceMs: 500,
        worktreeMaxDebounceMs: 500,
        worktreeMaxWaitMs: 2000,
      });

      await expect(gitWatcher.start()).resolves.toBe(true);
      mock.resolve();
      const cb = mock.getCallback();

      fireEvents(cb, [{ type: "update" }]);
      for (let i = 0; i < 9; i++) {
        await vi.advanceTimersByTimeAsync(200);
        fireEvents(cb, [{ type: "update" }]);
      }
      expect(onWorktreeFilesChanged).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(200);
      expect(onWorktreeFilesChanged).toHaveBeenCalledTimes(1);
      expect(onChange).toHaveBeenCalledTimes(1);
    });

    it("does not fire for git-internal changes (HEAD/index)", async () => {
      const gitDir = pathJoin("/repo", ".git");
      const onChange = vi.fn();
      const onWorktreeFilesChanged = vi.fn();
      const gitWatcher = new GitFileWatcher({
        worktreePath: "/repo",
        branch: "main",
        debounceMs: 300,
        onChange,
        onWorktreeFilesChanged,
        watchWorktree: true,
        worktreeMinDebounceMs: 500,
        worktreeMaxDebounceMs: 500,
        worktreeMaxWaitMs: 2000,
      });

      await expect(gitWatcher.start()).resolves.toBe(true);

      const dotGitCall = vi.mocked(watch).mock.calls.find(([path]) => path === gitDir) as
        [unknown, unknown, unknown] | undefined;
      const dotGitCallback = dotGitCall?.[2] as
        ((eventType: string, filename: string | Buffer | null) => void) | undefined;
      expect(dotGitCallback).toBeDefined();

      // HEAD/index writes route through the git-internal debounce, which only
      // drives onChange — a repo-metadata change is not a working-tree write.
      dotGitCallback?.("rename", "HEAD");
      dotGitCallback?.("rename", "index");
      await vi.advanceTimersByTimeAsync(300);

      expect(onChange).toHaveBeenCalledTimes(1);
      expect(onWorktreeFilesChanged).not.toHaveBeenCalled();
    });

    it("does not fire a late flush after dispose", async () => {
      const onChange = vi.fn();
      const onWorktreeFilesChanged = vi.fn();
      const mock = setupSubscribeMock();

      const gitWatcher = new GitFileWatcher({
        worktreePath: "/repo",
        branch: "main",
        debounceMs: 300,
        onChange,
        onWorktreeFilesChanged,
        watchWorktree: true,
        worktreeMinDebounceMs: 150,
        worktreeMaxDebounceMs: 800,
        worktreeMaxWaitMs: 1500,
      });

      await expect(gitWatcher.start()).resolves.toBe(true);
      mock.resolve();
      const cb = mock.getCallback();

      fireEvents(cb, [{ type: "update" }, { type: "update" }]);
      gitWatcher.dispose();

      await vi.advanceTimersByTimeAsync(2000);
      expect(onWorktreeFilesChanged).not.toHaveBeenCalled();
      expect(onChange).not.toHaveBeenCalled();
    });

    // ---- The burst's affected directories (#12244) ----

    function watcherWithPaths() {
      const onChange = vi.fn();
      const onWorktreeFilesChanged =
        vi.fn<(dirs: readonly string[] | null, membershipChanged: boolean) => void>();
      const mock = setupSubscribeMock();
      const gitWatcher = new GitFileWatcher({
        worktreePath: pathJoin("/repo"),
        branch: "main",
        debounceMs: 300,
        onChange,
        onWorktreeFilesChanged,
        watchWorktree: true,
        worktreeMinDebounceMs: 500,
        worktreeMaxDebounceMs: 500,
        worktreeMaxWaitMs: 2000,
      });
      return { gitWatcher, onChange, onWorktreeFilesChanged, mock };
    }

    /** The directories one flush reported, order-independent. */
    function reportedDirs(fn: ReturnType<typeof vi.fn>, call = 0): string[] | null {
      const dirs = fn.mock.calls[call]?.[0] as readonly string[] | null | undefined;
      return dirs == null ? null : [...dirs].sort();
    }

    it("reports the parent directory of every path in the burst, deduped", async () => {
      const { gitWatcher, onWorktreeFilesChanged, mock } = watcherWithPaths();
      await expect(gitWatcher.start()).resolves.toBe(true);
      mock.resolve();
      const cb = mock.getCallback();

      fireEvents(cb, [
        { type: "update", path: pathJoin("/repo", "src", "panels", "a.ts") },
        { type: "update", path: pathJoin("/repo", "src", "panels", "b.ts") },
        { type: "create", path: pathJoin("/repo", "package.json") },
      ]);
      await vi.advanceTimersByTimeAsync(500);

      // Two writes in one directory plus one at the top level: two targets, not
      // three — which is the whole point of deduping to parents.
      expect(reportedDirs(onWorktreeFilesChanged)).toEqual(["", "src/panels"]);
      gitWatcher.dispose();
    });

    it("reports unknown for a burst carrying an event it cannot place", async () => {
      const { gitWatcher, onWorktreeFilesChanged, mock } = watcherWithPaths();
      await expect(gitWatcher.start()).resolves.toBe(true);
      mock.resolve();
      const cb = mock.getCallback();

      fireEvents(cb, [
        { type: "update", path: pathJoin("/repo", "src", "a.ts") },
        // No path: an event shape the watcher cannot reason about, which makes
        // the whole burst unscopeable rather than partially known.
        { type: "update" },
      ]);
      await vi.advanceTimersByTimeAsync(500);

      expect(onWorktreeFilesChanged).toHaveBeenCalledTimes(1);
      // Explicitly null, not merely absent: the callback has to SAY "unknown"
      // rather than leave the consumer to infer it from a missing argument.
      expect(onWorktreeFilesChanged.mock.calls[0]).toHaveLength(2);
      expect(onWorktreeFilesChanged.mock.calls[0][0]).toBeNull();
      // An unplaceable burst can never be proved content-only.
      expect(onWorktreeFilesChanged.mock.calls[0][1]).toBe(true);
      gitWatcher.dispose();
    });

    it("gives each flush its own burst rather than accumulating across them", async () => {
      const { gitWatcher, onWorktreeFilesChanged, mock } = watcherWithPaths();
      await expect(gitWatcher.start()).resolves.toBe(true);
      mock.resolve();
      const cb = mock.getCallback();

      fireEvents(cb, [{ type: "update", path: pathJoin("/repo", "src", "a.ts") }]);
      await vi.advanceTimersByTimeAsync(500);
      fireEvents(cb, [{ type: "update", path: pathJoin("/repo", "electron", "b.ts") }]);
      await vi.advanceTimersByTimeAsync(500);

      expect(reportedDirs(onWorktreeFilesChanged, 0)).toEqual(["src"]);
      // The second flush must not still be carrying `src`: a scope that grows
      // forever converges on the full sweep it exists to avoid.
      expect(reportedDirs(onWorktreeFilesChanged, 1)).toEqual(["electron"]);
      gitWatcher.dispose();
    });
  });

  describe("path membership (#13595)", () => {
    const gitDir = pathJoin("/repo", ".git");

    function membershipWatcher() {
      const onChange = vi.fn();
      const onWorktreeFilesChanged =
        vi.fn<(dirs: readonly string[] | null, membershipChanged: boolean) => void>();
      const onPathMembershipChanged = vi.fn();
      const onWorktreeWatcherReady = vi.fn();
      const mock = setupSubscribeMock();
      const gitWatcher = new GitFileWatcher({
        worktreePath: pathJoin("/repo"),
        branch: "main",
        debounceMs: 300,
        onChange,
        onWorktreeFilesChanged,
        onPathMembershipChanged,
        onWorktreeWatcherReady,
        watchWorktree: true,
        worktreeMinDebounceMs: 500,
        worktreeMaxDebounceMs: 500,
        worktreeMaxWaitMs: 2000,
      });
      return {
        gitWatcher,
        onChange,
        onWorktreeFilesChanged,
        onPathMembershipChanged,
        onWorktreeWatcherReady,
        mock,
      };
    }

    /** Start, let the subscription go live, and forget the readiness bump. */
    async function liveWatcher() {
      const harness = membershipWatcher();
      await expect(harness.gitWatcher.start()).resolves.toBe(true);
      harness.mock.resolve();
      await flushParcelWatcherCallbacks();
      harness.onPathMembershipChanged.mockClear();
      return { ...harness, cb: harness.mock.getCallback() };
    }

    function gitDirCallback() {
      const call = vi.mocked(watch).mock.calls.find(([path]) => path === gitDir) as
        [unknown, unknown, unknown] | undefined;
      return call?.[2] as
        ((eventType: string, filename: string | Buffer | null) => void) | undefined;
    }

    const file = (name: string) => pathJoin("/repo", "src", name);

    it("reports repeated in-place saves of an existing file as content-only", async () => {
      const { gitWatcher, cb, onWorktreeFilesChanged, onPathMembershipChanged } =
        await liveWatcher();

      for (let save = 0; save < 3; save++) {
        fireEvents(cb, [{ type: "update", path: file("a.ts") }]);
        await vi.advanceTimersByTimeAsync(500);
        await flushClassification();
      }

      expect(onWorktreeFilesChanged).toHaveBeenCalledTimes(3);
      expect(onWorktreeFilesChanged.mock.calls.map(([, changed]) => changed)).toEqual([
        false,
        false,
        false,
      ]);
      expect(lstat).toHaveBeenCalledWith(file("a.ts"));
      expect(onPathMembershipChanged).not.toHaveBeenCalled();
      gitWatcher.dispose();
    });

    it.each([
      ["a create", [{ type: "create", path: file("new.ts") }]],
      ["a delete", [{ type: "delete", path: file("old.ts") }]],
      [
        "a rename (delete + create)",
        [
          { type: "delete", path: file("before.ts") },
          { type: "create", path: file("after.ts") },
        ],
      ],
      ["an event without a type", [{ path: file("a.ts") } as unknown as WatcherEvent]],
      ["an event without a path", [{ type: "update" }]],
      ["a .gitignore edit", [{ type: "update", path: pathJoin("/repo", ".gitignore") }]],
      ["an update outside the worktree", [{ type: "update", path: "/elsewhere/a.ts" }]],
    ])("reports %s as a membership change", async (_label, events) => {
      const { gitWatcher, cb, onWorktreeFilesChanged } = await liveWatcher();

      fireEvents(cb, [{ type: "update", path: file("a.ts") }, ...(events as WatcherEvent[])]);
      await vi.advanceTimersByTimeAsync(500);

      expect(onWorktreeFilesChanged).toHaveBeenCalledTimes(1);
      expect(onWorktreeFilesChanged.mock.calls[0][1]).toBe(true);
      gitWatcher.dispose();
    });

    it("keeps a membership change sticky across batches of one burst", async () => {
      const { gitWatcher, cb, onWorktreeFilesChanged } = await liveWatcher();

      fireEvents(cb, [{ type: "create", path: file("new.ts") }]);
      await vi.advanceTimersByTimeAsync(100);
      fireEvents(cb, [{ type: "update", path: file("new.ts") }]);
      await vi.advanceTimersByTimeAsync(500);

      expect(onWorktreeFilesChanged).toHaveBeenCalledTimes(1);
      expect(onWorktreeFilesChanged.mock.calls[0][1]).toBe(true);
      gitWatcher.dispose();
    });

    it("does not carry a membership change into the next burst", async () => {
      const { gitWatcher, cb, onWorktreeFilesChanged } = await liveWatcher();

      fireEvents(cb, [{ type: "create", path: file("new.ts") }]);
      await vi.advanceTimersByTimeAsync(500);
      fireEvents(cb, [{ type: "update", path: file("new.ts") }]);
      await vi.advanceTimersByTimeAsync(500);

      expect(onWorktreeFilesChanged.mock.calls.map(([, changed]) => changed)).toEqual([
        true,
        false,
      ]);
      gitWatcher.dispose();
    });

    it("reports an overflow/rescan as a membership change", async () => {
      const { gitWatcher, cb, onWorktreeFilesChanged } = await liveWatcher();

      fireError(cb, new Error("Events were dropped and must be re-scanned"));
      await vi.advanceTimersByTimeAsync(500);

      expect(onWorktreeFilesChanged).toHaveBeenCalledTimes(1);
      expect(onWorktreeFilesChanged.mock.calls[0]).toEqual([null, true]);
      gitWatcher.dispose();
    });

    it("does not stat a burst too wide to be a save", async () => {
      const { gitWatcher, cb, onWorktreeFilesChanged } = await liveWatcher();

      fireEvents(
        cb,
        Array.from({ length: 65 }, (_, i) => ({ type: "update", path: file(`f${i}.ts`) }))
      );
      await vi.advanceTimersByTimeAsync(2000);

      expect(onWorktreeFilesChanged.mock.calls[0][1]).toBe(true);
      expect(lstat).not.toHaveBeenCalled();
      gitWatcher.dispose();
    });

    it.each([
      ["a directory", () => Promise.resolve(statOf("dir"))],
      [
        "a symlink, whose retarget moves listings beneath it",
        () => Promise.resolve(statOf("symlink")),
      ],
      // A directory moved out and a file written in its place: the final type
      // passes, the birth time gives the fold away.
      ["a file born inside the burst", () => Promise.resolve(statOf("file", Date.now()))],
      [
        "a vanished path",
        () => Promise.reject(Object.assign(new Error("gone"), { code: "ENOENT" })),
      ],
    ])(
      "corrects a content-only report when an updated path turns out to be %s",
      async (_label, impl) => {
        // Parcel folds a delete and re-create of one path into `update`, so a
        // file replaced by a directory moved in from outside reads as an edit.
        const { gitWatcher, cb, onWorktreeFilesChanged, onPathMembershipChanged } =
          await liveWatcher();
        vi.mocked(lstat).mockImplementation(((p: string) =>
          p === file("swapped") ? impl() : Promise.resolve(statOf("file"))) as never);

        fireEvents(cb, [
          { type: "update", path: file("a.ts") },
          { type: "update", path: file("swapped") },
        ]);
        await vi.advanceTimersByTimeAsync(500);
        await flushClassification();

        expect(onWorktreeFilesChanged.mock.calls[0][1]).toBe(false);
        expect(onPathMembershipChanged).toHaveBeenCalledTimes(1);
        gitWatcher.dispose();
      }
    );

    it("trusts type alone on a filesystem that reports no birth time", async () => {
      const { gitWatcher, cb, onWorktreeFilesChanged, onPathMembershipChanged } =
        await liveWatcher();
      vi.mocked(lstat).mockResolvedValue(statOf("file", 0) as never);

      fireEvents(cb, [{ type: "update", path: file("a.ts") }]);
      await vi.advanceTimersByTimeAsync(500);
      await flushClassification();

      expect(onWorktreeFilesChanged.mock.calls[0][1]).toBe(false);
      expect(lstat).toHaveBeenCalledWith(file("a.ts"));
      expect(onPathMembershipChanged).not.toHaveBeenCalled();
      gitWatcher.dispose();
    });

    it("gives up on a verification that never answers and reports a change", async () => {
      // A path on a dead mount: the stat never settles, and the burst must not
      // stay content-only forever because of it.
      const { gitWatcher, cb, onPathMembershipChanged } = await liveWatcher();
      vi.mocked(lstat).mockImplementation((() => new Promise(() => {})) as never);

      fireEvents(cb, [{ type: "update", path: file("a.ts") }]);
      await vi.advanceTimersByTimeAsync(500);
      expect(lstat).toHaveBeenCalledTimes(1);
      expect(onPathMembershipChanged).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(2_000);

      expect(onPathMembershipChanged).toHaveBeenCalledTimes(1);
      gitWatcher.dispose();
    });

    it("drops a failed verification that lands after dispose", async () => {
      const { gitWatcher, cb, onPathMembershipChanged } = await liveWatcher();
      let rejectStat: ((error: Error) => void) | undefined;
      vi.mocked(lstat).mockImplementation(
        (() =>
          new Promise((_resolve, reject) => {
            rejectStat = reject;
          })) as never
      );

      fireEvents(cb, [{ type: "update", path: file("a.ts") }]);
      await vi.advanceTimersByTimeAsync(500);
      expect(rejectStat).toBeDefined();
      gitWatcher.dispose();
      rejectStat!(new Error("gone"));
      await flushClassification();

      expect(onPathMembershipChanged).not.toHaveBeenCalled();
    });

    it("reports a membership change when git-only coverage is established", async () => {
      // A rotation disposes the previous watcher with its git-internal debounce
      // still pending; a checkout inside that gap would otherwise go unreported.
      const onPathMembershipChanged = vi.fn();
      const gitWatcher = new GitFileWatcher({
        worktreePath: "/repo",
        branch: "main",
        debounceMs: 300,
        onChange: vi.fn(),
        onPathMembershipChanged,
      });

      await expect(gitWatcher.start()).resolves.toBe(true);

      expect(onPathMembershipChanged).toHaveBeenCalledTimes(1);
      gitWatcher.dispose();
    });

    it("reports a membership change when the recursive subscription goes live", async () => {
      // Whatever happened while nothing watched the tree — before startup, during
      // a pause or a failure, before an agent elevated it — is unaccounted for.
      const { gitWatcher, mock, onPathMembershipChanged, onWorktreeWatcherReady } =
        membershipWatcher();
      await expect(gitWatcher.start()).resolves.toBe(true);
      expect(onPathMembershipChanged).not.toHaveBeenCalled();

      mock.resolve();
      await flushParcelWatcherCallbacks();

      expect(onPathMembershipChanged).toHaveBeenCalledTimes(1);
      expect(onWorktreeWatcherReady).toHaveBeenCalledTimes(1);
      expect(onPathMembershipChanged.mock.invocationCallOrder[0]).toBeLessThan(
        onWorktreeWatcherReady.mock.invocationCallOrder[0]
      );
      gitWatcher.dispose();
    });

    it("reports a membership change for an index-only write", async () => {
      // `git rm --cached` of an ignored file, `git add -f`: the listing moves
      // and the working tree raises nothing.
      const { gitWatcher, onChange, onWorktreeFilesChanged, onPathMembershipChanged } =
        await liveWatcher();

      gitDirCallback()?.("rename", "index");
      await vi.advanceTimersByTimeAsync(300);

      expect(onPathMembershipChanged).toHaveBeenCalledTimes(1);
      expect(onChange).toHaveBeenCalledTimes(1);
      expect(onWorktreeFilesChanged).not.toHaveBeenCalled();
      gitWatcher.dispose();
    });

    it("watches info/exclude and reports an edit to it", async () => {
      const { gitWatcher, onPathMembershipChanged, onChange } = await liveWatcher();
      const infoDir = pathJoin(gitDir, "info");
      const infoCall = vi.mocked(watch).mock.calls.find(([path]) => path === infoDir) as
        [unknown, unknown, unknown] | undefined;
      const infoCallback = infoCall?.[2] as
        ((eventType: string, filename: string | Buffer | null) => void) | undefined;
      expect(infoCallback).toBeDefined();

      infoCallback?.("change", "exclude");
      await vi.advanceTimersByTimeAsync(300);

      expect(onPathMembershipChanged).toHaveBeenCalledTimes(1);
      expect(onChange).toHaveBeenCalledTimes(1);
      gitWatcher.dispose();
    });

    it("does not report membership for a fetch moving remote-tracking refs", async () => {
      const { gitWatcher, onPathMembershipChanged, onChange } = await liveWatcher();
      const remotesDir = pathJoin(gitDir, "refs", "remotes", "origin");
      const remotesCall = vi.mocked(watch).mock.calls.find(([path]) => path === remotesDir) as
        [unknown, unknown, unknown] | undefined;
      const remotesCallback = remotesCall?.[2] as (() => void) | undefined;
      expect(remotesCallback).toBeDefined();

      remotesCallback?.();
      await vi.advanceTimersByTimeAsync(300);

      expect(onChange).toHaveBeenCalledTimes(1);
      expect(onPathMembershipChanged).not.toHaveBeenCalled();
      gitWatcher.dispose();
    });

    it("reports membership when a fetch and an index write share a debounce", async () => {
      const { gitWatcher, onPathMembershipChanged } = await liveWatcher();
      const remotesDir = pathJoin(gitDir, "refs", "remotes", "origin");
      const remotesCall = vi.mocked(watch).mock.calls.find(([path]) => path === remotesDir) as
        [unknown, unknown, unknown] | undefined;

      (remotesCall?.[2] as (() => void) | undefined)?.();
      gitDirCallback()?.("rename", "index");
      await vi.advanceTimersByTimeAsync(300);

      expect(onPathMembershipChanged).toHaveBeenCalledTimes(1);
      gitWatcher.dispose();
    });
  });

  // ---- Error handling tests (adapted to async Promise rejection) ----

  describe("startup error handling", () => {
    it.each([
      ["inotify_add_watch on '/repo/d65/s41' failed: No space left on device", 1],
      ["ENOSPC: no space left on device, write", 0],
    ])(
      "reads the codeless rejection %j as the inotify watch limit %i time(s)",
      async (message, limitCalls) => {
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
          await gitWatcher.start();

          // The real rejection: a bare Error with no errno code.
          mock.reject(new Error(message));
          await Promise.resolve();
          await flushParcelWatcherCallbacks();

          expect(onInotifyLimitReached).toHaveBeenCalledTimes(limitCalls);
          expect(onWatcherFailed).toHaveBeenCalledTimes(1);
        } finally {
          Object.defineProperty(process, "platform", { value: origPlatform, configurable: true });
        }
      }
    );

    it.each([
      [
        "Unable to initialize inotify: no inotify instance is available (fs.inotify.max_user_instances is used up)",
      ],
      ["Unable to initialize inotify: Too many open files"],
    ])("names the instance limit for %j", async (message) => {
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
        await gitWatcher.start();

        mock.reject(Object.assign(new Error(message), { code: "EMFILE" }));
        await Promise.resolve();
        await flushParcelWatcherCallbacks();

        expect(onInotifyLimitReached).toHaveBeenCalledWith("instances");
        expect(onWatcherFailed).toHaveBeenCalledTimes(1);
      } finally {
        Object.defineProperty(process, "platform", { value: origPlatform, configurable: true });
      }
    });

    it.each([
      ["Unable to initialize inotify: the system's open file table is full", "ENFILE"],
      ["Unable to initialize inotify: Too many open files in system", undefined],
      ["Unable to initialize inotify: Cannot allocate memory", undefined],
    ])("doesn't blame the instance limit for %j", async (message, code) => {
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
        await gitWatcher.start();

        mock.reject(Object.assign(new Error(message), code ? { code } : {}));
        await Promise.resolve();
        await flushParcelWatcherCallbacks();

        expect(onInotifyLimitReached).not.toHaveBeenCalled();
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

        await gitWatcher.start();

        const otherError = new Error("permission denied") as NodeJS.ErrnoException;
        otherError.code = "EACCES";
        mock.reject(otherError);

        await Promise.resolve();
        await flushParcelWatcherCallbacks();

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

        await expect(gitWatcher.start()).resolves.toBe(true);

        const enospcError = new Error("ENOSPC") as NodeJS.ErrnoException;
        enospcError.code = "ENOSPC";
        mock.reject(enospcError);

        expect(onInotifyLimitReached).not.toHaveBeenCalled();
        expect(onWatcherFailed).not.toHaveBeenCalled();

        await Promise.resolve();
        await flushParcelWatcherCallbacks();

        expect(onInotifyLimitReached).toHaveBeenCalledTimes(1);
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

        await gitWatcher.start();

        const fseventError = new Error("file descriptor limit reached") as NodeJS.ErrnoException;
        mock.reject(fseventError);

        await Promise.resolve();
        await flushParcelWatcherCallbacks();

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

        await gitWatcher.start();

        const otherError = new Error("permission denied") as NodeJS.ErrnoException;
        otherError.code = "EACCES";
        mock.reject(otherError);

        await Promise.resolve();
        await flushParcelWatcherCallbacks();

        expect(onEmfileLimitReached).not.toHaveBeenCalled();
        expect(onWatcherFailed).toHaveBeenCalledTimes(1);
      } finally {
        Object.defineProperty(process, "platform", { value: origPlatform, configurable: true });
      }
    });

    it("treats a startup rejection that reads like a rescan as a failed watcher", async () => {
      // A rescan request only means "the stream is alive but lost events" when
      // it arrives through a live subscription. Rejecting the subscribe itself
      // means no stream exists to keep.
      const onChange = vi.fn();
      const onWatcherFailed = vi.fn();
      const mock = setupSubscribeMock();
      const gitWatcher = new GitFileWatcher({
        worktreePath: "/repo",
        branch: "main",
        debounceMs: 300,
        onChange,
        watchWorktree: true,
        onWatcherFailed,
      });

      await gitWatcher.start();
      mock.reject(new Error("Too many events. File system must be re-scanned."));
      await Promise.resolve();
      await flushParcelWatcherCallbacks();

      expect(onWatcherFailed).toHaveBeenCalledTimes(1);
      expect(logWarn).toHaveBeenCalledWith("Worktree recursive watcher error (startup)", {
        path: "/repo",
        error: "Too many events. File system must be re-scanned.",
      });
      gitWatcher.dispose();
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

        await expect(gitWatcher.start()).resolves.toBe(true);

        const emfileError = new Error("EMFILE") as NodeJS.ErrnoException;
        emfileError.code = "EMFILE";
        mock.reject(emfileError);

        expect(onEmfileLimitReached).not.toHaveBeenCalled();
        expect(onWatcherFailed).not.toHaveBeenCalled();

        await Promise.resolve();
        await flushParcelWatcherCallbacks();

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

        await expect(gitWatcher.start()).resolves.toBe(true);
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

        await expect(gitWatcher.start()).resolves.toBe(true);
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

    it("does not signal emfile-limit on non-Darwin platforms for EMFILE runtime error", async () => {
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

        await expect(gitWatcher.start()).resolves.toBe(true);
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

    it("does not signal inotify-limit on non-Linux platforms for ENOSPC runtime error", async () => {
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

        await expect(gitWatcher.start()).resolves.toBe(true);
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

    it("unknown runtime errors downgrade without firing platform-specific callbacks", async () => {
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

      await expect(gitWatcher.start()).resolves.toBe(true);
      mock.resolve();
      const cb = mock.getCallback();

      const otherError = new Error("permission denied") as NodeJS.ErrnoException;
      otherError.code = "EACCES";
      fireError(cb, otherError);

      // The limit callbacks stay platform-gated (they drive platform-specific
      // user guidance), but the downgrade itself must not be: parcel clears the
      // subscription's callbacks after any error, so the watcher is dead
      // whatever the errno said (#12042).
      expect(onInotifyLimitReached).not.toHaveBeenCalled();
      expect(onEmfileLimitReached).not.toHaveBeenCalled();
      expect(onWatcherFailed).toHaveBeenCalledTimes(1);
    });

    it("treats a macOS dropped-events error as a rescan, not a dead watcher", async () => {
      // @parcel/watcher has two error channels. This message comes from
      // EventList::error() (FSEvents MustScanSubDirs), which is delivered
      // through triggerCallbacks WITHOUT clearing the callbacks — the stream is
      // alive and asking for a re-scan. Tearing it down would rebuild a healthy
      // watcher under the very churn that provoked the overflow and burn the
      // controller's bounded re-arm budget.
      const onChange = vi.fn();
      const onWatcherFailed = vi.fn();
      const onWorktreeFilesChanged = vi.fn();
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
          onWorktreeFilesChanged,
        });

        await expect(gitWatcher.start()).resolves.toBe(true);
        mock.resolve();
        const cb = mock.getCallback();

        fireError(
          cb,
          new Error("Events were dropped by the kernel. File system must be re-scanned.")
        );

        expect(onWatcherFailed).not.toHaveBeenCalled();
        // Events WERE lost, so it must still reconcile rather than carrying on
        // with a stale snapshot — and what overflowed was working-tree writes,
        // so the raw-filesystem consumer has to hear about it too, not just the
        // git-status pass.
        await vi.advanceTimersByTimeAsync(1_000);
        expect(onWorktreeFilesChanged).toHaveBeenCalled();
        expect(onChange).toHaveBeenCalled();
      } finally {
        Object.defineProperty(process, "platform", { value: origPlatform, configurable: true });
      }
    });

    it("logs a run of dropped-event errors once per window with the count it swallowed", async () => {
      const onChange = vi.fn();
      const onWorktreeFilesChanged = vi.fn();
      const mock = setupSubscribeMock();
      const gitWatcher = new GitFileWatcher({
        worktreePath: "/repo",
        branch: "main",
        debounceMs: 300,
        onChange,
        watchWorktree: true,
        onWorktreeFilesChanged,
      });
      await expect(gitWatcher.start()).resolves.toBe(true);
      mock.resolve();
      const cb = mock.getCallback();
      const rescanWarnings = () =>
        vi
          .mocked(logWarn)
          .mock.calls.filter(
            ([message]) => message === "Worktree recursive watcher error (runtime)"
          );
      const dropped = new Error(
        "Events were dropped by the FSEvents client. File system must be re-scanned."
      );

      fireError(cb, dropped);
      await vi.advanceTimersByTimeAsync(5_000);
      expect(rescanWarnings()).toHaveLength(1);
      expect(rescanWarnings()[0][1]).not.toHaveProperty("suppressed");
      expect(onChange).toHaveBeenCalledTimes(1);

      // Inside the window the warning goes quiet, but every overflow still
      // lost events and still has to force its refresh.
      fireError(cb, dropped);
      await vi.advanceTimersByTimeAsync(5_000);
      fireError(cb, dropped);
      await vi.advanceTimersByTimeAsync(5_000);
      expect(rescanWarnings()).toHaveLength(1);
      expect(onChange).toHaveBeenCalledTimes(3);
      expect(onWorktreeFilesChanged).toHaveBeenCalledTimes(3);
      expect(onWorktreeFilesChanged).toHaveBeenLastCalledWith(null, true);

      // One millisecond short of the window is still inside it.
      await vi.advanceTimersByTimeAsync(14_999);
      fireError(cb, dropped);
      expect(rescanWarnings()).toHaveLength(1);

      await vi.advanceTimersByTimeAsync(1);
      fireError(cb, dropped);
      expect(rescanWarnings()).toHaveLength(2);
      expect(rescanWarnings()[1][1]).toEqual({
        path: "/repo",
        error: dropped.message,
        suppressed: 3,
      });

      // The count restarts once it has been reported.
      await vi.advanceTimersByTimeAsync(30_000);
      fireError(cb, dropped);
      expect(rescanWarnings()).toHaveLength(3);
      expect(rescanWarnings()[2][1]).not.toHaveProperty("suppressed");

      gitWatcher.dispose();
    });

    it("keeps logging a fatal runtime error while rescan warnings are throttled", async () => {
      const onWatcherFailed = vi.fn();
      const mock = setupSubscribeMock();
      const gitWatcher = new GitFileWatcher({
        worktreePath: "/repo",
        branch: "main",
        debounceMs: 300,
        onChange: vi.fn(),
        watchWorktree: true,
        onWatcherFailed,
      });
      await expect(gitWatcher.start()).resolves.toBe(true);
      mock.resolve();
      const cb = mock.getCallback();

      fireError(
        cb,
        new Error("Events were dropped by the kernel. File system must be re-scanned.")
      );
      fireError(
        cb,
        new Error("Events were dropped by the kernel. File system must be re-scanned.")
      );
      vi.mocked(logWarn).mockClear();

      fireError(cb, new Error("Error starting FSEvents stream"));

      expect(logWarn).toHaveBeenCalledWith("Worktree recursive watcher error (runtime)", {
        path: "/repo",
        error: "Error starting FSEvents stream",
      });
      expect(onWatcherFailed).toHaveBeenCalledTimes(1);

      gitWatcher.dispose();
    });

    it("downgrades on a Windows buffer overflow despite it also losing events", async () => {
      // Superficially the same situation as the macOS rescan above, but this
      // message travels the fatal channel (Watcher::notifyError clears the
      // callbacks), so the subscription really is dead and must be rebuilt.
      const onWatcherFailed = vi.fn();
      const mock = setupSubscribeMock();

      const origPlatform = process.platform;
      Object.defineProperty(process, "platform", { value: "win32", configurable: true });

      try {
        const gitWatcher = new GitFileWatcher({
          worktreePath: "/repo",
          branch: "main",
          debounceMs: 300,
          onChange: vi.fn(),
          watchWorktree: true,
          onWatcherFailed,
        });

        await expect(gitWatcher.start()).resolves.toBe(true);
        mock.resolve();
        const cb = mock.getCallback();

        fireError(cb, new Error("Buffer overflow. Some events may have been lost."));

        expect(onWatcherFailed).toHaveBeenCalledTimes(1);
      } finally {
        Object.defineProperty(process, "platform", { value: origPlatform, configurable: true });
      }
    });

    it("downgrades on a message-only Windows runtime error with no errno", async () => {
      // ReadDirectoryChangesW failures (buffer overflow, an AV lock, an
      // ancestor rename) surface through parcel as a plain message with no
      // stable code — the shape a code-matching branch would miss entirely.
      const onWatcherFailed = vi.fn();
      const onInotifyLimitReached = vi.fn();
      const onEmfileLimitReached = vi.fn();
      const mock = setupSubscribeMock();

      const origPlatform = process.platform;
      Object.defineProperty(process, "platform", { value: "win32", configurable: true });

      try {
        const gitWatcher = new GitFileWatcher({
          worktreePath: "/repo",
          branch: "main",
          debounceMs: 300,
          onChange: vi.fn(),
          watchWorktree: true,
          onWatcherFailed,
          onInotifyLimitReached,
          onEmfileLimitReached,
        });

        await expect(gitWatcher.start()).resolves.toBe(true);
        mock.resolve();
        const cb = mock.getCallback();

        fireError(cb, new Error("Events were dropped by the FS event stream"));

        expect(onWatcherFailed).toHaveBeenCalledTimes(1);
        expect(onInotifyLimitReached).not.toHaveBeenCalled();
        expect(onEmfileLimitReached).not.toHaveBeenCalled();
      } finally {
        Object.defineProperty(process, "platform", { value: origPlatform, configurable: true });
      }
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

    await expect(gitWatcher.start()).resolves.toBe(true);

    const dotGitCalls = vi
      .mocked(watch)
      .mock.calls.filter(([path]) => path === gitDir) as unknown as Array<
      [unknown, unknown, unknown]
    >;
    expect(dotGitCalls).toHaveLength(1);
    const dotGitCallback = dotGitCalls[0][2] as
      ((eventType: string, filename: string | Buffer | null) => void) | undefined;
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

    await expect(gitWatcher.start()).resolves.toBe(true);

    const refsCall = vi
      .mocked(watch)
      .mock.calls.find(([path]) => path === pathJoin(gitDir, "refs", "heads")) as
      [unknown, unknown, unknown] | undefined;
    expect(refsCall).toBeDefined();
    const refsCallback = refsCall?.[2] as
      ((eventType: string, filename: string | Buffer | null) => void) | undefined;
    expect(refsCallback).toBeDefined();

    refsCallback?.("rename", "main");
    await vi.advanceTimersByTimeAsync(150);
    expect(onChange).toHaveBeenCalledTimes(1);

    refsCallback?.("rename", "main.lock");
    await vi.advanceTimersByTimeAsync(150);
    expect(onChange).toHaveBeenCalledTimes(2);
  });

  // ---- Ignore filter tests ----

  // ---- Ignored-burst classification (#12235) ----

  describe("worktree burst ignore classification", () => {
    // Native separators throughout: containment builds its prefix with the
    // platform separator, so POSIX literals would make every event on Windows
    // fall out as "outside the worktree" and the tests would pass through the
    // unknown branch instead of exercising classification at all.
    const REPO = pathResolve("/repo");
    const p = (...parts: string[]) => pathJoin(REPO, ...parts);
    const IGNORED_A = p(".output", "a.js");
    const IGNORED_B = p(".output", "b.js");
    const TRACKED = p("src", "main.ts");
    const VAR_WT = pathResolve("/var/wt");
    const PRIVATE_VAR_WT = pathResolve("/private/var/wt");
    const ALIASED_A = pathJoin(PRIVATE_VAR_WT, ".output", "a.js");

    /** Start a watcher whose worktree bursts are eligible for classification. */
    async function startClassifyingWatcher(overrides: {
      onChange: () => void;
      onWorktreeFilesChanged?: (affectedDirs: readonly string[] | null) => void;
    }) {
      const mock = setupSubscribeMock();
      const gitWatcher = new GitFileWatcher({
        worktreePath: REPO,
        branch: "main",
        debounceMs: 300,
        watchWorktree: true,
        worktreeMinDebounceMs: 100,
        worktreeMaxDebounceMs: 100,
        ...overrides,
      });
      await expect(gitWatcher.start()).resolves.toBe(true);
      mock.resolve();
      await flushParcelWatcherCallbacks();
      return { gitWatcher, cb: mock.getCallback() };
    }

    it("skips the status recompute when every path in the burst is ignored and untracked", async () => {
      const onChange = vi.fn();
      const onWorktreeFilesChanged = vi.fn();
      vi.mocked(checkIgnoredPaths).mockResolvedValue(new Set([IGNORED_A, IGNORED_B]));

      const { cb } = await startClassifyingWatcher({ onChange, onWorktreeFilesChanged });
      fireEvents(cb, [
        { type: "create", path: IGNORED_A },
        { type: "update", path: IGNORED_B },
      ]);
      await vi.advanceTimersByTimeAsync(100);
      // The file browser's signal is never gated on the classification: it
      // fires at the flush boundary, before the verdict exists (#11330).
      expect(onWorktreeFilesChanged).toHaveBeenCalledTimes(1);
      expect(onChange).not.toHaveBeenCalled();

      await flushClassification();
      expect(onChange).not.toHaveBeenCalled();
      expect(onWorktreeFilesChanged).toHaveBeenCalledTimes(1);
      // And it carries the directories, so a build writing only into an ignored
      // folder tells the file browser exactly where to look even though the
      // status pass is skipped entirely (#12244 riding on #11330).
      expect(onWorktreeFilesChanged.mock.calls[0]?.[0]).toEqual([".output"]);

      expect(checkIgnoredPaths).toHaveBeenCalledTimes(1);
      const [cwd, paths] = vi.mocked(checkIgnoredPaths).mock.calls[0];
      expect(cwd).toBe(REPO);
      expect([...paths].sort()).toEqual([IGNORED_A, IGNORED_B]);
    });

    it("refreshes when one path in the burst is not ignored", async () => {
      const onChange = vi.fn();
      // Mixed bursts exit 0 too, so the exit code cannot be the test —
      // membership is. `src/main.ts` is absent from the ignored set.
      vi.mocked(checkIgnoredPaths).mockResolvedValue(new Set([IGNORED_A]));

      const { cb } = await startClassifyingWatcher({ onChange });
      fireEvents(cb, [
        { type: "create", path: IGNORED_A },
        { type: "update", path: TRACKED },
      ]);
      await vi.advanceTimersByTimeAsync(100);
      await flushClassification();
      expect(onChange).toHaveBeenCalledTimes(1);
    });

    it("refreshes when the burst edits .gitignore alongside ignored writes", async () => {
      const onChange = vi.fn();
      // Nothing ignores `.gitignore`, so it fails membership on its own. No
      // filename special-case is involved.
      vi.mocked(checkIgnoredPaths).mockResolvedValue(new Set([IGNORED_A]));

      const { cb } = await startClassifyingWatcher({ onChange });
      fireEvents(cb, [
        { type: "update", path: IGNORED_A },
        { type: "update", path: p(".gitignore") },
      ]);
      await vi.advanceTimersByTimeAsync(100);
      await flushClassification();
      expect(onChange).toHaveBeenCalledTimes(1);
    });

    it("refreshes without classifying when an event carries no path", async () => {
      const onChange = vi.fn();
      const { cb } = await startClassifyingWatcher({ onChange });

      fireEvents(cb, [{ type: "update", path: IGNORED_A }, { type: "update" }]);
      await vi.advanceTimersByTimeAsync(100);
      // Unknown is sticky for the whole burst and resolved synchronously, so
      // onChange lands without waiting on a classification that never runs.
      expect(onChange).toHaveBeenCalledTimes(1);
      expect(checkIgnoredPaths).not.toHaveBeenCalled();
    });

    it("refreshes without classifying for a path outside the worktree", async () => {
      const onChange = vi.fn();
      const { cb } = await startClassifyingWatcher({ onChange });

      // `/repo-other` must not read as living under `/repo`, and the watch
      // root itself is the Windows "unknown filename" signal.
      fireEvents(cb, [{ type: "update", path: pathResolve("/repo-other/a.js") }]);
      await vi.advanceTimersByTimeAsync(100);
      expect(onChange).toHaveBeenCalledTimes(1);
      expect(checkIgnoredPaths).not.toHaveBeenCalled();

      onChange.mockClear();
      fireEvents(cb, [{ type: "update", path: REPO }]);
      await vi.advanceTimersByTimeAsync(100);
      expect(onChange).toHaveBeenCalledTimes(1);
      expect(checkIgnoredPaths).not.toHaveBeenCalled();
    });

    it("classifies paths reported under the worktree's canonical alias", async () => {
      // macOS FSEvents reports realpath'd paths, so a worktree reached through
      // a symlinked ancestor emits events under /private/var while the
      // configured root is /var. Without the alias the optimisation would
      // never fire on any temp-dir worktree.
      vi.mocked(realpath).mockResolvedValue(PRIVATE_VAR_WT as never);
      vi.mocked(getGitDir).mockResolvedValue(pathJoin(VAR_WT, ".git"));
      vi.mocked(checkIgnoredPaths).mockResolvedValue(new Set([ALIASED_A]));
      const onChange = vi.fn();
      const mock = setupSubscribeMock();

      const gitWatcher = new GitFileWatcher({
        worktreePath: VAR_WT,
        branch: "main",
        debounceMs: 300,
        onChange,
        watchWorktree: true,
        worktreeMinDebounceMs: 100,
        worktreeMaxDebounceMs: 100,
      });
      await expect(gitWatcher.start()).resolves.toBe(true);
      mock.resolve();
      await flushParcelWatcherCallbacks();

      fireEvents(mock.getCallback(), [{ type: "create", path: ALIASED_A }]);
      await vi.advanceTimersByTimeAsync(100);
      await flushClassification();
      expect(onChange).not.toHaveBeenCalled();
      // cwd stays the configured root; git resolves it itself.
      expect(vi.mocked(checkIgnoredPaths).mock.calls[0][0]).toBe(VAR_WT);
    });

    it("degrades to a full refresh past the burst path cap", async () => {
      const onChange = vi.fn();
      const { cb } = await startClassifyingWatcher({ onChange });

      // 2049 unique paths: one past the cap. Retaining more buys nothing —
      // a burst that large is never going to be ignored-only.
      fireEvents(
        cb,
        Array.from({ length: 2049 }, (_, i) => ({
          type: "create",
          path: p(".output", `f-${i}.js`),
        }))
      );
      await vi.advanceTimersByTimeAsync(100);
      expect(onChange).toHaveBeenCalledTimes(1);
      expect(checkIgnoredPaths).not.toHaveBeenCalled();
    });

    it("classifies a burst sitting exactly on the cap", async () => {
      vi.mocked(checkIgnoredPaths).mockImplementation(
        (_cwd, paths) => Promise.resolve(new Set(paths)) as never
      );
      const onChange = vi.fn();
      const { cb } = await startClassifyingWatcher({ onChange });

      fireEvents(
        cb,
        Array.from({ length: 2048 }, (_, i) => ({
          type: "create",
          path: p(".output", `f-${i}.js`),
        }))
      );
      await vi.advanceTimersByTimeAsync(100);
      await flushClassification();
      expect(onChange).not.toHaveBeenCalled();
      expect(vi.mocked(checkIgnoredPaths).mock.calls[0][1]).toHaveLength(2048);
    });

    it("unions paths across batches and starts the next burst clean", async () => {
      vi.mocked(checkIgnoredPaths).mockResolvedValue(new Set([IGNORED_A]));
      const onChange = vi.fn();
      const { cb } = await startClassifyingWatcher({ onChange });

      fireEvents(cb, [{ type: "create", path: IGNORED_A }]);
      fireEvents(cb, [{ type: "update", path: IGNORED_A }]);
      fireEvents(cb, [{ type: "update", path: TRACKED }]);
      await vi.advanceTimersByTimeAsync(100);
      await flushClassification();
      // Deduplicated union of all three batches, and the un-ignored member
      // forces the refresh.
      expect(vi.mocked(checkIgnoredPaths).mock.calls[0][1]).toHaveLength(2);
      expect(onChange).toHaveBeenCalledTimes(1);

      // The second burst must not inherit the first burst's paths.
      onChange.mockClear();
      vi.mocked(checkIgnoredPaths).mockClear();
      fireEvents(cb, [{ type: "update", path: IGNORED_A }]);
      await vi.advanceTimersByTimeAsync(100);
      await flushClassification();
      expect(vi.mocked(checkIgnoredPaths).mock.calls[0][1]).toEqual([IGNORED_A]);
      expect(onChange).not.toHaveBeenCalled();
    });

    it("refreshes when the watcher reports a rescan overflow", async () => {
      const onChange = vi.fn();
      const onWorktreeFilesChanged = vi.fn();
      const { cb } = await startClassifyingWatcher({ onChange, onWorktreeFilesChanged });

      // Events were LOST, so the burst's paths are unknowable even though the
      // batch that follows may look ignored-only.
      fireEvents(cb, [{ type: "create", path: IGNORED_A }]);
      fireError(cb, new Error("Events were dropped and must be re-scanned"));
      await vi.advanceTimersByTimeAsync(100);
      expect(onChange).toHaveBeenCalledTimes(1);
      expect(onWorktreeFilesChanged).toHaveBeenCalledTimes(1);
      expect(checkIgnoredPaths).not.toHaveBeenCalled();
    });

    it("refreshes when the classification fails", async () => {
      const onChange = vi.fn();
      vi.mocked(checkIgnoredPaths).mockRejectedValue(new Error("exit 128: outside repository"));

      const { cb } = await startClassifyingWatcher({ onChange });
      fireEvents(cb, [{ type: "create", path: IGNORED_A }]);
      await vi.advanceTimersByTimeAsync(100);
      await flushClassification();
      expect(onChange).toHaveBeenCalledTimes(1);
    });

    it("refreshes for both bursts when a new flush supersedes a pending classification", async () => {
      const onChange = vi.fn();
      let releaseFirst: ((ignored: Set<string>) => void) | undefined;
      vi.mocked(checkIgnoredPaths)
        .mockImplementationOnce(
          () =>
            new Promise<Set<string>>((resolve) => {
              releaseFirst = resolve;
            }) as never
        )
        .mockResolvedValue(new Set([IGNORED_B]));

      const { cb } = await startClassifyingWatcher({ onChange });
      fireEvents(cb, [{ type: "create", path: IGNORED_A }]);
      await vi.advanceTimersByTimeAsync(100);
      expect(onChange).not.toHaveBeenCalled();

      // A second flush arrives while the first verdict is still pending. The
      // first burst's refresh was never fired and its decision is now lost, so
      // the flush that supersedes it must refresh for both rather than
      // classify itself.
      fireEvents(cb, [{ type: "create", path: IGNORED_B }]);
      await vi.advanceTimersByTimeAsync(100);
      expect(onChange).toHaveBeenCalledTimes(1);
      expect(checkIgnoredPaths).toHaveBeenCalledTimes(1);

      // The retired verdict lands with an EMPTY set — i.e. "nothing was
      // ignored, refresh". If the generation guard were missing it would call
      // onChange a second time; resolving it as all-ignored would have passed
      // either way and tested nothing.
      releaseFirst?.(new Set());
      await flushClassification();
      expect(onChange).toHaveBeenCalledTimes(1);
    });

    it("does not refresh from a classification that lands after dispose", async () => {
      const onChange = vi.fn();
      let release: ((ignored: Set<string>) => void) | undefined;
      vi.mocked(checkIgnoredPaths).mockImplementation(
        () =>
          new Promise<Set<string>>((resolve) => {
            release = resolve;
          }) as never
      );

      const { gitWatcher, cb } = await startClassifyingWatcher({ onChange });
      fireEvents(cb, [{ type: "update", path: TRACKED }]);
      await vi.advanceTimersByTimeAsync(100);
      expect(onChange).not.toHaveBeenCalled();

      gitWatcher.dispose();
      release?.(new Set());
      await flushClassification();
      expect(onChange).not.toHaveBeenCalled();
      await flushParcelWatcherCallbacks();
    });

    it("aborts the in-flight classification on dispose", async () => {
      let captured: AbortSignal | undefined;
      vi.mocked(checkIgnoredPaths).mockImplementation(((
        _cwd: string,
        _paths: readonly string[],
        options?: { signal?: AbortSignal }
      ) => {
        captured = options?.signal;
        return new Promise<Set<string>>(() => {});
      }) as never);

      const { gitWatcher, cb } = await startClassifyingWatcher({ onChange: vi.fn() });
      fireEvents(cb, [{ type: "update", path: TRACKED }]);
      await vi.advanceTimersByTimeAsync(100);
      expect(captured?.aborted).toBe(false);

      gitWatcher.dispose();
      expect(captured?.aborted).toBe(true);
      await flushParcelWatcherCallbacks();
    });

    it("refreshes for a .gitignore write even when git reports it as ignored", async () => {
      const onChange = vi.fn();
      // A `.gitignore` that is itself ignored — by `.git/info/exclude`, or by a
      // rule inside it naming itself — is untracked and ignored, so plain
      // check-ignore DOES report it. Classifying on that membership would skip
      // a refresh the rule change just made necessary.
      vi.mocked(checkIgnoredPaths).mockResolvedValue(new Set([p(".gitignore"), IGNORED_A]));

      const { cb } = await startClassifyingWatcher({ onChange });
      fireEvents(cb, [
        { type: "update", path: IGNORED_A },
        { type: "update", path: p(".gitignore") },
      ]);
      await vi.advanceTimersByTimeAsync(100);
      expect(onChange).toHaveBeenCalledTimes(1);
      expect(checkIgnoredPaths).not.toHaveBeenCalled();
    });

    it.each([".gitattributes", ".gitmodules", ".GITIGNORE"])(
      "refreshes for a %s write",
      async (name) => {
        const onChange = vi.fn();
        // `.gitattributes` changes normalisation, so it decides whether a CRLF
        // working file still compares equal to its LF blob; `.gitmodules`
        // carries submodule.<name>.ignore. Both change what status reports
        // about OTHER paths. The name is matched case-insensitively because on
        // APFS or NTFS `.GITIGNORE` is the same file to git.
        vi.mocked(checkIgnoredPaths).mockResolvedValue(new Set([p(name)]));

        const { cb } = await startClassifyingWatcher({ onChange });
        fireEvents(cb, [{ type: "update", path: p(name) }]);
        await vi.advanceTimersByTimeAsync(100);
        expect(onChange).toHaveBeenCalledTimes(1);
        expect(checkIgnoredPaths).not.toHaveBeenCalled();
      }
    );

    it("drops the cached tracked-ignored answer when a .gitignore is written", async () => {
      const onChange = vi.fn();
      vi.mocked(checkIgnoredPaths).mockResolvedValue(new Set([IGNORED_A]));
      const { cb } = await startClassifyingWatcher({ onChange });

      // Warm the probe to "no hazard" through a normal skippable burst.
      fireEvents(cb, [{ type: "create", path: IGNORED_A }]);
      await vi.advanceTimersByTimeAsync(100);
      await flushClassification();
      expect(onChange).not.toHaveBeenCalled();
      expect(hasTrackedIgnoredPaths).toHaveBeenCalledTimes(1);

      // A rule edit can newly ignore a directory holding a tracked file, which
      // creates the hazard the cached answer denies — and it reaches no
      // watched git-internal file, so nothing else would invalidate it.
      fireEvents(cb, [{ type: "update", path: p(".gitignore") }]);
      await vi.advanceTimersByTimeAsync(100);
      vi.mocked(hasTrackedIgnoredPaths).mockResolvedValue(true);

      // Same skippable shape as the first burst, so the flow reaches the
      // probe again rather than short-circuiting on membership.
      onChange.mockClear();
      fireEvents(cb, [{ type: "create", path: IGNORED_A }]);
      await vi.advanceTimersByTimeAsync(100);
      await flushClassification();
      expect(hasTrackedIgnoredPaths).toHaveBeenCalledTimes(2);
      expect(onChange).toHaveBeenCalledTimes(1);
    });

    it("refreshes for a nested .gitignore write", async () => {
      const onChange = vi.fn();
      const { cb } = await startClassifyingWatcher({ onChange });
      // Rules apply per-directory, so a nested file changes status too.
      fireEvents(cb, [{ type: "update", path: p("packages", "web", ".gitignore") }]);
      await vi.advanceTimersByTimeAsync(100);
      expect(onChange).toHaveBeenCalledTimes(1);
      expect(checkIgnoredPaths).not.toHaveBeenCalled();
    });

    it("refuses to skip while the repo has tracked files matching an ignore rule", async () => {
      const onChange = vi.fn();
      // git's tracked-file exemption is a case-SENSITIVE index lookup, so on a
      // case-insensitive filesystem a force-added `.output/Keep.txt` renamed to
      // `.output/keep.txt` is still tracked and still reports as ignored. The
      // skip is only sound while no tracked file matches an ignore rule.
      vi.mocked(hasTrackedIgnoredPaths).mockResolvedValue(true);
      vi.mocked(checkIgnoredPaths).mockResolvedValue(new Set([IGNORED_A]));

      const { cb } = await startClassifyingWatcher({ onChange });
      fireEvents(cb, [{ type: "create", path: IGNORED_A }]);
      await vi.advanceTimersByTimeAsync(100);
      await flushClassification();
      expect(onChange).toHaveBeenCalledTimes(1);
    });

    it("refreshes when the tracked-ignored probe fails, and retries it next burst", async () => {
      const onChange = vi.fn();
      vi.mocked(checkIgnoredPaths).mockResolvedValue(new Set([IGNORED_A]));
      vi.mocked(hasTrackedIgnoredPaths).mockRejectedValueOnce(new Error("probe failed"));

      const { cb } = await startClassifyingWatcher({ onChange });
      fireEvents(cb, [{ type: "create", path: IGNORED_A }]);
      await vi.advanceTimersByTimeAsync(100);
      await flushClassification();
      expect(onChange).toHaveBeenCalledTimes(1);

      // A failed probe must not be cached as "safe" — nor as permanently
      // broken. The next burst asks again and can skip.
      vi.mocked(hasTrackedIgnoredPaths).mockResolvedValue(false);
      onChange.mockClear();
      fireEvents(cb, [{ type: "update", path: IGNORED_A }]);
      await vi.advanceTimersByTimeAsync(100);
      await flushClassification();
      expect(onChange).not.toHaveBeenCalled();
    });

    it("keeps a burst unknown once any event in it was unclassifiable", async () => {
      const onChange = vi.fn();
      const { cb } = await startClassifyingWatcher({ onChange });

      // Unknown is sticky for the rest of the burst: a later well-formed batch
      // must not rehabilitate a burst that already lost a path.
      fireEvents(cb, [{ type: "update" }]);
      fireEvents(cb, [{ type: "update", path: IGNORED_A }]);
      await vi.advanceTimersByTimeAsync(100);
      expect(onChange).toHaveBeenCalledTimes(1);
      expect(checkIgnoredPaths).not.toHaveBeenCalled();

      // …and it must not leak into the next burst.
      vi.mocked(checkIgnoredPaths).mockResolvedValue(new Set([IGNORED_A]));
      onChange.mockClear();
      fireEvents(cb, [{ type: "update", path: IGNORED_A }]);
      await vi.advanceTimersByTimeAsync(100);
      await flushClassification();
      expect(onChange).not.toHaveBeenCalled();
      expect(checkIgnoredPaths).toHaveBeenCalledTimes(1);
    });

    it("stays silent when a classification rejects after dispose", async () => {
      let reject: ((error: Error) => void) | undefined;
      vi.mocked(checkIgnoredPaths).mockImplementation(
        () =>
          new Promise<Set<string>>((_resolve, rej) => {
            reject = rej;
          }) as never
      );
      const onChange = vi.fn();
      const { gitWatcher, cb } = await startClassifyingWatcher({ onChange });
      fireEvents(cb, [{ type: "update", path: TRACKED }]);
      await vi.advanceTimersByTimeAsync(100);

      gitWatcher.dispose();
      reject?.(new Error("spawn failed"));
      await flushClassification();
      expect(onChange).not.toHaveBeenCalled();
      expect(logWarn).not.toHaveBeenCalled();
      await flushParcelWatcherCallbacks();
    });

    it("throttles the classification-failure warning but never the refresh", async () => {
      const onChange = vi.fn();
      vi.mocked(checkIgnoredPaths).mockRejectedValue(new Error("exit 128"));
      const { cb } = await startClassifyingWatcher({ onChange });

      for (let burst = 0; burst < 3; burst++) {
        fireEvents(cb, [{ type: "update", path: IGNORED_A }]);
        await vi.advanceTimersByTimeAsync(100);
        await flushClassification();
      }
      // Every failure still refreshes — only the log line is rate-limited,
      // because this fires per flush rather than on demand.
      expect(onChange).toHaveBeenCalledTimes(3);
      expect(vi.mocked(logWarn).mock.calls.length).toBe(1);
    });

    it("keeps the adaptive debounce ramp driven by raw event count", async () => {
      const onChange = vi.fn();
      const mock = setupSubscribeMock();
      const gitWatcher = new GitFileWatcher({
        worktreePath: REPO,
        branch: "main",
        debounceMs: 300,
        onChange,
        watchWorktree: true,
        worktreeMinDebounceMs: 150,
        worktreeMaxDebounceMs: 800,
      });
      await expect(gitWatcher.start()).resolves.toBe(true);
      mock.resolve();
      await flushParcelWatcherCallbacks();

      // Ten events on ONE path: the ramp counts events, not unique paths, so
      // carrying a deduplicated set must not shorten the delay.
      fireEvents(
        mock.getCallback(),
        Array.from({ length: 10 }, () => ({ type: "update", path: IGNORED_A }))
      );
      await vi.advanceTimersByTimeAsync(150);
      expect(onChange).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(90);
      await flushClassification();
      expect(onChange).toHaveBeenCalledTimes(1);
    });
  });

  describe("worktree ignore filter", () => {
    it("passes the existing hot directories as literal ignores beside every glob", async () => {
      exclusionsMock.mockResolvedValue(["node_modules", ".git", "dist"]);
      const mock = setupSubscribeMock();
      const gitWatcher = new GitFileWatcher({
        worktreePath: "/repo",
        branch: "main",
        debounceMs: 300,
        onChange: vi.fn(),
        watchWorktree: true,
      });

      await gitWatcher.start();

      const ignore = mock.getOptions()?.ignore as string[];
      // Plain names are what Parcel forwards to FSEventStreamSetExclusionPaths;
      // the globs still filter nested matches and anything past the cap.
      expect(ignore.slice(-3)).toEqual(["node_modules", ".git", "dist"]);
      expect(ignore).toContain("**/node_modules/**");
      expect(ignore).toContain("**/.git/**");
      expect(ignore.filter((entry) => entry.startsWith("**/"))).toHaveLength(19);
      expect(ignore).toHaveLength(22);

      mock.resolve();
      await flushParcelWatcherCallbacks();
      gitWatcher.dispose();
      await flushParcelWatcherCallbacks();
    });

    it("only offers directories the globs already ignore, node_modules and .git first", async () => {
      const mock = setupSubscribeMock();
      const gitWatcher = new GitFileWatcher({
        worktreePath: "/repo",
        branch: "main",
        debounceMs: 300,
        onChange: vi.fn(),
        watchWorktree: true,
      });

      await gitWatcher.start();

      const candidates = exclusionsMock.mock.calls[0][1] as string[];
      expect(candidates.slice(0, 2)).toEqual(["node_modules", ".git"]);
      const ignore = mock.getOptions()?.ignore as string[];
      for (const name of candidates) {
        // An exclusion must only ever drop churn the globs already discard,
        // or a change the user cares about would go silent.
        expect(ignore).toContain(`**/${name}/**`);
      }

      mock.resolve();
      await flushParcelWatcherCallbacks();
      gitWatcher.dispose();
      await flushParcelWatcherCallbacks();
    });

    it("subscribes at the canonical root on macOS so FSEvents paths match it", async () => {
      vi.mocked(realpath).mockImplementation(((p: string) =>
        Promise.resolve(p === "/repo" ? "/private/repo" : p)) as never);
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
        });
        await gitWatcher.start();

        expect(mock.getDir()).toBe("/private/repo");
        expect(exclusionsMock.mock.calls[0][0]).toBe("/private/repo");

        mock.resolve();
        await flushParcelWatcherCallbacks();
        gitWatcher.dispose();
        await flushParcelWatcherCallbacks();
      } finally {
        Object.defineProperty(process, "platform", { value: origPlatform, configurable: true });
      }
    });

    it("keeps the configured root off macOS", async () => {
      vi.mocked(realpath).mockImplementation(((p: string) =>
        Promise.resolve(p === "/repo" ? "/private/repo" : p)) as never);
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
        });
        await gitWatcher.start();

        expect(mock.getDir()).toBe("/repo");
        expect(exclusionsMock.mock.calls[0][0]).toBe("/repo");

        mock.resolve();
        await flushParcelWatcherCallbacks();
        gitWatcher.dispose();
        await flushParcelWatcherCallbacks();
      } finally {
        Object.defineProperty(process, "platform", { value: origPlatform, configurable: true });
      }
    });

    it("does not subscribe when disposed while the exclusions are resolving", async () => {
      let releaseExclusions: ((names: string[]) => void) | undefined;
      exclusionsMock.mockImplementation(
        () =>
          new Promise<string[]>((resolve) => {
            releaseExclusions = resolve;
          })
      );
      const gitWatcher = new GitFileWatcher({
        worktreePath: "/repo",
        branch: "main",
        debounceMs: 300,
        onChange: vi.fn(),
        watchWorktree: true,
      });

      const started = gitWatcher.start();
      await vi.waitFor(() => expect(releaseExclusions).toBeDefined());
      gitWatcher.dispose();
      releaseExclusions?.(["node_modules"]);

      await expect(started).resolves.toBe(false);
      expect(subscribeMock).not.toHaveBeenCalled();
    });

    it("does not look for exclusions when the worktree is not watched", async () => {
      const gitWatcher = new GitFileWatcher({
        worktreePath: "/repo",
        branch: "main",
        debounceMs: 300,
        onChange: vi.fn(),
      });

      await expect(gitWatcher.start()).resolves.toBe(true);

      expect(exclusionsMock).not.toHaveBeenCalled();
      gitWatcher.dispose();
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

      await expect(gitWatcher.start()).resolves.toBe(true);
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

    await gitWatcher.start();

    const sub = mock.resolveSub();
    // Flush microtasks so the .then() callback stores worktreeSubscription
    await flushParcelWatcherCallbacks();
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

    await gitWatcher.start();
    gitWatcher.dispose();

    const sub = createMockSubscription();
    mock.resolve(sub);

    await Promise.resolve();
    await flushParcelWatcherCallbacks();

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

    await expect(gitWatcher.start()).resolves.toBe(true);
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

      await gitWatcher.start();
      gitWatcher.dispose();

      const enospcError = new Error("ENOSPC") as NodeJS.ErrnoException;
      enospcError.code = "ENOSPC";
      mock.reject(enospcError);

      await Promise.resolve();
      await flushParcelWatcherCallbacks();

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

      await expect(gitWatcher.start()).resolves.toBe(true);
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

  it("unsubscribe rejection does not produce unhandled promise rejection", async () => {
    const mock = setupSubscribeMock();

    const gitWatcher = new GitFileWatcher({
      worktreePath: "/repo",
      branch: "main",
      debounceMs: 300,
      onChange: vi.fn(),
      watchWorktree: true,
    });

    await gitWatcher.start();

    const sub = {
      unsubscribe: vi.fn().mockRejectedValue(new Error("native teardown failed")),
    };
    mock.resolve(sub);

    await flushParcelWatcherCallbacks();

    // dispose() calls unsubscribe().catch(() => {}) — should not throw
    expect(() => gitWatcher.dispose()).not.toThrow();
  });
});
