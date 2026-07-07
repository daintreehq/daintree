import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, renameSync, rmSync, writeFileSync } from "fs";
import { promises as fs } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const mockGit = {
  raw: vi.fn(),
  status: vi.fn(),
  diff: vi.fn(),
  revparse: vi.fn(),
};

vi.mock("../hardenedGit.js", () => ({
  createHardenedGit: vi.fn(() => mockGit),
}));

vi.mock("../logger.js", () => ({
  logWarn: vi.fn(),
  logError: vi.fn(),
}));

import {
  getWorktreeChangesWithStats,
  __clearWorktreeStaticCacheForTesting,
  __clearLastCommitLogCacheForTesting,
  __clearPerFileDiffStatCacheForTesting,
} from "../git.js";
import { clearGitDirCache, clearGitCommonDirCache } from "../gitUtils.js";

const OID_A = "a".repeat(40);
const OID_B = "b".repeat(40);

function cleanStatus() {
  return {
    modified: [],
    created: [],
    deleted: [],
    renamed: [],
    staged: [],
    conflicted: [],
    not_added: [],
    tracking: null,
    ahead: 0,
    behind: 0,
  };
}

/** Build a main-repo shaped .git (directory) with HEAD on refs/heads/main. */
function makeMainRepo(root: string, oid: string): void {
  const gitDir = join(root, ".git");
  mkdirSync(join(gitDir, "refs", "heads"), { recursive: true });
  writeFileSync(join(gitDir, "HEAD"), "ref: refs/heads/main\n");
  writeFileSync(join(gitDir, "refs", "heads", "main"), `${oid}\n`);
}

function revParseCalls(): unknown[][] {
  return mockGit.raw.mock.calls.filter(
    (call) => Array.isArray(call[0]) && call[0][0] === "rev-parse"
  );
}

