import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync, watch, type FSWatcher } from "fs";
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

    vi.mocked(getGitDir).mockReturnValue("/repo/.git");
    vi.mocked(readFileSync).mockImplementation(() => {
      throw new Error("commondir missing");
    });
    vi.mocked(watch).mockImplementation(() => createMockWatcher());
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("watches parent directories and de-duplicates shared paths", () => {
    const gitWatcher = new GitFileWatcher({
      worktreePath: "/repo",
      branch: "main",
      debounceMs: 300,
      onChange: vi.fn(),
    });

    expect(gitWatcher.start()).toBe(true);

    const watchedPaths = vi.mocked(watch).mock.calls.map(([path]) => path);
    expect(watchedPaths).toContain("/repo/.git");
    expect(watchedPaths).toContain("/repo/.git/refs/heads");
    expect(watchedPaths.filter((path) => path === "/repo/.git")).toHaveLength(1);

    // Regression guard: file-level watchers became stale after git rename-based updates.
    expect(watchedPaths).not.toContain("/repo/.git/index");
    expect(watchedPaths).not.toContain("/repo/.git/HEAD");
    expect(watchedPaths).not.toContain("/repo/.git/refs/heads/main");
  });

  it("filters unrelated directory events and debounces matching events", async () => {
    const onChange = vi.fn();
    const gitWatcher = new GitFileWatcher({
      worktreePath: "/repo",
      branch: "main",
      debounceMs: 200,
      onChange,
    });

    expect(gitWatcher.start()).toBe(true);

    const dotGitCall = vi
      .mocked(watch)
      .mock.calls.find(([path]) => path === "/repo/.git") as [unknown, unknown, unknown] | undefined;
    expect(dotGitCall).toBeDefined();
    const dotGitCallback = dotGitCall?.[2] as
      | ((eventType: string, filename: string | Buffer | null) => void)
      | undefined;
    expect(dotGitCallback).toBeDefined();

    dotGitCallback?.("rename", "config");
    await vi.advanceTimersByTimeAsync(250);
    expect(onChange).not.toHaveBeenCalled();

    dotGitCallback?.("rename", "index");
    await vi.advanceTimersByTimeAsync(199);
    expect(onChange).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(onChange).toHaveBeenCalledTimes(1);

    dotGitCallback?.("rename", "HEAD");
    dotGitCallback?.("rename", "index");
    await vi.advanceTimersByTimeAsync(200);
    expect(onChange).toHaveBeenCalledTimes(2);
  });
});
