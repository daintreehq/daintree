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

interface RepoFixture {
  /** `git remote` output. */
  remotes?: string[];
  /** Full refs keyed by the revision passed to `rev-parse --symbolic-full-name`. */
  symbolicRefs?: Record<string, string>;
  /** Full refs `for-each-ref` reports for the base-branch glob. */
  remoteBaseRefs?: string[];
  /** rev-list output keyed by the `<ref>...HEAD` range; absent ranges throw. */
  revList?: Record<string, string>;
  /** Output of the two-rev `rev-parse` that drives matchesUpstream. */
  revParsePair?: string;
}

/**
 * Route git invocations to a declarative repo fixture, so a test states the
 * repository's shape rather than an ordered list of mock return values — the
 * resolution step's call count varies with that shape.
 */
function installRepo(fixture: RepoFixture): void {
  const {
    remotes = ["origin"],
    symbolicRefs = {},
    remoteBaseRefs = [],
    revList = {},
    revParsePair,
  } = fixture;

  mockGitRaw.mockImplementation(async (args: string[]) => {
    if (args[0] === "remote") return `${remotes.join("\n")}\n`;
    if (args[0] === "for-each-ref") return `${remoteBaseRefs.join("\n")}\n`;
    if (args[0] === "rev-parse" && args[1] === "--symbolic-full-name") {
      const resolved = symbolicRefs[args[2]!];
      if (!resolved) throw new Error(`no upstream configured for ${args[2]}`);
      return `${resolved}\n`;
    }
    if (args[0] === "rev-parse") {
      if (revParsePair === undefined) throw new Error("unknown revision");
      return revParsePair;
    }
    if (args[0] === "rev-list") {
      const range = args[3]!;
      const out = revList[range];
      if (out === undefined) throw new Error(`unknown revision: ${range}`);
      return out;
    }
    throw new Error(`unexpected git invocation: ${args.join(" ")}`);
  });
}

