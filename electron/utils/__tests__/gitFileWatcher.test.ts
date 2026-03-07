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
