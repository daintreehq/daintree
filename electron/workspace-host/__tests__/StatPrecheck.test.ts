import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("fs/promises", () => ({
  readFile: vi.fn().mockRejectedValue(new Error("ENOENT")),
  stat: vi.fn().mockRejectedValue(Object.assign(new Error("ENOENT"), { code: "ENOENT" })),
}));

import { readFile, stat } from "fs/promises";
import { StatPrecheck, type StatPrecheckHost } from "../StatPrecheck.js";

function makeHost(overrides: Partial<StatPrecheckHost> = {}): StatPrecheckHost {
  return {
    abortSignal: new AbortController().signal,
    ...overrides,
  };
}

function makeStatResult(mtimeMs: number) {
  return { mtimeMs } as Awaited<ReturnType<typeof stat>>;
}

describe("StatPrecheck", () => {
  beforeEach(() => {
    vi.mocked(readFile).mockReset().mockRejectedValue(new Error("ENOENT"));
    vi.mocked(stat)
      .mockReset()
      .mockRejectedValue(Object.assign(new Error("ENOENT"), { code: "ENOENT" }));
  });

  it("never skips before a baseline has been recorded", async () => {
    const precheck = new StatPrecheck(makeHost());
    const skip = await precheck.shouldSkip("/repo/.git", "main", 0, true);
    expect(skip).toBe(false);
  });

  it("skips when a recorded baseline still matches and no watcher event fired since", async () => {
    vi.mocked(stat).mockResolvedValue(makeStatResult(1_000));
    const precheck = new StatPrecheck(makeHost());

    await precheck.recordFullPass("/repo/.git", "main");
    const skip = await precheck.shouldSkip("/repo/.git", "main", 0, true);

    expect(skip).toBe(true);
  });

  it("falls through when a stat mtime moved since the baseline", async () => {
    vi.mocked(stat).mockResolvedValue(makeStatResult(1_000));
    const precheck = new StatPrecheck(makeHost());
    await precheck.recordFullPass("/repo/.git", "main");

    vi.mocked(stat).mockResolvedValue(makeStatResult(2_000));
    const skip = await precheck.shouldSkip("/repo/.git", "main", 0, true);

    expect(skip).toBe(false);
  });

  it("falls through when a watcher event fired after the baseline was captured", async () => {
    vi.mocked(stat).mockResolvedValue(makeStatResult(1_000));
    const precheck = new StatPrecheck(makeHost());
    await precheck.recordFullPass("/repo/.git", "main");

    const afterBaseline = precheck.baselineCapturedAt + 1;
    const skip = await precheck.shouldSkip("/repo/.git", "main", afterBaseline, true);

    expect(skip).toBe(false);
  });

  it("is not trustworthy outside recursive coverage once the full-status budget expires", async () => {
    vi.mocked(stat).mockResolvedValue(makeStatResult(1_000));
    const precheck = new StatPrecheck(makeHost());
    await precheck.recordFullPass("/repo/.git", "main");

    // Within budget the skip still applies without recursive coverage.
    expect(await precheck.shouldSkip("/repo/.git", "main", 0, false)).toBe(true);

    precheck.fullStatusCapturedAt = Date.now() - 120_001;
    expect(await precheck.shouldSkip("/repo/.git", "main", 0, false)).toBe(false);
  });

  it("stays trustworthy under recursive coverage even once the full-status budget expires", async () => {
    vi.mocked(stat).mockResolvedValue(makeStatResult(1_000));
    const precheck = new StatPrecheck(makeHost());
    await precheck.recordFullPass("/repo/.git", "main");

    precheck.fullStatusCapturedAt = Date.now() - 120_001;
    expect(await precheck.shouldSkip("/repo/.git", "main", 0, true)).toBe(true);
  });

  it("drops the baseline on request so the next check falls through", async () => {
    vi.mocked(stat).mockResolvedValue(makeStatResult(1_000));
    const precheck = new StatPrecheck(makeHost());
    await precheck.recordFullPass("/repo/.git", "main");
    expect(await precheck.shouldSkip("/repo/.git", "main", 0, true)).toBe(true);

    precheck.dropBaseline();
    expect(await precheck.shouldSkip("/repo/.git", "main", 0, true)).toBe(false);
  });

  it("caches a resolved commondir for the instance lifetime", async () => {
    vi.mocked(readFile).mockResolvedValueOnce("/repo/.git\n" as unknown as string);
    const precheck = new StatPrecheck(makeHost());

    const first = await precheck.resolveCommonDirAsync("/repo/.git/worktrees/x");
    const second = await precheck.resolveCommonDirAsync("/repo/.git/worktrees/x");

    expect(first).toBe("/repo/.git");
    expect(second).toBe("/repo/.git");
    expect(vi.mocked(readFile)).toHaveBeenCalledTimes(1);
  });

  it("falls back to gitDir when the commondir file is missing", async () => {
    const precheck = new StatPrecheck(makeHost());
    const result = await precheck.resolveCommonDirAsync("/repo/.git/worktrees/x");
    expect(result).toBe("/repo/.git/worktrees/x");
  });

  it("returns the absent sentinel for ENOENT and propagates other stat errors", async () => {
    vi.mocked(stat).mockResolvedValueOnce(makeStatResult(1_000));
    const precheck = new StatPrecheck(makeHost());
    expect(await precheck.statMtime("/repo/.git/index")).toBe(1_000);

    vi.mocked(stat).mockRejectedValueOnce(Object.assign(new Error("ENOENT"), { code: "ENOENT" }));
    expect(await precheck.statMtime("/repo/.git/packed-refs")).toBe(-1);

    vi.mocked(stat).mockRejectedValueOnce(Object.assign(new Error("EACCES"), { code: "EACCES" }));
    await expect(precheck.statMtime("/repo/.git/HEAD")).rejects.toThrow("EACCES");
  });
});