/** The `rev-list` ranges a run actually asked for, in order. */
function revListRanges(): string[] {
  return mockGitRaw.mock.calls
    .map((call) => call[0] as string[])
    .filter((args) => args[0] === "rev-list")
    .map((args) => args[3] as string);
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
    installRepo({});
    const divergence = new BaseDivergence(makeHost({ isMainWorktree: true }), makeStatPrecheck());
    expect(await divergence.compute(false)).toBeNull();
  });

  it("returns null when there is no branch", async () => {
    installRepo({});
    const divergence = new BaseDivergence(makeHost({ branch: undefined }), makeStatPrecheck());
    expect(await divergence.compute(false)).toBeNull();
  });

  it("prefers the linked PR's base branch over mainBranch", async () => {
    installRepo({
      remoteBaseRefs: ["refs/remotes/origin/release"],
      revList: { "origin/release...HEAD": "2\t3\n" },
    });
    const divergence = new BaseDivergence(
      makeHost({ linkedPrBaseRef: " release " }),
      makeStatPrecheck()
    );

    const result = await divergence.compute(false);

    expect(result?.baseBranchName).toBe("release");
    expect(revListRanges()).toContain("origin/release...HEAD");
  });

  it("falls back to mainBranch when there is no linked PR base ref", async () => {
    installRepo({
      remoteBaseRefs: ["refs/remotes/origin/main"],
      revList: { "origin/main...HEAD": "0\t0\n" },
    });
    const divergence = new BaseDivergence(makeHost(), makeStatPrecheck());

    expect((await divergence.compute(false))?.baseBranchName).toBe("main");
  });

  it("parses ahead/behind counts from the rev-list output", async () => {
    installRepo({
      remoteBaseRefs: ["refs/remotes/origin/main"],
      revList: { "origin/main...HEAD": "4\t7\n" },
    });
    const divergence = new BaseDivergence(makeHost(), makeStatPrecheck());

    const result = await divergence.compute(false);

    expect(result?.behindCount).toBe(4);
    expect(result?.aheadCount).toBe(7);
  });

  it("falls back to the local base ref when the remote ref rev-list fails", async () => {
    installRepo({ revList: { "main...HEAD": "1\t2\n" } });
    const divergence = new BaseDivergence(makeHost(), makeStatPrecheck());

    const result = await divergence.compute(false);

    expect(result?.behindCount).toBe(1);
    expect(revListRanges().at(-1)).toBe("main...HEAD");
    // The local fallback measured against a plain branch, not a remote one.
    expect(result?.baseCompareRef).toBe("main");
    expect(result?.baseRemote).toBeNull();
  });

  it("returns null when both the remote and local rev-list fail", async () => {
    installRepo({});
    const divergence = new BaseDivergence(makeHost(), makeStatPrecheck());

    expect(await divergence.compute(false)).toBeNull();
  });

  it("sets matchesUpstream true only when @{u} and the base ref resolve to the same commit", async () => {
    installRepo({
      remoteBaseRefs: ["refs/remotes/origin/main"],
      revList: { "origin/main...HEAD": "0\t0\n" },
      symbolicRefs: { "@{u}": "refs/remotes/origin/feature/x" },
      revParsePair: "abc123\nabc123\n",
    });
    const divergence = new BaseDivergence(makeHost(), makeStatPrecheck());

    expect((await divergence.compute(true))?.matchesUpstream).toBe(true);
  });

  it("sets matchesUpstream false when @{u} and the base ref diverge", async () => {
    installRepo({
      remoteBaseRefs: ["refs/remotes/origin/main"],
      revList: { "origin/main...HEAD": "0\t0\n" },
      symbolicRefs: { "@{u}": "refs/remotes/origin/feature/x" },
      revParsePair: "abc123\ndef456\n",
    });
    const divergence = new BaseDivergence(makeHost(), makeStatPrecheck());

    expect((await divergence.compute(true))?.matchesUpstream).toBe(false);
  });

  it("reuses the cached result when the stat-derived key is unchanged", async () => {
    installRepo({
      remoteBaseRefs: ["refs/remotes/origin/main"],
      revList: { "origin/main...HEAD": "0\t0\n" },
    });
    const divergence = new BaseDivergence(makeHost(), makeStatPrecheck());

    await divergence.compute(false);
    const spawnsAfterFirst = mockGitRaw.mock.calls.length;
    await divergence.compute(false);

    // The second pass must be entirely spawn-free — that fast path is what
    // keeps the worktree dashboard's poll loop cheap.
    expect(mockGitRaw.mock.calls.length).toBe(spawnsAfterFirst);
  });

  it("recomputes when a ref's stat mtime changes", async () => {
    installRepo({
      remoteBaseRefs: ["refs/remotes/origin/main"],
      revList: { "origin/main...HEAD": "0\t0\n" },
    });
    const statPrecheck = makeStatPrecheck();
    const divergence = new BaseDivergence(makeHost(), statPrecheck);

    await divergence.compute(false);
    vi.mocked(statPrecheck.statMtime).mockResolvedValue(2_000);
    mockGitRaw.mockImplementation(async (args: string[]) => {
      if (args[0] === "remote") return "origin\n";
      if (args[0] === "for-each-ref") return "refs/remotes/origin/main\n";
      if (args[0] === "rev-parse") throw new Error("no upstream");
      if (args[0] === "rev-list") return "1\t1\n";
      throw new Error("unexpected");
    });
    const second = await divergence.compute(false);

    expect(second?.behindCount).toBe(1);
  });

  describe("remote resolution", () => {
    it("compares against upstream when the fork layout leaves it ambiguous", async () => {
      // origin is the fork and carries a stale base; upstream is canonical.
      installRepo({
        remotes: ["origin", "upstream"],
        remoteBaseRefs: ["refs/remotes/origin/main", "refs/remotes/upstream/main"],
        revList: { "upstream/main...HEAD": "200\t3\n", "origin/main...HEAD": "0\t3\n" },
      });
      const divergence = new BaseDivergence(makeHost(), makeStatPrecheck());

      const result = await divergence.compute(false);

      expect(result?.baseCompareRef).toBe("upstream/main");
      expect(result?.baseRemote).toBe("upstream");
      expect(result?.behindCount).toBe(200);
    });

    it("honours the base branch's tracking config over the name heuristic", async () => {
      installRepo({
        remotes: ["origin", "upstream"],
        symbolicRefs: { "main@{upstream}": "refs/remotes/origin/main" },
        remoteBaseRefs: ["refs/remotes/origin/main", "refs/remotes/upstream/main"],
        revList: { "origin/main...HEAD": "5\t1\n" },
      });
      const divergence = new BaseDivergence(makeHost(), makeStatPrecheck());

      const result = await divergence.compute(false);

      expect(result?.baseCompareRef).toBe("origin/main");
      expect(result?.baseRemote).toBe("origin");
    });

    it("keeps single-remote repos on origin", async () => {
      installRepo({
        remoteBaseRefs: ["refs/remotes/origin/main"],
        revList: { "origin/main...HEAD": "1\t1\n" },
      });
      const divergence = new BaseDivergence(makeHost(), makeStatPrecheck());

      const result = await divergence.compute(false);

      expect(result?.baseCompareRef).toBe("origin/main");
      expect(divergence.baseRemote).toBe("origin");
    });

    it("re-resolves when the base branch changes, rather than reusing the prior base's remote", async () => {
      installRepo({
        remotes: ["origin", "upstream"],
        remoteBaseRefs: ["refs/remotes/upstream/main"],
        revList: { "upstream/main...HEAD": "1\t1\n", "origin/release...HEAD": "2\t2\n" },
      });
      const linked: { baseRef: string | undefined } = { baseRef: undefined };
      const host = makeHost();
      Object.defineProperty(host, "linkedPrBaseRef", {
        get: () => linked.baseRef,
      });
      const divergence = new BaseDivergence(host, makeStatPrecheck());

      expect((await divergence.compute(false))?.baseCompareRef).toBe("upstream/main");

      // A PR relink changes the base branch without touching any file on disk,
      // so the resolution cache has to key on it directly.
      linked.baseRef = "release";
      mockGitRaw.mockImplementation(async (args: string[]) => {
        if (args[0] === "remote") return "origin\nupstream\n";
        if (args[0] === "for-each-ref") return "refs/remotes/origin/release\n";
        if (args[0] === "rev-parse") throw new Error("no upstream");
        if (args[0] === "rev-list") {
          if (args[3] === "origin/release...HEAD") return "2\t2\n";
          throw new Error(`unknown revision: ${args[3]}`);
        }
        throw new Error("unexpected");
      });

      const second = await divergence.compute(false);
      expect(second?.baseBranchName).toBe("release");
      expect(second?.baseCompareRef).toBe("origin/release");
    });

    it("resolves a slash-bearing base branch without splitting it", async () => {
      installRepo({
        remotes: ["origin", "upstream"],
        remoteBaseRefs: ["refs/remotes/upstream/release/2.0"],
        revList: { "upstream/release/2.0...HEAD": "3\t0\n" },
      });
      const divergence = new BaseDivergence(
        makeHost({ linkedPrBaseRef: "release/2.0" }),
        makeStatPrecheck()
      );

      expect((await divergence.compute(false))?.baseCompareRef).toBe("upstream/release/2.0");
    });

    it("resolves through the WSL git path too", async () => {
      installRepo({
        remotes: ["origin", "upstream"],
        remoteBaseRefs: ["refs/remotes/origin/main", "refs/remotes/upstream/main"],
        revList: { "upstream/main...HEAD": "9\t0\n" },
      });
      const divergence = new BaseDivergence(
        makeHost({ wslInvocation: { distro: "Ubuntu", path: "/mnt/c/repo" } as never }),
        makeStatPrecheck()
      );

      const result = await divergence.compute(false);

      expect(result?.baseCompareRef).toBe("upstream/main");
      expect(mockCreateWslHardenedGit).toHaveBeenCalled();
      expect(mockCreateHardenedGit).not.toHaveBeenCalled();
    });

    it("keeps today's origin fallback when the remote table can't be read", async () => {
      mockGitRaw.mockImplementation(async (args: string[]) => {
        if (args[0] === "rev-list" && args[3] === "origin/main...HEAD") return "1\t1\n";
        throw new Error("git unavailable");
      });
      const divergence = new BaseDivergence(makeHost(), makeStatPrecheck());

      const result = await divergence.compute(false);

      expect(result?.behindCount).toBe(1);
      expect(result?.baseCompareRef).toBe("origin/main");
    });
  });
});
