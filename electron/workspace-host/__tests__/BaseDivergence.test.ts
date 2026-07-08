import { describe, it, expect, vi, beforeEach } from "vitest";

const mockGitRaw = vi.fn();
const { mockCreateHardenedGit, mockCreateWslHardenedGit } = vi.hoisted(() => ({
  mockCreateHardenedGit: vi.fn(),
  mockCreateWslHardenedGit: vi.fn(),
}));

vi.mock("../../utils/hardenedGit.js", () => ({
  createHardenedGit: mockCreateHardenedGit,
  createWslHardenedGit: mockCreateWslHardenedGit,
}));

const mockGetGitDir = vi.fn();
vi.mock("../../utils/gitUtils.js", () => ({
  getGitDir: (...args: unknown[]) => mockGetGitDir(...args),
}));

import { BaseDivergence, type BaseDivergenceHost } from "../BaseDivergence.js";
import type { StatPrecheck } from "../StatPrecheck.js";

function makeHost(overrides: Partial<BaseDivergenceHost> = {}): BaseDivergenceHost {
  return {
    branch: "feature/x",
    isMainWorktree: false,
    mainBranch: "main",
    linkedPrBaseRef: undefined,
    path: "/test/worktree",
    wslInvocation: undefined,
    abortSignal: new AbortController().signal,
    ...overrides,
  };
}

function makeStatPrecheck(): StatPrecheck {
  return {
    resolveCommonDirAsync: vi.fn().mockResolvedValue("/test/worktree/.git"),
    statMtime: vi.fn().mockResolvedValue(1_000),
  } as unknown as StatPrecheck;
}

describe("BaseDivergence", () => {
  beforeEach(() => {
    mockGitRaw.mockReset();
    mockCreateHardenedGit.mockReset().mockImplementation(() => ({
      raw: (...args: unknown[]) => mockGitRaw(...args),
    }));
    mockCreateWslHardenedGit.mockReset().mockImplementation(() => ({
      raw: (...args: unknown[]) => mockGitRaw(...args),
    }));
    mockGetGitDir.mockReset().mockResolvedValue("/test/worktree/.git");
  });

  it("returns null for the main worktree", async () => {
    const divergence = new BaseDivergence(makeHost({ isMainWorktree: true }), makeStatPrecheck());
    expect(await divergence.compute(false)).toBeNull();
  });

  it("returns null when there is no branch", async () => {
    const divergence = new BaseDivergence(makeHost({ branch: undefined }), makeStatPrecheck());
    expect(await divergence.compute(false)).toBeNull();
  });

  it("prefers the linked PR's base branch over mainBranch", async () => {
    mockGitRaw.mockResolvedValueOnce("2\t3\n");
    const divergence = new BaseDivergence(
      makeHost({ linkedPrBaseRef: " release " }),
      makeStatPrecheck()
    );

    const result = await divergence.compute(false);

    expect(result?.baseBranchName).toBe("release");
    expect(mockGitRaw).toHaveBeenCalledWith([
      "rev-list",
      "--count",
      "--left-right",
      "origin/release...HEAD",
    ]);
  });

  it("falls back to mainBranch when there is no linked PR base ref", async () => {
    mockGitRaw.mockResolvedValueOnce("0\t0\n");
    const divergence = new BaseDivergence(makeHost(), makeStatPrecheck());

    const result = await divergence.compute(false);

    expect(result?.baseBranchName).toBe("main");
  });

  it("parses ahead/behind counts from the rev-list output", async () => {
    mockGitRaw.mockResolvedValueOnce("4\t7\n");
    const divergence = new BaseDivergence(makeHost(), makeStatPrecheck());

    const result = await divergence.compute(false);

    expect(result?.behindCount).toBe(4);
    expect(result?.aheadCount).toBe(7);
  });

  it("falls back to the local base ref when the remote ref rev-list fails", async () => {
    mockGitRaw.mockRejectedValueOnce(new Error("unknown revision: origin/main")).mockResolvedValueOnce(
      "1\t2\n"
    );
    const divergence = new BaseDivergence(makeHost(), makeStatPrecheck());

    const result = await divergence.compute(false);

    expect(result?.behindCount).toBe(1);
    expect(mockGitRaw).toHaveBeenNthCalledWith(2, [
      "rev-list",
      "--count",
      "--left-right",
      "main...HEAD",
    ]);
  });

  it("returns null when both the remote and local rev-list fail", async () => {
    mockGitRaw.mockRejectedValue(new Error("no such ref"));
    const divergence = new BaseDivergence(makeHost(), makeStatPrecheck());

    expect(await divergence.compute(false)).toBeNull();
  });

  it("sets matchesUpstream true only when @{u} and the base ref resolve to the same commit", async () => {
    mockGitRaw
      .mockResolvedValueOnce("0\t0\n")
      .mockResolvedValueOnce("abc123\nabc123\n");
    const divergence = new BaseDivergence(makeHost(), makeStatPrecheck());

    const result = await divergence.compute(true);

    expect(result?.matchesUpstream).toBe(true);
  });

  it("sets matchesUpstream false when @{u} and the base ref diverge", async () => {
    mockGitRaw
      .mockResolvedValueOnce("0\t0\n")
      .mockResolvedValueOnce("abc123\ndef456\n");
    const divergence = new BaseDivergence(makeHost(), makeStatPrecheck());

    const result = await divergence.compute(true);

    expect(result?.matchesUpstream).toBe(false);
  });

  it("reuses the cached result when the stat-derived key is unchanged", async () => {
    mockGitRaw.mockResolvedValueOnce("0\t0\n");
    const statPrecheck = makeStatPrecheck();
    const divergence = new BaseDivergence(makeHost(), statPrecheck);

    await divergence.compute(false);
    await divergence.compute(false);

    // Only the first compute() should have spawned a git process; the second
    // reused the cached result via the unchanged stat key.
    expect(mockGitRaw).toHaveBeenCalledTimes(1);
  });

  it("recomputes when a ref's stat mtime changes", async () => {
    mockGitRaw.mockResolvedValueOnce("0\t0\n").mockResolvedValueOnce("1\t1\n");
    const statPrecheck = makeStatPrecheck();
    const divergence = new BaseDivergence(makeHost(), statPrecheck);

    await divergence.compute(false);
    vi.mocked(statPrecheck.statMtime).mockResolvedValue(2_000);
    const second = await divergence.compute(false);

    expect(mockGitRaw).toHaveBeenCalledTimes(2);
    expect(second?.behindCount).toBe(1);
  });
});
