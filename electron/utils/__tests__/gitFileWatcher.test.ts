import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync, watch, type FSWatcher } from "fs";
import { join as pathJoin } from "path";
import { getGitDir } from "../gitUtils.js";
import { GitFileWatcher } from "../gitFileWatcher.js";

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

describe("GitFileWatcher", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();

    vi.mocked(getGitDir).mockReturnValue(pathJoin("/repo", ".git"));
    vi.mocked(readFileSync).mockImplementation(() => {
      throw new Error("commondir missing");
    });
    vi.mocked(watch).mockImplementation(() => createMockWatcher());
  });

  afterEach(() => {
    vi.useRealTimers();
  });

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

    expect(watchedPaths).not.toContain(pathJoin(gitDir, "index"));
    expect(watchedPaths).not.toContain(pathJoin(gitDir, "HEAD"));
    expect(watchedPaths).not.toContain(pathJoin(gitDir, "refs", "heads", "main"));
  });

  it("does not trigger on index changes (avoids git-status feedback loop)", async () => {
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

    // index and index.lock should NOT trigger onChange (not tracked)
    dotGitCallback?.("rename", "index");
    dotGitCallback?.("rename", "index.lock");
    await vi.advanceTimersByTimeAsync(250);
    expect(onChange).not.toHaveBeenCalled();

    // HEAD should still trigger (tracked in .git directory)
    dotGitCallback?.("rename", "HEAD");
    await vi.advanceTimersByTimeAsync(200);
    expect(onChange).toHaveBeenCalledTimes(1);
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

    // Unrelated file in .git directory should not trigger
    dotGitCallback?.("rename", "config");
    await vi.advanceTimersByTimeAsync(250);
    expect(onChange).not.toHaveBeenCalled();

    // HEAD change triggers after debounce
    dotGitCallback?.("rename", "HEAD");
    await vi.advanceTimersByTimeAsync(199);
    expect(onChange).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(onChange).toHaveBeenCalledTimes(1);

    // Multiple events within debounce window coalesce
    dotGitCallback?.("rename", "HEAD");
    dotGitCallback?.("rename", "packed-refs");
    await vi.advanceTimersByTimeAsync(200);
    expect(onChange).toHaveBeenCalledTimes(2);
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

    // Reflog (HEAD) update fires onChange
    logsCallback?.("rename", "HEAD");
    await vi.advanceTimersByTimeAsync(150);
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it("worktree events debounce normally for short bursts", async () => {
    const onChange = vi.fn();
    let worktreeCallback: ((eventType: string, filename: string | null) => void) | undefined;

    vi.mocked(watch).mockImplementation(((
      _path: string,
      opts: Record<string, unknown>,
      cb?: (eventType: string, filename: string | null) => void
    ) => {
      const w = createMockWatcher();
      if (opts?.recursive) {
        worktreeCallback = cb;
      }
      return w;
    }) as unknown as typeof watch);

    const gitWatcher = new GitFileWatcher({
      worktreePath: "/repo",
      branch: "main",
      debounceMs: 300,
      onChange,
      watchWorktree: true,
      worktreeDebounceMs: 500,
      worktreeMaxWaitMs: 2000,
    });

    expect(gitWatcher.start()).toBe(true);
    expect(worktreeCallback).toBeDefined();

    // Fire 3 events within debounce window
    worktreeCallback?.("change", "src/a.ts");
    worktreeCallback?.("change", "src/b.ts");
    worktreeCallback?.("change", "src/c.ts");

    await vi.advanceTimersByTimeAsync(500);
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it("sustained burst fires onChange at max-wait ceiling", async () => {
    const onChange = vi.fn();
    let worktreeCallback: ((eventType: string, filename: string | null) => void) | undefined;

    vi.mocked(watch).mockImplementation(((
      _path: string,
      opts: Record<string, unknown>,
      cb?: (eventType: string, filename: string | null) => void
    ) => {
      const w = createMockWatcher();
      if (opts?.recursive) {
        worktreeCallback = cb;
      }
      return w;
    }) as unknown as typeof watch);

    const gitWatcher = new GitFileWatcher({
      worktreePath: "/repo",
      branch: "main",
      debounceMs: 300,
      onChange,
      watchWorktree: true,
      worktreeDebounceMs: 500,
      worktreeMaxWaitMs: 2000,
    });

    expect(gitWatcher.start()).toBe(true);
    expect(worktreeCallback).toBeDefined();

    // Fire first event to start both debounce and max-wait timers
    worktreeCallback?.("change", "src/file0.ts");

    // Keep firing events every 200ms — debounce (500ms) keeps resetting
    // At 1800ms total, no call should have fired yet (max-wait is 2000ms)
    for (let i = 1; i <= 9; i++) {
      await vi.advanceTimersByTimeAsync(200);
      worktreeCallback?.("change", `src/file${i}.ts`);
    }
    expect(onChange).not.toHaveBeenCalled();

    // Advance to the 2000ms mark — max-wait ceiling fires
    await vi.advanceTimersByTimeAsync(200);
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it("max-wait timer is cleared when trailing debounce fires", async () => {
    const onChange = vi.fn();
    let worktreeCallback: ((eventType: string, filename: string | null) => void) | undefined;

    vi.mocked(watch).mockImplementation(((
      _path: string,
      opts: Record<string, unknown>,
      cb?: (eventType: string, filename: string | null) => void
    ) => {
      const w = createMockWatcher();
      if (opts?.recursive) {
        worktreeCallback = cb;
      }
      return w;
    }) as unknown as typeof watch);

    const gitWatcher = new GitFileWatcher({
      worktreePath: "/repo",
      branch: "main",
      debounceMs: 300,
      onChange,
      watchWorktree: true,
      worktreeDebounceMs: 500,
      worktreeMaxWaitMs: 2000,
    });

    expect(gitWatcher.start()).toBe(true);

    // Fire 2 events, let trailing debounce fire at 500ms
    worktreeCallback?.("change", "src/a.ts");
    worktreeCallback?.("change", "src/b.ts");

    await vi.advanceTimersByTimeAsync(500);
    expect(onChange).toHaveBeenCalledTimes(1);

    // Wait past the max-wait ceiling — should NOT fire duplicate
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
      worktreeDebounceMs: 500,
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

  it("onWatcherFailed is called when recursive watcher emits error on Linux ENOSPC", () => {
    const onChange = vi.fn();
    const onWatcherFailed = vi.fn();
    let errorHandler: ((error: NodeJS.ErrnoException) => void) | undefined;

    const origPlatform = process.platform;
    Object.defineProperty(process, "platform", { value: "linux", configurable: true });

    vi.mocked(watch).mockImplementation(((
      _path: string,
      opts: Record<string, unknown>,
      _cb?: unknown
    ) => {
      const w = createMockWatcher();
      if (opts?.recursive) {
        vi.mocked(w.on).mockImplementation(((event: string, handler: unknown) => {
          if (event === "error") {
            errorHandler = handler as (error: NodeJS.ErrnoException) => void;
          }
          return w;
        }) as unknown as typeof w.on);
      }
      return w;
    }) as unknown as typeof watch);

    const gitWatcher = new GitFileWatcher({
      worktreePath: "/repo",
      branch: "main",
      debounceMs: 300,
      onChange,
      watchWorktree: true,
      onWatcherFailed,
    });

    gitWatcher.start();
    expect(errorHandler).toBeDefined();

    const enospcError = new Error("ENOSPC") as NodeJS.ErrnoException;
    enospcError.code = "ENOSPC";
    errorHandler?.(enospcError);

    expect(onWatcherFailed).toHaveBeenCalledTimes(1);

    Object.defineProperty(process, "platform", { value: origPlatform, configurable: true });
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

    // Branch ref update fires onChange
    refsCallback?.("rename", "main");
    await vi.advanceTimersByTimeAsync(150);
    expect(onChange).toHaveBeenCalledTimes(1);

    // Lock file for branch ref also fires onChange
    refsCallback?.("rename", "main.lock");
    await vi.advanceTimersByTimeAsync(150);
    expect(onChange).toHaveBeenCalledTimes(2);
  });
});
