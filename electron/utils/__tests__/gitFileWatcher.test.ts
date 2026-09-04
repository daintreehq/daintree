import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { watch, type FSWatcher } from "fs";
import { readFile } from "fs/promises";
import { join as pathJoin } from "path";
import { getGitDir } from "../gitUtils.js";
import { GitFileWatcher } from "../gitFileWatcher.js";
import { settleParcelWatcherLifecycle } from "../parcelWatcherBackend.js";

const { subscribeMock } = vi.hoisted(() => ({ subscribeMock: vi.fn() }));

vi.mock("../parcelWatcherBackend.js", () => ({
  subscribeParcelWatcher: subscribeMock,
  settleParcelWatcherLifecycle: () => Promise.resolve(),
}));

vi.mock("fs", () => ({
  watch: vi.fn(),
}));

vi.mock("fs/promises", () => ({
  readFile: vi.fn(),
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

  subscribeMock.mockImplementation(
    (
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
    }
  );

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

/** Drain the serialized native lifecycle and its consumer promise callbacks. */
async function flushParcelWatcherCallbacks(): Promise<void> {
  await settleParcelWatcherLifecycle();
  await Promise.resolve();
  await Promise.resolve();
}

describe("GitFileWatcher", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();

    vi.mocked(getGitDir).mockResolvedValue(pathJoin("/repo", ".git"));
    vi.mocked(readFile).mockRejectedValue(new Error("commondir missing"));
    vi.mocked(watch).mockImplementation(() => createMockWatcher());
    // Default subscribe: resolve immediately so non-worktree tests don't hang
    subscribeMock.mockResolvedValue(createMockSubscription());
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

  it("triggers onChange when .git/config changes (catches `git push -u`)", async () => {
    const gitDir = pathJoin("/repo", ".git");
    const onChange = vi.fn();
    const gitWatcher = new GitFileWatcher({
      worktreePath: "/repo",
      branch: "main",
      debounceMs: 150,
      onChange,
    });

    await expect(gitWatcher.start()).resolves.toBe(true);

    const dotGitCall = vi.mocked(watch).mock.calls.find(([path]) => path === gitDir) as
      [unknown, unknown, unknown] | undefined;
    expect(dotGitCall).toBeDefined();
    const dotGitCallback = dotGitCall?.[2] as
      ((eventType: string, filename: string | Buffer | null) => void) | undefined;

    dotGitCallback?.("rename", "config");
    await vi.advanceTimersByTimeAsync(150);
    expect(onChange).toHaveBeenCalledTimes(1);
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

  it("watches refs/remotes/origin so an external fetch advancing origin surfaces", async () => {
    const originDir = pathJoin("/repo", ".git", "refs", "remotes", "origin");
    const gitWatcher = new GitFileWatcher({
      worktreePath: "/repo",
      branch: "main",
      debounceMs: 150,
      onChange: vi.fn(),
    });

    await expect(gitWatcher.start()).resolves.toBe(true);

    const watchedPaths = vi.mocked(watch).mock.calls.map(([path]) => path);
    expect(watchedPaths).toContain(originDir);
  });

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

    await expect(gitWatcher.start()).resolves.toBe(true);

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

        await gitWatcher.start();

        const enospcError = new Error("ENOSPC") as NodeJS.ErrnoException;
        enospcError.code = "ENOSPC";
        mock.reject(enospcError);

        await Promise.resolve();
        await flushParcelWatcherCallbacks();

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

        await gitWatcher.start();

        const enospcError = new Error("ENOSPC") as NodeJS.ErrnoException;
        enospcError.code = "ENOSPC";
        mock.reject(enospcError);

        await Promise.resolve();
        await flushParcelWatcherCallbacks();

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

        await gitWatcher.start();

        const emfileError = new Error("EMFILE") as NodeJS.ErrnoException;
        emfileError.code = "EMFILE";
        mock.reject(emfileError);

        await Promise.resolve();
        await flushParcelWatcherCallbacks();

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

  describe("worktree ignore filter", () => {
    it("passes WORKTREE_IGNORE_GLOBS to subscribe as native ignore option", async () => {
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

      await gitWatcher.start();

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
        ".pytest_cache",
        ".mypy_cache",
        ".ruff_cache",
        "venv",
        ".tox",
        ".gradle",
      ];
      for (const dir of expectedDirs) {
        expect(ignore).toContain(`**/${dir}/**`);
      }
      expect(ignore).toContain("**/.git");
      expect(ignore).toContain("**/.git/**");
      expect(ignore).toHaveLength(expectedDirs.length + 2);

      mock.resolve();
      await flushParcelWatcherCallbacks();
      gitWatcher.dispose();
      await flushParcelWatcherCallbacks();
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

      await expect(gitWatcher.start()).resolves.toBe(true);
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

      await expect(gitWatcher.start()).resolves.toBe(true);
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

      await gitWatcher.start();

      const enoentError = new Error("file not found") as NodeJS.ErrnoException;
      enoentError.code = "ENOENT";
      mock.reject(enoentError);

      await Promise.resolve();
      await flushParcelWatcherCallbacks();

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