describe("HEAD OID filesystem fast path", () => {
  let root: string;

  beforeEach(() => {
    vi.clearAllMocks();
    __clearWorktreeStaticCacheForTesting();
    __clearLastCommitLogCacheForTesting();
    __clearPerFileDiffStatCacheForTesting();
    clearGitDirCache();
    clearGitCommonDirCache();
    root = mkdtempSync(join(tmpdir(), "daintree-oid-fastpath-"));

    mockGit.status.mockResolvedValue(cleanStatus());
    mockGit.raw.mockImplementation(async (args: string[]) => {
      if (args[0] === "rev-parse") return `${OID_A}\n${root}`;
      if (args[0] === "log") return "1700000000\tperf\tperf@example.invalid\tsubject";
      return "";
    });
    mockGit.diff.mockResolvedValue("");
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("skips the rev-parse spawn once static info is cached and HEAD resolves from a loose ref", async () => {
    makeMainRepo(root, OID_A);

    const first = await getWorktreeChangesWithStats(root, true);
    expect(revParseCalls()).toHaveLength(1);
    expect(first.worktreeId).toBe(await fs.realpath(root));

    const second = await getWorktreeChangesWithStats(root, true);
    expect(revParseCalls()).toHaveLength(1);
    expect(second.worktreeId).toBe(first.worktreeId);
    expect(second.rootPath).toBe(first.rootPath);
  });

  it("observes a HEAD move through the fast path (log cache re-keys on the new OID)", async () => {
    makeMainRepo(root, OID_A);
    await getWorktreeChangesWithStats(root, true);
    const logCallsAfterFirst = mockGit.raw.mock.calls.filter((c) => c[0][0] === "log").length;

    writeFileSync(join(root, ".git", "refs", "heads", "main"), `${OID_B}\n`);
    await getWorktreeChangesWithStats(root, true);

    // No second rev-parse, but the new OID misses the log cache → a fresh log spawn.
    expect(revParseCalls()).toHaveLength(1);
    const logCallsAfterSecond = mockGit.raw.mock.calls.filter((c) => c[0][0] === "log").length;
    expect(logCallsAfterSecond).toBe(logCallsAfterFirst + 1);
  });

  it("resolves a detached HEAD directly from the HEAD file", async () => {
    const gitDir = join(root, ".git");
    mkdirSync(join(gitDir, "refs", "heads"), { recursive: true });
    writeFileSync(join(gitDir, "HEAD"), `${OID_A}\n`);

    await getWorktreeChangesWithStats(root, true);
    await getWorktreeChangesWithStats(root, true);
    expect(revParseCalls()).toHaveLength(1);
  });

  it("falls back to packed-refs when the loose ref is absent", async () => {
    const gitDir = join(root, ".git");
    mkdirSync(join(gitDir, "refs", "heads"), { recursive: true });
    writeFileSync(join(gitDir, "HEAD"), "ref: refs/heads/main\n");
    writeFileSync(
      join(gitDir, "packed-refs"),
      `# pack-refs with: peeled fully-peeled sorted\n${OID_A} refs/heads/main\n^${OID_B}\n`
    );

    await getWorktreeChangesWithStats(root, true);
    await getWorktreeChangesWithStats(root, true);
    expect(revParseCalls()).toHaveLength(1);
  });

  it("rejects a malformed HEAD refname instead of resolving it as a path", async () => {
    const gitDir = join(root, ".git");
    mkdirSync(join(gitDir, "refs", "heads"), { recursive: true });
    // Path traversal that escapes refs/heads/ — rev-parse would reject the
    // refname, so the fast path must fall back, not read .git/ORIG_HEAD.
    writeFileSync(join(gitDir, "HEAD"), "ref: refs/heads/../../ORIG_HEAD\n");
    writeFileSync(join(gitDir, "ORIG_HEAD"), `${OID_B}\n`);

    await getWorktreeChangesWithStats(root, true);
    await getWorktreeChangesWithStats(root, true);
    expect(revParseCalls()).toHaveLength(2);
  });

  it("keeps spawning rev-parse when HEAD points at a ref that exists nowhere (unborn branch)", async () => {
    const gitDir = join(root, ".git");
    mkdirSync(join(gitDir, "refs", "heads"), { recursive: true });
    writeFileSync(join(gitDir, "HEAD"), "ref: refs/heads/ghost\n");

    await getWorktreeChangesWithStats(root, true);
    await getWorktreeChangesWithStats(root, true);
    expect(revParseCalls()).toHaveLength(2);
  });

  it("resolves through a linked worktree's gitdir pointer and commondir", async () => {
    // Main repo holds the shared refs; the linked worktree's .git is a file
    // pointing into .git/worktrees/wt1, whose commondir points back up.
    const mainRoot = join(root, "main");
    mkdirSync(mainRoot, { recursive: true });
    makeMainRepo(mainRoot, OID_A);
    const wtGitDir = join(mainRoot, ".git", "worktrees", "wt1");
    mkdirSync(wtGitDir, { recursive: true });
    writeFileSync(join(wtGitDir, "HEAD"), "ref: refs/heads/main\n");
    writeFileSync(join(wtGitDir, "commondir"), "../..\n");
    const wtRoot = join(root, "wt1");
    mkdirSync(wtRoot, { recursive: true });
    writeFileSync(join(wtRoot, ".git"), `gitdir: ${wtGitDir}\n`);

    mockGit.raw.mockImplementation(async (args: string[]) => {
      if (args[0] === "rev-parse") return `${OID_A}\n${wtRoot}`;
      if (args[0] === "log") return "1700000000\tperf\tperf@example.invalid\tsubject";
      return "";
    });

    await getWorktreeChangesWithStats(wtRoot, true);
    await getWorktreeChangesWithStats(wtRoot, true);
    expect(revParseCalls()).toHaveLength(1);
  });

  it("re-resolves static info after the worktree directory is replaced (new inode)", async () => {
    makeMainRepo(root, OID_A);
    await getWorktreeChangesWithStats(root, true);
    expect(revParseCalls()).toHaveLength(1);

    // Replace the directory at the same path — new inode invalidates the
    // cached static info, so the next pass must re-spawn rev-parse. The
    // replacement is created WHILE the original still exists (two live
    // directories can never share an inode) and then renamed into place;
    // rm-then-mkdir would let ext4 reuse the freed inode and flake (the
    // cache would still validate and skip the second rev-parse).
    const replacement = `${root}-replacement`;
    mkdirSync(replacement, { recursive: true });
    makeMainRepo(replacement, OID_A);
    rmSync(root, { recursive: true, force: true });
    renameSync(replacement, root);
    clearGitDirCache(root);

    await getWorktreeChangesWithStats(root, true);
    expect(revParseCalls()).toHaveLength(2);
  });
});
