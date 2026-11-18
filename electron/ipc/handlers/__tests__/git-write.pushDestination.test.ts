import { describe, it, expect, vi, beforeEach } from "vitest";

const ipcMainMock = vi.hoisted(() => ({
  handle: vi.fn(),
  removeHandler: vi.fn(),
}));

// `git:push` registers via `typedHandleWithContext`, so `buildIpcContext` runs
// and reaches BrowserWindow through the webContents registry — a bare `ipcMain`
// mock leaves it undefined and every context-taking handler throws.
vi.mock("electron", () => ({
  ipcMain: ipcMainMock,
  BrowserWindow: {
    fromWebContents: vi.fn(() => null),
    getAllWindows: vi.fn(() => []),
  },
  webContents: { fromId: vi.fn(() => null) },
}));

vi.mock("../../../store.js", () => ({
  store: { get: vi.fn().mockReturnValue({ uiFeedbackSoundEnabled: false }) },
}));

vi.mock("../../../services/SoundService.js", () => ({
  soundService: { play: vi.fn() },
}));

vi.mock("../../../services/getSoundService.js", () => ({
  getSoundService: vi.fn().mockResolvedValue({ play: vi.fn() }),
}));

const createHardenedGitMock = vi.hoisted(() => vi.fn());
const createAuthenticatedGitMock = vi.hoisted(() => vi.fn());
const createStrictExitGitMock = vi.hoisted(() => vi.fn());

vi.mock("../../../utils/hardenedGit.js", () => ({
  validateCwd: vi.fn(),
  createHardenedGit: createHardenedGitMock,
  createAuthenticatedGit: createAuthenticatedGitMock,
  createContinueGit: vi.fn(),
  createStrictExitGit: createStrictExitGitMock,
}));

// Staged blob content by object id, as `cat-file` would answer for it.
const blobStore = vi.hoisted(() => new Map<string, string>());

vi.mock("../../../services/git/catFileBatch.js", () => ({
  readBlobSizes: vi.fn(async (_cwd: string, oids: Iterable<string>) => {
    const sizes = new Map<string, number>();
    for (const oid of oids) {
      const content = blobStore.get(oid);
      if (content === undefined) throw new Error(`fatal: bad object ${oid}`);
      sizes.set(oid, Buffer.byteLength(content, "utf8"));
    }
    return sizes;
  }),
  readBlobs: vi.fn(
    async (_cwd: string, sizes: ReadonlyMap<string, number>) =>
      new Map([...sizes.keys()].map((oid) => [oid, Buffer.from(blobStore.get(oid)!, "utf8")]))
  ),
}));

import { createHash } from "node:crypto";
import { registerGitWriteHandlers } from "../git-write.js";
import { _resetRateLimitQueuesForTest } from "../../utils.js";
import { CHANNELS } from "../../channels.js";
import type { StagingStatus } from "../../../../shared/types/git.js";
import {
  OperationRegistry,
  _resetOperationRegistryForTest,
} from "../../../services/operations/index.js";
import type { OperationsEvent } from "../../../../shared/types/ipc/operations.js";
import { scanStagedFilesForConflictMarkers } from "../../../services/git/conflictMarkerScan.js";
import { readBlobs, readBlobSizes } from "../../../services/git/catFileBatch.js";

const CWD = "/repo";
const LOCAL_BRANCH = "topic";
const LEASE = "deadbeef";

/**
 * The complex destination from the #11746 permutation table: a remote whose own
 * name carries a slash, and a remote-side branch that differs from the local
 * name. Every argv assertion below uses it so a regression that silently falls
 * back to `origin`, or that reuses the local branch name on the remote side,
 * fails loudly rather than passing by coincidence.
 */
const REMOTE = "team/fork";
const REMOTE_BRANCH = "release/topic";
const PUSH_REF = `refs/remotes/${REMOTE}/${REMOTE_BRANCH}`;

type FakeGit = Record<string, ReturnType<typeof vi.fn>>;

/** A git double whose `for-each-ref` reports the given push destination. */
/** Upstream is a DIFFERENT remote from the push target, so pull-rebase
 *  reading the push destination instead of the upstream would show up as a
 *  failed assertion rather than passing by coincidence. */
const UPSTREAM_REMOTE = "origin";
const UPSTREAM_BRANCH = "release/topic";
const UPSTREAM_REF = `refs/remotes/${UPSTREAM_REMOTE}/${UPSTREAM_BRANCH}`;

const FOR_EACH_REF = `refs/heads/${LOCAL_BRANCH}\u0000${REMOTE}\u0000${PUSH_REF}`;

/**
 * The single-branch push argv every push path ends with (#15556): no tags or
 * submodule pushes ride along, and both sides of the refspec are fully
 * qualified so neither can resolve to a tag.
 */
function singleBranchArgs(remote: string, localBranch: string, remoteBranch: string): string[] {
  return [
    "--no-follow-tags",
    "--recurse-submodules=no",
    remote,
    `refs/heads/${localBranch}:refs/heads/${remoteBranch}`,
  ];
}
const FOR_EACH_REF_UPSTREAM = `refs/heads/${LOCAL_BRANCH}\u0000${UPSTREAM_REMOTE}\u0000${UPSTREAM_REF}`;

/**
 * The shared `git.raw` behaviour, callable on its own so a double that
 * intercepts part of the argv can delegate the rest here rather than restating
 * the ref-resolution config a second time.
 */
function rawResponder(forEachRef: string, forEachRefUpstream: string) {
  return async (args: string[]): Promise<string> => {
    if (args[0] === "for-each-ref") {
      // Discriminate on `push:remotename`, the field only the push resolver
      // asks for. Testing for "upstream" alone misreads the push resolver the
      // moment its format mentions `%(upstream)` at all — which it does, to
      // tell a differently-named upstream from no upstream.
      const format = args[1] ?? "";
      return `${format.includes("push:remotename") ? forEachRef : forEachRefUpstream}\n`;
    }
    if (args[0] === "rev-list") return "7\n";
    // The pull reads its branch through `symbolic-ref` (#17188); the push
    // still reads it through `rev-parse --abbrev-ref` on `revparse` below.
    if (args[0] === "symbolic-ref") return `refs/heads/${LOCAL_BRANCH}\n`;
    return "";
  };
}

function makeGit(
  overrides: FakeGit = {},
  forEachRef = FOR_EACH_REF,
  forEachRefUpstream = FOR_EACH_REF_UPSTREAM
): FakeGit {
  return {
    revparse: vi.fn(async (args: string[]) => {
      if (args[0] === "--abbrev-ref" && args[1] === "HEAD") return `${LOCAL_BRANCH}\n`;
      return "aaaaaaaabbbbbbbbccccccccdddddddd\n";
    }),
    raw: vi.fn(rawResponder(forEachRef, forEachRefUpstream)),
    getRemotes: vi.fn(async () => [
      { name: "origin", refs: { fetch: "", push: "" } },
      { name: REMOTE, refs: { fetch: "", push: "" } },
    ]),
    push: vi.fn(async () => undefined),
    pull: vi.fn(async () => undefined),
    log: vi.fn(async () => ({ all: [] })),
    ...overrides,
  };
}

function getHandler(channel: string) {
  const call = ipcMainMock.handle.mock.calls.find((c: unknown[]) => c[0] === channel);
  if (!call) throw new Error(`Handler for ${channel} not registered`);
  return call[1] as (_e: unknown, ...args: unknown[]) => Promise<unknown>;
}

/** The push handler takes an IpcContext, so it needs a sender-shaped first arg. */
const FAKE_EVENT = { sender: { id: 1 } };

beforeEach(() => {
  vi.clearAllMocks();
  _resetRateLimitQueuesForTest();
  registerGitWriteHandlers({} as never);
});

describe("git push — resolved destination", () => {
  it("sets upstream to the resolved remote with an explicit local:remote refspec", async () => {
    const git = makeGit();
    createAuthenticatedGitMock.mockResolvedValue(git);

    await getHandler("git:push")(FAKE_EVENT, { cwd: CWD, setUpstream: true });

    expect(git.push).toHaveBeenCalledTimes(1);
    expect(git.push).toHaveBeenCalledWith([
      "--set-upstream",
      ...singleBranchArgs(REMOTE, LOCAL_BRANCH, REMOTE_BRANCH),
    ]);
    expect(git.push).not.toHaveBeenCalledWith(
      expect.arrayContaining(["origin"]) as unknown as string[]
    );
  });

  it("pushes only the branch, to the resolved destination, never as a bare push", async () => {
    // A bare `git push` sends whatever push.default, remote.<name>.push or a
    // mirror remote say — more than the one branch the confirm showed.
    const git = makeGit();
    createAuthenticatedGitMock.mockResolvedValue(git);

    await getHandler("git:push")(FAKE_EVENT, { cwd: CWD });

    expect(git.push).toHaveBeenCalledTimes(1);
    expect(git.push).toHaveBeenCalledWith(singleBranchArgs(REMOTE, LOCAL_BRANCH, REMOTE_BRANCH));
  });

  it("establishes tracking in the same push when the branch has no configuration", async () => {
    // The fresh-worktree-branch state: git names no push remote and the
    // branch tracks nothing, so the sole remote is the destination. An
    // explicit push never fails for want of an upstream, so tracking has to
    // be asked for up front rather than recovered from that failure.
    const unconfigured = `refs/heads/${LOCAL_BRANCH}\u0000\u0000\u0000`;
    const git = makeGit(
      { getRemotes: vi.fn(async () => [{ name: REMOTE, refs: { fetch: "", push: "" } }]) },
      unconfigured
    );
    createAuthenticatedGitMock.mockResolvedValue(git);

    await getHandler("git:push")(FAKE_EVENT, { cwd: CWD });

    expect(git.push).toHaveBeenCalledTimes(1);
    expect(git.push).toHaveBeenCalledWith([
      "--set-upstream",
      ...singleBranchArgs(REMOTE, LOCAL_BRANCH, LOCAL_BRANCH),
    ]);
  });

  it("repairs the tracking config in the same push when the upstream names another branch", async () => {
    // `worktree add -b topic --track origin/develop` state: git reports a push
    // remote with no push ref. The push goes to the same-name branch the
    // confirm showed, and rewrites the tracking config that broke it.
    const mistracked = `refs/heads/${LOCAL_BRANCH}\u0000origin\u0000\u0000refs/remotes/origin/develop`;
    const git = makeGit(
      { getRemotes: vi.fn(async () => [{ name: "origin", refs: { fetch: "", push: "" } }]) },
      mistracked
    );
    createAuthenticatedGitMock.mockResolvedValue(git);

    await getHandler("git:push")(FAKE_EVENT, { cwd: CWD });

    expect(git.push).toHaveBeenCalledTimes(1);
    expect(git.push).toHaveBeenCalledWith([
      "--set-upstream",
      ...singleBranchArgs("origin", LOCAL_BRANCH, LOCAL_BRANCH),
    ]);
  });

  it("propagates a push failure without retrying", async () => {
    const push = vi.fn(async () => {
      throw new Error("fatal: Authentication failed");
    });
    createAuthenticatedGitMock.mockResolvedValue(makeGit({ push }));

    await expect(getHandler("git:push")(FAKE_EVENT, { cwd: CWD })).rejects.toThrow();
    expect(push).toHaveBeenCalledTimes(1);
  });
});

describe("git push — lease capture", () => {
  it("reads the lease SHA from the destination's own tracking ref", async () => {
    const revparse = vi.fn(async (args: string[]) => {
      if (args[0] === "--abbrev-ref" && args[1] === "HEAD") return `${LOCAL_BRANCH}\n`;
      return "abc123\n";
    });
    const push = vi.fn(async () => {
      throw new Error("! [rejected] topic -> topic (non-fast-forward)");
    });
    createAuthenticatedGitMock.mockResolvedValue(makeGit({ revparse, push }));

    await expect(getHandler("git:push")(FAKE_EVENT, { cwd: CWD })).rejects.toThrow();

    expect(revparse).toHaveBeenCalledWith([PUSH_REF]);
    expect(revparse).not.toHaveBeenCalledWith([`refs/remotes/origin/${LOCAL_BRANCH}`]);
  });
});

describe("git pull --rebase — resolved destination", () => {
  type StatusFile = { path: string; index: string; working_dir: string };
  function makePullGit(files: StatusFile[] = []): FakeGit {
    return makeGit({ status: vi.fn(async () => ({ files })) });
  }
  function pullArgv(git: FakeGit): string[] | undefined {
    return (git.raw.mock.calls as unknown[][])
      .map((call) => (call[0] ?? []) as string[])
      .find((argv) => argv.includes("pull"));
  }

  it("pulls from the branch upstream, not from its push target", async () => {
    const git = makePullGit();
    createAuthenticatedGitMock.mockResolvedValue(git);

    await getHandler("git:pull-rebase")(FAKE_EVENT, { cwd: CWD });

    const argv = pullArgv(git) ?? [];
    expect(argv.slice(-2)).toEqual([UPSTREAM_REMOTE, UPSTREAM_BRANCH]);
    expect(argv).not.toContain(REMOTE);
  });

  // The confirm previews a plain rebase: merges left out, only this branch
  // moved, nothing stashed. A user's config must not widen what runs past what
  // was approved — the same pins the base rebase carries.
  it("pins the rebase to what the confirm previewed, whatever the user's config says", async () => {
    const git = makePullGit();
    createAuthenticatedGitMock.mockResolvedValue(git);

    await getHandler("git:pull-rebase")(FAKE_EVENT, { cwd: CWD });

    const argv = pullArgv(git) ?? [];
    const pinned = argv.filter((_, i) => argv[i - 1] === "-c");
    for (const key of ["rebase.updateRefs", "rebase.rebaseMerges", "rebase.autoStash"]) {
      expect(pinned).toContain(`${key}=false`);
    }
    expect(argv.indexOf("pull")).toBeGreaterThan(argv.lastIndexOf("-c"));
  });

  it("refuses over uncommitted changes to tracked files, before touching the network", async () => {
    const git = makePullGit([{ path: "a.ts", index: " ", working_dir: "M" }]);
    createAuthenticatedGitMock.mockResolvedValue(git);

    await expect(getHandler("git:pull-rebase")(FAKE_EVENT, { cwd: CWD })).rejects.toThrow(
      /uncommitted/
    );
    expect(pullArgv(git)).toBeUndefined();
  });

  // Untracked files don't stop a rebase, so they don't stop this one.
  it("lets untracked files through", async () => {
    const git = makePullGit([{ path: "scratch.txt", index: "?", working_dir: "?" }]);
    createAuthenticatedGitMock.mockResolvedValue(git);

    await getHandler("git:pull-rebase")(FAKE_EVENT, { cwd: CWD });

    expect(pullArgv(git)).toBeDefined();
  });
});

describe("git force-push-with-lease — resolved destination", () => {
  it("leases against the remote-side branch name, not the local one", async () => {
    const git = makeGit();
    createAuthenticatedGitMock.mockResolvedValue(git);

    await getHandler("git:force-push-with-lease")(FAKE_EVENT, {
      cwd: CWD,
      branchName: LOCAL_BRANCH,
      leaseSha: LEASE,
    });

    expect(git.push).toHaveBeenCalledTimes(1);
    expect(git.push).toHaveBeenCalledWith([
      `--force-with-lease=refs/heads/${REMOTE_BRANCH}:${LEASE}`,
      "--force-if-includes",
      ...singleBranchArgs(REMOTE, LOCAL_BRANCH, REMOTE_BRANCH),
    ]);
  });
});

describe("git force-push-with-lease — upstream repair", () => {
  it("repairs the tracking config on the force-push too", async () => {
    // The reachable path: the repair-form push is rejected as non-fast-forward,
    // the lease is captured, the user force-pushes. Without --set-upstream the
    // push lands and the broken tracking survives its own recovery.
    const mistracked = `refs/heads/${LOCAL_BRANCH}\u0000origin\u0000\u0000refs/remotes/origin/develop`;
    const git = makeGit(
      { getRemotes: vi.fn(async () => [{ name: "origin", refs: { fetch: "", push: "" } }]) },
      mistracked
    );
    createAuthenticatedGitMock.mockResolvedValue(git);

    await getHandler("git:force-push-with-lease")(FAKE_EVENT, {
      cwd: CWD,
      branchName: LOCAL_BRANCH,
      leaseSha: LEASE,
    });

    expect(git.push).toHaveBeenCalledTimes(1);
    expect(git.push).toHaveBeenCalledWith([
      `--force-with-lease=refs/heads/${LOCAL_BRANCH}:${LEASE}`,
      "--force-if-includes",
      "--set-upstream",
      ...singleBranchArgs("origin", LOCAL_BRANCH, LOCAL_BRANCH),
    ]);
  });

  it("establishes tracking on the force-push of a branch with no configuration", async () => {
    // A fresh branch whose name already exists on the remote: the push that
    // would have set its upstream is rejected, so the force-push is the one
    // that lands, and it must write the same tracking.
    const unconfigured = `refs/heads/${LOCAL_BRANCH}\u0000\u0000\u0000`;
    const git = makeGit(
      { getRemotes: vi.fn(async () => [{ name: "origin", refs: { fetch: "", push: "" } }]) },
      unconfigured
    );
    createAuthenticatedGitMock.mockResolvedValue(git);

    await getHandler("git:force-push-with-lease")(FAKE_EVENT, {
      cwd: CWD,
      branchName: LOCAL_BRANCH,
      leaseSha: LEASE,
    });

    expect(git.push).toHaveBeenCalledTimes(1);
    expect(git.push).toHaveBeenCalledWith([
      `--force-with-lease=refs/heads/${LOCAL_BRANCH}:${LEASE}`,
      "--force-if-includes",
      "--set-upstream",
      ...singleBranchArgs("origin", LOCAL_BRANCH, LOCAL_BRANCH),
    ]);
  });

  it("leaves an ordinarily-resolved force-push argv untouched", async () => {
    // The flag must not leak into the common path: a force-push that never
    // needed repair must not silently rewrite tracking config.
    const git = makeGit();
    createAuthenticatedGitMock.mockResolvedValue(git);

    await getHandler("git:force-push-with-lease")(FAKE_EVENT, {
      cwd: CWD,
      branchName: LOCAL_BRANCH,
      leaseSha: LEASE,
    });

    expect(git.push).toHaveBeenCalledTimes(1);
    expect(git.push).toHaveBeenCalledWith(
      expect.not.arrayContaining(["--set-upstream"]) as unknown as string[]
    );
  });
});

describe("list-remote-commits — resolved destination", () => {
  it("ranges over the destination's tracking ref and returns it with the commits", async () => {
    const git = makeGit({
      log: vi.fn(async () => ({
        all: [{ hash: "h1", date: "d", message: "m", author_name: "a" }],
      })),
    });
    createHardenedGitMock.mockResolvedValue(git);

    const result = (await getHandler("git:list-remote-commits")(FAKE_EVENT, {
      cwd: CWD,
      branchName: LOCAL_BRANCH,
      limit: 5,
    })) as { destination: unknown; total: number; commits: unknown[] };

    expect(git.log).toHaveBeenCalledWith([
      "--max-count=5",
      `refs/heads/${LOCAL_BRANCH}..${PUSH_REF}`,
    ]);
    expect(result.destination).toEqual({ remote: REMOTE, branch: REMOTE_BRANCH });
    expect(result.total).toBe(7);
    expect(result.commits).toHaveLength(1);
  });

  it("counts the total over the same range the rows came from", async () => {
    const git = makeGit();
    createHardenedGitMock.mockResolvedValue(git);

    await getHandler("git:list-remote-commits")(FAKE_EVENT, {
      cwd: CWD,
      branchName: LOCAL_BRANCH,
    });

    expect(git.raw).toHaveBeenCalledWith([
      "rev-list",
      "--count",
      `refs/heads/${LOCAL_BRANCH}..${PUSH_REF}`,
    ]);
  });
});

describe("list-push-commits — publish range", () => {
  const LOCAL_REF = `refs/heads/${LOCAL_BRANCH}`;
  /** A 40-hex sha, so `readRemoteBranchTip` accepts the ls-remote line. */
  const REMOTE_TIP = "0123456789abcdef0123456789abcdef01234567";
  /** What the branch resolves to: every local endpoint is this, never the ref. */
  const LOCAL_TIP = "89abcdef0123456789abcdef0123456789abcdef";

  /**
   * A git double for the preview's two probes. `knownRefs` decides what
   * `rev-parse --verify` resolves — which is how the handler learns whether a
   * remote-tracking ref exists — and `lsRemote` is the remote's own answer,
   * kept independent of it so every branch of the basis choice is reachable.
   */
  function makePreviewGit(opts: {
    knownRefs?: string[];
    lsRemote?: () => Promise<string>;
    /** Successive answers for the branch's own ref; the last one repeats. */
    localTips?: Array<string | null>;
  }): FakeGit {
    const localTips = [...(opts.localTips ?? [LOCAL_TIP])];
    const knownRefs = new Set(opts.knownRefs ?? []);
    const git = makeGit({
      log: vi.fn(async () => ({
        all: [{ hash: "h1", date: "d", message: "m", author_name: "a" }],
      })),
    });
    const fallback = rawResponder(FOR_EACH_REF, FOR_EACH_REF_UPSTREAM);
    git.raw = vi.fn(async (args: string[]) => {
      if (args[0] === "rev-parse") {
        const ref = (args[3] ?? "").replace(/\^\{commit\}$/, "");
        if (ref === LOCAL_REF) {
          const tip = localTips.length > 1 ? localTips.shift()! : localTips[0]!;
          if (tip === null) throw new Error("fatal: bad revision");
          return `${tip}\n`;
        }
        if (!knownRefs.has(ref)) throw new Error("fatal: bad revision");
        return `${REMOTE_TIP}\n`;
      }
      if (args[0] === "ls-remote") {
        if (!opts.lsRemote) throw new Error("ls-remote was not expected here");
        return opts.lsRemote();
      }
      return fallback(args);
    });
    return git;
  }

  /** Every argv a git double was called with, for the negative assertions. */
  function argvOf(fn: ReturnType<typeof vi.fn>): string[][] {
    return fn.mock.calls.map((call: unknown[]) => (call[0] ?? []) as string[]);
  }

  function listPushCommits(git: FakeGit) {
    createHardenedGitMock.mockResolvedValue(git);
    return getHandler("git:list-push-commits")(FAKE_EVENT, {
      cwd: CWD,
      branchName: LOCAL_BRANCH,
      limit: 5,
    }) as Promise<{ rangeBasis: string; total: number; destination: unknown; headOid: string }>;
  }

  it("ranges from the destination's tracking ref up to the named branch", async () => {
    const git = makePreviewGit({ knownRefs: [PUSH_REF] });

    const result = await listPushCommits(git);

    // The range runs remote..local, the opposite direction from the discard
    // preview above: these are the commits the push would ADD.
    expect(git.log).toHaveBeenCalledWith(["--max-count=5", `${PUSH_REF}..${LOCAL_TIP}`]);
    expect(git.raw).toHaveBeenCalledWith(["rev-list", "--count", `${PUSH_REF}..${LOCAL_TIP}`]);
    expect(result.rangeBasis).toBe("tracked");
    expect(result.headOid).toBe(LOCAL_TIP);
    expect(result.destination).toEqual({ remote: REMOTE, branch: REMOTE_BRANCH });
    // A tracking ref we hold is a settled answer; nothing justifies the network.
    expect(argvOf(git.raw).some((args) => args[0] === "ls-remote")).toBe(false);
    // Never HEAD: it resolves to whatever is checked out when the range is
    // measured, not to the branch the approver was shown.
    expect(argvOf(git.log).some((args) => args.some((a) => a.includes("HEAD")))).toBe(false);
  });

  it("claims a creation only after the remote reports no such branch", async () => {
    const git = makePreviewGit({ knownRefs: [], lsRemote: async () => "" });

    const result = await listPushCommits(git);

    expect(git.raw).toHaveBeenCalledWith([
      "ls-remote",
      "--heads",
      "--",
      REMOTE,
      `refs/heads/${REMOTE_BRANCH}`,
    ]);
    expect(git.log).toHaveBeenCalledWith(["--max-count=5", LOCAL_TIP]);
    expect(result.rangeBasis).toBe("creates");
  });

  it("ranges from a remote-named tip this repository already holds", async () => {
    const git = makePreviewGit({
      knownRefs: [REMOTE_TIP],
      lsRemote: async () => `${REMOTE_TIP}\trefs/heads/${REMOTE_BRANCH}\n`,
    });

    const result = await listPushCommits(git);

    expect(git.log).toHaveBeenCalledWith(["--max-count=5", `${REMOTE_TIP}..${LOCAL_TIP}`]);
    expect(result.rangeBasis).toBe("tracked");
  });

  it("marks the range unverified rather than claiming a creation when the remote is unreachable", async () => {
    const git = makePreviewGit({
      knownRefs: [],
      lsRemote: () => Promise.reject(new Error("Could not read from remote repository")),
    });

    const result = await listPushCommits(git);

    // The local approximation excludes everything already on ANY ref of that
    // remote — an over-count would read as commits this push publishes.
    expect(git.log).toHaveBeenCalledWith([
      "--max-count=5",
      LOCAL_TIP,
      "--not",
      `--remotes=${REMOTE}`,
    ]);
    expect(result.rangeBasis).toBe("unverified");
    expect(result.rangeBasis).not.toBe("creates");
  });

  it("counts the tail over the same range the rows came from", async () => {
    const git = makePreviewGit({
      knownRefs: [],
      lsRemote: () => Promise.reject(new Error("offline")),
    });

    const result = await listPushCommits(git);

    expect(git.raw).toHaveBeenCalledWith([
      "rev-list",
      "--count",
      LOCAL_TIP,
      "--not",
      `--remotes=${REMOTE}`,
    ]);
    expect(result.total).toBe(7);
  });

  // A destination holding commits the branch lacks refuses the push. The count
  // is measured from the same tip the range was, so the two describe one remote.
  it("measures what the destination has that the branch lacks, from the same tip", async () => {
    const git = makePreviewGit({ knownRefs: [PUSH_REF] });

    const result = (await listPushCommits(git)) as unknown as { behind: number };

    expect(git.raw).toHaveBeenCalledWith(["rev-list", "--count", `${LOCAL_TIP}..${PUSH_REF}`]);
    expect(result.behind).toBe(7);
  });

  // Unmeasured is not level: with no tip read, there is nothing to count against.
  it("claims no lead for a range it could not settle against a tip", async () => {
    const git = makePreviewGit({
      knownRefs: [],
      lsRemote: () => Promise.reject(new Error("offline")),
    });

    const result = (await listPushCommits(git)) as unknown as { behind: number };

    expect(result.behind).toBe(0);
    const countsFromBranch = argvOf(git.raw).filter(
      (argv) => argv[0] === "rev-list" && argv.some((a) => a.startsWith(`${LOCAL_TIP}..`))
    );
    expect(countsFromBranch).toHaveLength(0);
  });

  // The tip is what an approval pins the push to (#15646), so the rows, the
  // count and the lead must all describe that one commit — a commit landing on
  // the branch between two reads must not be counted against a pin that lacks it.
  it("measures every range from the one tip it read, even if the branch moves mid-read", async () => {
    const MOVED_TIP = "fedcba9876543210fedcba9876543210fedcba98";
    const git = makePreviewGit({ knownRefs: [PUSH_REF], localTips: [LOCAL_TIP, MOVED_TIP] });

    const result = await listPushCommits(git);

    expect(result.headOid).toBe(LOCAL_TIP);
    // Exactly the three reads the preview makes — rows, tail count, lead —
    // each against the one tip, and the branch itself resolved only once.
    expect(argvOf(git.log)).toEqual([["--max-count=5", `${PUSH_REF}..${LOCAL_TIP}`]]);
    expect(argvOf(git.raw).filter((args) => args[0] === "rev-list")).toEqual([
      ["rev-list", "--count", `${PUSH_REF}..${LOCAL_TIP}`],
      ["rev-list", "--count", `${LOCAL_TIP}..${PUSH_REF}`],
    ]);
    const branchReads = argvOf(git.raw).filter(
      (args) => args[0] === "rev-parse" && args.some((a) => a.startsWith(LOCAL_REF))
    );
    expect(branchReads).toHaveLength(1);
  });

  it("refuses to preview a branch that resolves to no commit", async () => {
    const git = makePreviewGit({ knownRefs: [PUSH_REF], localTips: [null] });

    await expect(listPushCommits(git)).rejects.toThrow(/\[GitError\|pathspec-invalid\|/);
    expect(git.log).not.toHaveBeenCalled();
  });
});

describe("list-rebase-commits — replay range", () => {
  const LOCAL_REF = `refs/heads/${LOCAL_BRANCH}`;

  /**
   * `knownRefs` decides what `rev-parse --verify` resolves, which is how the
   * handler learns whether the upstream has ever been fetched here. No
   * `ls-remote` hook: a rebase preview is not allowed to touch the network, and
   * the assertions below prove it does not.
   */
  function makeRebaseGit(knownRefs: string[]): FakeGit {
    const known = new Set(knownRefs);
    const git = makeGit({
      log: vi.fn(async () => ({
        all: [{ hash: "h1", date: "d", message: "m", author_name: "a" }],
      })),
    });
    const fallback = rawResponder(FOR_EACH_REF, FOR_EACH_REF_UPSTREAM);
    git.raw = vi.fn(async (args: string[]) => {
      if (args[0] === "rev-parse") {
        const ref = (args[3] ?? "").replace(/\^\{commit\}$/, "");
        if (!known.has(ref)) throw new Error("fatal: bad revision");
        return "0123456789abcdef0123456789abcdef01234567\n";
      }
      return fallback(args);
    });
    return git;
  }

  function listRebaseCommits(git: FakeGit) {
    createHardenedGitMock.mockResolvedValue(git);
    return getHandler("git:list-rebase-commits")(FAKE_EVENT, {
      cwd: CWD,
      branchName: LOCAL_BRANCH,
      limit: 5,
    }) as Promise<{ rangeBasis: string; total: number; behind: number; upstream: unknown }>;
  }

  it("ranges from the UPSTREAM's tracking ref, not the push destination's", async () => {
    const git = makeRebaseGit([UPSTREAM_REF, PUSH_REF]);

    const result = await listRebaseCommits(git);

    // The whole point of the separate read: this branch pushes to `team/fork`
    // and tracks `origin`, and a rebase replays onto what it TRACKS. Ranging
    // against the push destination would preview a set the rebase never touches.
    expect(result.upstream).toEqual({ remote: UPSTREAM_REMOTE, branch: UPSTREAM_BRANCH });
    expect(result.rangeBasis).toBe("tracked");
    expect(
      git.log.mock.calls.some((call: unknown[]) =>
        ((call[0] ?? []) as string[]).some((a) => a.includes(PUSH_REF))
      )
    ).toBe(false);
  });

  // Rebase does not replay everything in `<upstream>..<branch>`. It skips merge
  // commits and commits the upstream already carries as an equivalent patch, so a
  // plain two-dot range promises rewrites that never happen — most visibly to the
  // developer who lands here from a rejected push, whose commits are the ones most
  // likely to be patch-equivalent. Asserted as "the range carries rebase's own
  // selection and the rows and the count agree", not against a literal argv order.
  it("selects the range the way rebase does, and counts over the same one", async () => {
    const git = makeRebaseGit([UPSTREAM_REF]);

    await listRebaseCommits(git);

    const logArgs = (git.log.mock.calls[0]![0] ?? []) as string[];
    const countArgs = (
      git.raw.mock.calls.find(
        (call: unknown[]) => ((call[0] ?? []) as string[])[0] === "rev-list"
      )![0] as string[]
    ).slice(2);
    for (const flag of ["--no-merges", "--cherry-pick", "--right-only"]) {
      expect(logArgs).toContain(flag);
      expect(countArgs).toContain(flag);
    }
    // Symmetric difference, which is what `--right-only` needs to mean anything.
    expect(logArgs).toContain(`${UPSTREAM_REF}...${LOCAL_REF}`);
    // The rows and the total must describe the same set, or the "…and N more"
    // tail is counting something the list is not showing.
    expect(countArgs).toEqual(logArgs.filter((a) => !a.startsWith("--max-count=")));
  });

  // An empty replay set is produced both by a branch level with its upstream and by
  // one purely behind it. Only the second is moved by the rebase, so the count that
  // separates them has to be measured in the other direction.
  it("measures how far behind the branch is, in the opposite direction", async () => {
    const git = makeRebaseGit([UPSTREAM_REF]);

    const result = await listRebaseCommits(git);

    expect(git.raw).toHaveBeenCalledWith(["rev-list", "--count", `${LOCAL_REF}..${UPSTREAM_REF}`]);
    expect(result.behind).toBe(7);
  });

  // The incoming rows come from the same range the count does, so the list and
  // the number beside it describe one set of commits.
  it("lists the incoming commits over the same range it counts", async () => {
    const git = makeRebaseGit([UPSTREAM_REF]);

    const result = (await listRebaseCommits(git)) as unknown as { incoming: unknown[] };

    const incomingLog = git.log.mock.calls
      .map((call: unknown[]) => (call[0] ?? []) as string[])
      .find((argv: string[]) => argv.includes(`${LOCAL_REF}..${UPSTREAM_REF}`));
    expect(incomingLog).toBeDefined();
    expect(result.incoming).toHaveLength(1);
  });

  // The commit the pull is held to (#17188). Read before anything is measured,
  // and every range is measured from it rather than from the branch ref: read
  // last, a commit landing mid-measurement would be pinned without ever having
  // been on screen, and the pull would rebase it on an approval of other rows.
  it("measures every range from the commit it reports, read before any of them", async () => {
    const OID = "0123456789abcdef0123456789abcdef01234567";
    const git = makeRebaseGit([UPSTREAM_REF, LOCAL_REF]);

    const result = (await listRebaseCommits(git)) as unknown as { headOid: string | null };

    expect(result.headOid).toBe(OID);
    const logArgs = git.log.mock.calls.map((call: unknown[]) => (call[0] ?? []) as string[]);
    const countArgs = git.raw.mock.calls
      .map((call: unknown[]) => (call[0] ?? []) as string[])
      .filter((argv: string[]) => argv[0] === "rev-list");
    const measured = [...logArgs, ...countArgs];
    expect(measured.flat()).toContain(`${UPSTREAM_REF}...${OID}`);
    expect(measured.flat()).toContain(`${OID}..${UPSTREAM_REF}`);
    expect(measured.flat().some((arg) => arg.includes(LOCAL_REF))).toBe(false);

    const tipRead = git.raw.mock.calls.findIndex(
      (call: unknown[]) => ((call[0] ?? []) as string[])[3] === `${LOCAL_REF}^{commit}`
    );
    expect(git.raw.mock.invocationCallOrder[tipRead]!).toBeLessThan(
      Math.min(...git.log.mock.invocationCallOrder)
    );
  });

  it("reports the commit on an unfetched upstream too", async () => {
    const git = makeRebaseGit([LOCAL_REF]);

    const result = (await listRebaseCommits(git)) as unknown as {
      rangeBasis: string;
      headOid: string | null;
    };

    expect(result.rangeBasis).toBe("unfetched");
    expect(result.headOid).toBe("0123456789abcdef0123456789abcdef01234567");
  });

  it("reports no commit when the branch can't be read, leaving nothing to approve", async () => {
    const git = makeRebaseGit([UPSTREAM_REF]);

    const result = (await listRebaseCommits(git)) as unknown as { headOid: string | null };

    expect(result.headOid).toBeNull();
  });

  it("never reaches the network to measure a replay set", async () => {
    const git = makeRebaseGit([UPSTREAM_REF]);

    await listRebaseCommits(git);

    // `git pull --rebase` fetches before it replays, and rebasing onto a moved
    // upstream still replays this same set — so no remote read can improve the
    // answer, and a confirm dialog has no business waiting on one.
    expect(
      git.raw.mock.calls.some((call: unknown[]) => ((call[0] ?? []) as string[])[0] === "ls-remote")
    ).toBe(false);
  });

  it("never measures against HEAD, which moves out from under the approver", async () => {
    const git = makeRebaseGit([UPSTREAM_REF]);

    await listRebaseCommits(git);

    expect(
      git.log.mock.calls.some((call: unknown[]) =>
        ((call[0] ?? []) as string[]).some((a) => a.includes("HEAD"))
      )
    ).toBe(false);
  });

  // An upstream configured but never fetched has no local ref to subtract from.
  // Returning the branch's own history there would be the exact misreport this
  // read exists to prevent, so it reports the range as unmeasured instead.
  it("reports an unfetched upstream as unmeasured rather than as branch history", async () => {
    const git = makeRebaseGit([]);

    const result = await listRebaseCommits(git);

    expect(result.rangeBasis).toBe("unfetched");
    expect(result.total).toBe(0);
    expect(git.log).not.toHaveBeenCalled();
    expect(result.upstream).toEqual({ remote: UPSTREAM_REMOTE, branch: UPSTREAM_BRANCH });
  });

  // Fail closed, on the same terms as every other remote-mutating path: an
  // upstream nobody can name must refuse, never degrade into a guess at origin.
  it("refuses in upstream terms when the branch tracks nothing", async () => {
    const git = makeGit({}, FOR_EACH_REF, `refs/heads/${LOCAL_BRANCH}\u0000\u0000`);
    createHardenedGitMock.mockResolvedValue(git);

    await expect(
      getHandler("git:list-rebase-commits")(FAKE_EVENT, {
        cwd: CWD,
        branchName: LOCAL_BRANCH,
        limit: 5,
      })
    ).rejects.toThrow(/upstream/i);
  });
});

describe("fails closed when the destination is unresolvable", () => {
  /** Two remotes, no push config anywhere — the genuinely ambiguous case. */
  function makeUnresolvableGit(overrides: FakeGit = {}): FakeGit {
    return makeGit(
      overrides,
      `refs/heads/${LOCAL_BRANCH}\u0000\u0000`,
      `refs/heads/${LOCAL_BRANCH}\u0000\u0000`
    );
  }

  it("refuses to push and issues no push call", async () => {
    const git = makeUnresolvableGit();
    createAuthenticatedGitMock.mockResolvedValue(git);

    await expect(getHandler("git:push")(FAKE_EVENT, { cwd: CWD })).rejects.toThrow(
      /no push destination configured/
    );
    expect(git.push).not.toHaveBeenCalled();
  });

  it("refuses setUpstream rather than falling back to origin", async () => {
    const git = makeUnresolvableGit();
    createAuthenticatedGitMock.mockResolvedValue(git);

    await expect(
      getHandler("git:push")(FAKE_EVENT, { cwd: CWD, setUpstream: true })
    ).rejects.toThrow(/no push destination configured/);
    expect(git.push).not.toHaveBeenCalled();
  });

  it("refuses to pull-rebase in upstream terms, and issues no pull call", async () => {
    const git = makeUnresolvableGit();
    createAuthenticatedGitMock.mockResolvedValue(git);

    // A missing upstream must not be reported as a missing push destination:
    // the recovery it implies would be for the wrong end of the workflow.
    const error = await getHandler("git:pull-rebase")(FAKE_EVENT, { cwd: CWD }).catch(
      (e: unknown) => e
    );
    expect(String(error)).toMatch(/no upstream configured for branch/);
    expect(String(error)).not.toMatch(/push destination/);
    expect(git.pull).not.toHaveBeenCalled();
  });

  it("refuses to force-push and issues no push call", async () => {
    const git = makeUnresolvableGit();
    createAuthenticatedGitMock.mockResolvedValue(git);

    await expect(
      getHandler("git:force-push-with-lease")(FAKE_EVENT, {
        cwd: CWD,
        branchName: LOCAL_BRANCH,
        leaseSha: LEASE,
      })
    ).rejects.toThrow(/no push destination configured/);
    expect(git.push).not.toHaveBeenCalled();
  });

  it("rejects the discard preview rather than reporting an empty commit list", async () => {
    // An empty list would read as "nothing would be discarded" — the preview
    // must refuse instead so the confirm can't imply a safe force-push.
    const git = makeUnresolvableGit();
    createHardenedGitMock.mockResolvedValue(git);

    await expect(
      getHandler("git:list-remote-commits")(FAKE_EVENT, { cwd: CWD, branchName: LOCAL_BRANCH })
    ).rejects.toThrow(/no push destination configured/);
    expect(git.log).not.toHaveBeenCalled();
  });
});

describe("git:get-staging-status — push and pull destinations", () => {
  // A path that does not exist, so the filesystem git-dir read defers to the
  // fake's rev-parse and no real repository is consulted.
  const CWD = "/nonexistent/staging-status-repo";

  /** Triangular: tracks origin/release/topic, pushes to fork/topic. */
  const COMBINED_RECORD = [
    "refs/heads/topic",
    "fork",
    "refs/remotes/fork/topic",
    "refs/remotes/origin/release/topic",
    "origin",
  ].join("\u0000");

  type FakeGit = Record<string, ReturnType<typeof vi.fn>>;

  function makeGit(overrides: FakeGit = {}, current = "topic"): FakeGit {
    return {
      status: vi.fn(async () => ({
        files: [{ path: "a.ts", index: "M", working_dir: " " }],
        conflicted: [],
        current,
        detached: false,
      })),
      revparse: vi.fn(async (args: string[]) => {
        if (args[0] === "--git-dir") return ".git\n";
        if (args[0] === "--show-toplevel") return `${CWD}\n`;
        return "0123456789abcdef0123456789abcdef01234567\n";
      }),
      raw: vi.fn(async (args: string[]) => {
        if (args[0] === "for-each-ref") return `${COMBINED_RECORD}\n`;
        return "";
      }),
      getRemotes: vi.fn(async () => [
        { name: "origin", refs: { fetch: "", push: "" } },
        { name: "fork", refs: { fetch: "", push: "" } },
      ]),
      diff: vi.fn(async () => ""),
      ...overrides,
    };
  }

  function getStagingStatus(): Promise<StagingStatus> {
    const call = ipcMainMock.handle.mock.calls.find(
      (c: unknown[]) => c[0] === CHANNELS.GIT_GET_STAGING_STATUS
    );
    if (!call) throw new Error("staging status handler not registered");
    return (call[1] as (e: unknown, cwd: string) => Promise<StagingStatus>)({}, CWD);
  }

  function forEachRefCalls(git: FakeGit): string[][] {
    return git.raw!.mock.calls.map((c) => c[0] as string[]).filter((a) => a[0] === "for-each-ref");
  }

  it("resolves both sides from one for-each-ref and one remote listing", async () => {
    const git = makeGit();
    createHardenedGitMock.mockResolvedValue(git);

    const status = await getStagingStatus();

    expect(status.hasRemote).toBe(true);
    expect(status.pushDestination).toEqual({ remote: "fork", branch: "topic" });
    expect(status.pullSource).toEqual({ remote: "origin", branch: "release/topic" });
    expect(forEachRefCalls(git)).toHaveLength(1);
    expect(git.getRemotes).toHaveBeenCalledTimes(1);
  });

  it("degrades both destinations to null when the ref read fails", async () => {
    const git = makeGit({
      raw: vi.fn(async (args: string[]) => {
        if (args[0] === "for-each-ref") throw new Error("fatal: bad ref");
        return "";
      }),
    });
    createHardenedGitMock.mockResolvedValue(git);

    const status = await getStagingStatus();

    expect(status.hasRemote).toBe(true);
    expect(status.pushDestination).toBeNull();
    expect(status.pullSource).toBeNull();
    expect(status.staged.map((e) => e.path)).toEqual(["a.ts"]);
  });

  it("reports no remote and skips the ref read when listing remotes fails", async () => {
    const git = makeGit({ getRemotes: vi.fn(async () => Promise.reject(new Error("boom"))) });
    createHardenedGitMock.mockResolvedValue(git);

    const status = await getStagingStatus();

    expect(status.hasRemote).toBe(false);
    expect(status.pushDestination).toBeNull();
    expect(forEachRefCalls(git)).toHaveLength(0);
  });

  it("skips destination resolution on a detached HEAD", async () => {
    const git = makeGit({}, "HEAD");
    createHardenedGitMock.mockResolvedValue(git);

    const status = await getStagingStatus();

    expect(status.isDetachedHead).toBe(true);
    expect(status.currentBranch).toBeNull();
    expect(status.pushDestination).toBeNull();
    expect(forEachRefCalls(git)).toHaveLength(0);
  });

  it("reads staged churn on an unborn branch and keeps untracked entries without counts", async () => {
    const git = makeGit({
      status: vi.fn(async () => ({
        files: [
          { path: "a.ts", index: "A", working_dir: "M" },
          { path: "b.ts", index: "?", working_dir: "?" },
        ],
        conflicted: [],
        current: "topic",
        detached: false,
      })),
      revparse: vi.fn(async (args: string[]) => {
        if (args[0] === "--git-dir") return ".git\n";
        throw new Error("fatal: ambiguous argument 'HEAD'");
      }),
      diff: vi.fn(async (args: string[]) =>
        args.includes("--cached") ? "1\t0\ta.ts\0" : "0\t2\ta.ts\0"
      ),
    });
    createHardenedGitMock.mockResolvedValue(git);

    const status = await getStagingStatus();

    expect(status.staged).toEqual([{ path: "a.ts", status: "added", insertions: 1, deletions: 0 }]);
    expect(status.unstaged).toEqual([
      { path: "a.ts", status: "modified", insertions: 0, deletions: 2 },
      { path: "b.ts", status: "untracked", insertions: null, deletions: null },
    ]);
    expect(status.repoState).toBe("CLEAN");
  });

  // #17588: only git's own porcelain v2 statement makes a branch unborn.
  describe("unborn branch", () => {
    const UNREADABLE_HEAD = vi.fn(async (args: string[]) => {
      if (args[0] === "--git-dir") return ".git\n";
      throw new Error("fatal: ambiguous argument 'HEAD'");
    });

    function withPorcelain(answer: () => Promise<string>): FakeGit {
      return makeGit({
        revparse: UNREADABLE_HEAD,
        raw: vi.fn(async (args: string[]) => {
          if (args[0] === "status") return answer();
          if (args[0] === "for-each-ref") return "";
          return "";
        }),
      });
    }

    it("says so when git reports this branch with no commit", async () => {
      createHardenedGitMock.mockResolvedValue(
        withPorcelain(async () => "# branch.oid (initial)\n# branch.head topic\n1 A. N...\n")
      );

      const status = await getStagingStatus();

      expect(status.isUnbornBranch).toBe(true);
      expect(status.pushDestination).toBeNull();
    });

    it.each([
      [
        "git reports a commit",
        async () => "# branch.oid 0123456789abcdef0123456789abcdef01234567\n# branch.head topic\n",
      ],
      ["git reports another branch", async () => "# branch.oid (initial)\n# branch.head other\n"],
      ["git reports only the commit", async () => "# branch.oid (initial)\n"],
      ["the probe fails", () => Promise.reject(new Error("fatal: index file corrupt"))],
    ])("stays silent when %s", async (_, answer) => {
      createHardenedGitMock.mockResolvedValue(withPorcelain(answer));

      const status = await getStagingStatus();

      expect(status.currentBranch).toBe("topic");
      expect(status.isUnbornBranch).toBeUndefined();
    });

    it("never asks on a branch whose HEAD reads as a commit", async () => {
      const git = makeGit();
      createHardenedGitMock.mockResolvedValue(git);

      const status = await getStagingStatus();

      expect(status.isUnbornBranch).toBeUndefined();
      const asked = git.raw!.mock.calls.map((c) => c[0] as string[]);
      expect(asked.filter((args) => args[0] === "status")).toEqual([]);
    });
  });
});

describe("git push as an operation", () => {
  const FOR_EACH_REF = "refs/heads/topic\u0000origin\u0000refs/remotes/origin/topic";
  const TIP = "a".repeat(40);
  /** A review this double's repository satisfies: `topic` at `TIP`, to `origin/topic`. */
  const REVIEW = {
    expectedBranch: "topic",
    expectedHeadOid: TIP,
    expectedRemote: "origin",
    expectedRemoteBranch: "topic",
  };

  type ProgressFn = (data: {
    stage: string;
    progress: number;
    processed: number;
    total: number;
  }) => void;

  let events: OperationsEvent[];
  let registry: OperationRegistry;
  let progress: ProgressFn | undefined;
  let releasePush: () => void;
  let failPush: (error: Error) => void;
  let pushCalls: number;

  const push = (payload: Record<string, unknown>) =>
    getHandler("git:push")(FAKE_EVENT, { cwd: CWD, ...payload });

  async function pushStarted(count = 1) {
    await vi.waitFor(() => expect(pushCalls).toBe(count));
  }

  beforeEach(() => {
    events = [];
    registry = new OperationRegistry({ emit: (_projectId, event) => events.push(event) });
    _resetOperationRegistryForTest(registry);
    pushCalls = 0;
    createAuthenticatedGitMock.mockImplementation(
      async (_cwd: string, opts?: { progress?: ProgressFn }) => {
        if (opts?.progress) progress = opts.progress;
        return {
          revparse: vi.fn(async () => "topic\n"),
          raw: vi.fn(async (args: string[]) =>
            args[0] === "for-each-ref"
              ? `${FOR_EACH_REF}\n`
              : args[0] === "rev-parse"
                ? `${TIP}\n`
                : ""
          ),
          getRemotes: vi.fn(async () => [{ name: "origin", refs: { fetch: "", push: "" } }]),
          push: vi.fn(
            () =>
              new Promise<void>((resolve, reject) => {
                pushCalls += 1;
                releasePush = resolve;
                failPush = reject;
              })
          ),
        };
      }
    );
  });

  it("joins a retry with the same opId instead of pushing twice", async () => {
    const first = push({ opId: "op-1" });
    await pushStarted();
    const second = push({ opId: "op-1" });
    releasePush();
    await Promise.all([first, second]);

    expect(pushCalls).toBe(1);
    expect(registry.status("op-1")).toMatchObject({ status: "succeeded" });

    // Retried after the answer was lost: answered from the record.
    await push({ opId: "op-1" });
    expect(pushCalls).toBe(1);
  });

  it("gives a second named caller the outcome of a named push running for the cwd", async () => {
    const first = push({ opId: "op-first" });
    await pushStarted();
    const named = push({ opId: "op-join" });
    failPush(new Error("fatal: Authentication failed"));

    await expect(first).rejects.toThrow();
    await expect(named).rejects.toThrow();
    expect(pushCalls).toBe(1);
    expect(registry.status("op-join")).toMatchObject({ status: "failed" });
  });

  it("refuses to join a running push that asked for something else", async () => {
    const first = push({ opId: "op-first" });
    await pushStarted();
    await expect(push({ opId: "op-other", setUpstream: true })).rejects.toMatchObject({
      code: "VALIDATION",
    });
    releasePush();
    await first;
    expect(pushCalls).toBe(1);
  });

  // A review is part of what was asked for (#15646): a push approved under one
  // review must never be answered with the outcome of a push run under another.
  it("refuses to join a running push that carries a different review", async () => {
    const first = push({ opId: "op-first" });
    await pushStarted();
    await expect(
      push({
        opId: "op-reviewed",
        expectedBranch: "topic",
        expectedHeadOid: "a".repeat(40),
        expectedRemote: "origin",
        expectedRemoteBranch: "topic",
      })
    ).rejects.toMatchObject({ code: "VALIDATION" });
    releasePush();
    await first;
    expect(pushCalls).toBe(1);
  });

  it("joins a second caller whose review is identical", async () => {
    const first = push({ opId: "op-first", ...REVIEW });
    await pushStarted();
    const second = push({ opId: "op-join", ...REVIEW });
    releasePush();
    await Promise.all([first, second]);
    expect(pushCalls).toBe(1);
  });

  for (const [field, value] of [
    ["expectedBranch", "other"],
    ["expectedHeadOid", "b".repeat(40)],
    ["expectedRemote", "fork"],
    ["expectedRemoteBranch", "elsewhere"],
  ] as const) {
    it(`refuses to join a running reviewed push whose review differs in ${field}`, async () => {
      const first = push({ opId: "op-first", ...REVIEW });
      await pushStarted();
      await expect(push({ opId: "op-other", ...REVIEW, [field]: value })).rejects.toMatchObject({
        code: "VALIDATION",
      });
      releasePush();
      await first;
      expect(pushCalls).toBe(1);
    });
  }

  it("refuses a partial review before it could join a running push", async () => {
    const first = push({ opId: "op-first" });
    await pushStarted();
    await expect(push({ opId: "op-first", expectedBranch: "topic" })).rejects.toThrow(
      /Invalid push review/
    );
    releasePush();
    await first;
    expect(pushCalls).toBe(1);
  });

  it("rejects a malformed opId before touching git", async () => {
    await expect(push({ opId: "not/an id" })).rejects.toMatchObject({ code: "VALIDATION" });
    await expect(push({ opId: 42 })).rejects.toMatchObject({ code: "VALIDATION" });
    expect(createAuthenticatedGitMock).not.toHaveBeenCalled();
    expect(registry.list()).toEqual([]);
  });

  it("keeps a second unnamed push a silent no-op, as before", async () => {
    const first = push({});
    await pushStarted();
    await push({});
    expect(pushCalls).toBe(1);
    releasePush();
    await first;
  });

  it("reports progress to the operation, stamped with its opId", async () => {
    const run = push({ opId: "op-progress" });
    await pushStarted();
    progress!({ stage: "writing", progress: 50, processed: 5, total: 10 });
    releasePush();
    await run;

    expect(events).toContainEqual({
      type: "progress",
      progress: expect.objectContaining({
        opId: "op-progress",
        kind: "git-push",
        stage: "writing",
        fraction: 0.5,
      }),
    });
    expect(events.at(-1)).toMatchObject({
      type: "settled",
      record: { opId: "op-progress", outcome: { status: "succeeded" } },
    });
  });

  it("records and publishes nothing for a push with no opId", async () => {
    const run = push({});
    await pushStarted();
    progress!({ stage: "writing", progress: 50, processed: 5, total: 10 });
    releasePush();
    await run;

    expect(registry.list()).toEqual([]);
    expect(events).toEqual([]);
  });

  it("refuses a named caller while an unnamed push, which it has no record to join, owns the cwd", async () => {
    const unnamed = push({});
    await pushStarted();
    await expect(push({ opId: "op-late" })).rejects.toMatchObject({
      code: "VALIDATION",
      userMessage: expect.stringContaining("already running"),
    });
    expect(pushCalls).toBe(1);
    expect(registry.status("op-late")).toEqual({ status: "unknown" });
    releasePush();
    await unnamed;
  });
});

describe("git-write commit and working diff", () => {
  type FakeGit = {
    diff: ReturnType<typeof vi.fn>;
    raw: ReturnType<typeof vi.fn>;
    commit: ReturnType<typeof vi.fn>;
  };

  function makeFakeGit(overrides: Partial<FakeGit> = {}): FakeGit {
    return {
      diff: vi.fn().mockResolvedValue(""),
      raw: vi.fn().mockResolvedValue(""),
      commit: vi.fn().mockResolvedValue({
        commit: "abc123",
        summary: { changes: 1, insertions: 1, deletions: 0 },
      }),
      ...overrides,
    };
  }

  function getHandler(channel: string) {
    const call = ipcMainMock.handle.mock.calls.find((c: unknown[]) => c[0] === channel);
    if (!call) throw new Error(`Handler for ${channel} not registered`);
    return call[1] as (_e: unknown, ...args: unknown[]) => unknown;
  }

  interface StagedEntry {
    path: string;
    content?: string;
    mode?: string;
  }

  const oidFor = (path: string): string => createHash("sha1").update(path).digest("hex");

  beforeEach(() => blobStore.clear());

  // Answers the scanner's `--raw -z` and `--numstat -z` staged-diff queries,
  // and puts each entry's content where the mocked `cat-file` reads it.
  function stagedDiff(entries: Array<string | StagedEntry>, binary: string[] = []) {
    const raw = entries
      .map((entry) => {
        const {
          path,
          mode = "100644",
          content = "clean\n",
        } = typeof entry === "string" ? { path: entry } : entry;
        blobStore.set(oidFor(path), content);
        return `:100644 ${mode} ${"1".repeat(40)} ${oidFor(path)} M\0${path}\0`;
      })
      .join("");
    const numstat = binary.map((path) => `-\t-\t${path}\0`).join("");
    return vi.fn(async (args: string[]) => {
      if (args.includes("--raw")) return raw;
      if (args.includes("--numstat")) return numstat;
      return "";
    });
  }

  const scan = (git: FakeGit) => scanStagedFilesForConflictMarkers(git as never, CWD);

  /** Every object id the scan asked `cat-file --batch` to read. */
  function readOids(): string[] {
    return vi.mocked(readBlobs).mock.calls.flatMap(([, sizes]) => [...sizes.keys()]);
  }

  describe("scanStagedFilesForConflictMarkers", () => {
    it.each([
      ["<<<<<<< HEAD", "start"],
      ["||||||| merged common ancestors", "ancestor"],
      [">>>>>>> branch", "end"],
      ["<<<<<<<", "bare start"],
      [">>>>>>>\r", "bare end before a CRLF"],
      ["<<<<<<<\tHEAD", "start labelled after a tab"],
      ["<<<<<<<< HEAD:b.txt", "eight-wide start from a rename/rename conflict"],
      [">>>>>>>> theirs:c.txt", "eight-wide end from a rename/rename conflict"],
      [">>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>> branch", "end widened by conflict-marker-size"],
    ])("throws for the %s marker line (%s)", async (markerLine) => {
      const git = makeFakeGit({
        diff: stagedDiff([{ path: "f.txt", content: `head\n${markerLine}\ntail\n` }]),
      });
      await expect(scan(git)).rejects.toThrow(/Unresolved conflict markers found in f\.txt/);
    });

    it.each([
      ["a labelled marker", "head\n>>>>>>> branch"],
      ["a bare marker", "head\n>>>>>>>"],
    ])("blocks %s on the last line with no trailing newline", async (_name, content) => {
      const git = makeFakeGit({ diff: stagedDiff([{ path: "f.txt", content }]) });
      await expect(scan(git)).rejects.toThrow(/found in f\.txt \(line 2\)/);
    });

    it("reports the line of the first marker in a full region", async () => {
      const git = makeFakeGit({
        diff: stagedDiff([
          {
            path: "f.md",
            content: "Title\n=======\nbody\n<<<<<<< HEAD\nours\n=======\ntheirs\n>>>>>>> b\n",
          },
        ]),
      });
      await expect(scan(git)).rejects.toThrow(
        "Unresolved conflict markers found in f.md (line 4). Resolve all conflicts before committing."
      );
    });

    it("counts lines through CRLF endings", async () => {
      const git = makeFakeGit({
        diff: stagedDiff([{ path: "f.txt", content: "one\r\ntwo\r\n<<<<<<< HEAD\r\n" }]),
      });
      await expect(scan(git)).rejects.toThrow(/found in f\.txt \(line 3\)/);
    });

    it("counts only LF as a line break, as git does", async () => {
      const git = makeFakeGit({
        diff: stagedDiff([{ path: "f.txt", content: "one\rtwo\n<<<<<<< HEAD\n" }]),
      });
      await expect(scan(git)).rejects.toThrow(/found in f\.txt \(line 2\)/);
    });

    it.each([
      ["a lone divider", "=======\n"],
      ["a Setext underline", "Release notes\n=============\n"],
      ["a CRLF Setext underline", "Release notes\r\n=======\r\n"],
      ["a divider with no trailing newline", "above\n======="],
      ["an indented marker", "  <<<<<<< HEAD\n"],
      ["a mid-line marker", "inline >>>>>>> text\n"],
      ["a marker with text glued to it", "<<<<<<<HEAD\n"],
      ["a wide run with text glued to it", ">>>>>>>>nested quote\n"],
      ["a run followed by a vertical tab", "<<<<<<<\vHEAD\n"],
      ["a run of six", "<<<<<< HEAD\n"],
    ])("does not block %s", async (_name, content) => {
      const git = makeFakeGit({ diff: stagedDiff([{ path: "doc.md", content }]) });
      await expect(scan(git)).resolves.toBeUndefined();
    });

    it.each([
      ["deleted", "000000"],
      ["gitlink", "160000"],
    ])("skips %s staged entries without reading any blobs", async (_kind, mode) => {
      const git = makeFakeGit({ diff: stagedDiff([{ path: "entry", mode }]) });
      await expect(scan(git)).resolves.toBeUndefined();
      expect(readBlobSizes).not.toHaveBeenCalled();
      expect(git.diff).toHaveBeenCalledTimes(1);
    });

    it("skips binary files reported by numstat", async () => {
      const git = makeFakeGit({
        diff: stagedDiff(["image.png"], ["image.png"]),
      });
      await expect(scan(git)).resolves.toBeUndefined();
      expect(git.diff).toHaveBeenCalledTimes(2);
      expect(readBlobSizes).not.toHaveBeenCalled();
    });

    it("short-circuits when there are no staged files", async () => {
      const git = makeFakeGit();
      await expect(scan(git)).resolves.toBeUndefined();
      expect(git.diff).toHaveBeenCalledTimes(1);
      expect(readBlobSizes).not.toHaveBeenCalled();
    });

    it("uses --no-ext-diff and --no-textconv for both staged-diff probes", async () => {
      const git = makeFakeGit({ diff: stagedDiff(["a.ts"]) });
      await scan(git);
      for (const probe of [["--raw", "--no-abbrev"], ["--numstat"]]) {
        expect(git.diff).toHaveBeenCalledWith([
          "--no-ext-diff",
          "--no-textconv",
          "--cached",
          "--no-renames",
          "--no-relative",
          "-z",
          ...probe,
        ]);
      }
    });

    it("reads blobs by the object id git listed, never by path", async () => {
      const git = makeFakeGit({ diff: stagedDiff(["-danger.ts", "src/b.ts"]) });
      await expect(scan(git)).resolves.toBeUndefined();
      expect(readBlobSizes).toHaveBeenCalledTimes(1);
      expect([...vi.mocked(readBlobSizes).mock.calls[0]![1]]).toEqual([
        oidFor("-danger.ts"),
        oidFor("src/b.ts"),
      ]);
      expect(readBlobs).toHaveBeenCalledTimes(1);
      expect(readOids()).toEqual([oidFor("-danger.ts"), oidFor("src/b.ts")]);
    });

    it("reads many small blobs in a single cat-file batch", async () => {
      const paths = Array.from({ length: 50 }, (_, i) => `src/f${i}.ts`);
      const git = makeFakeGit({ diff: stagedDiff(paths) });
      await expect(scan(git)).resolves.toBeUndefined();
      expect(readBlobSizes).toHaveBeenCalledTimes(1);
      expect(readBlobs).toHaveBeenCalledTimes(1);
    });

    it("splits the reads once their total passes what one batch may hold", async () => {
      const big = "a".repeat(900_000);
      const paths = Array.from({ length: 20 }, (_, i) => `f${i}.txt`);
      const git = makeFakeGit({
        diff: stagedDiff([...paths.map((path) => ({ path, content: big }))]),
      });
      await expect(scan(git)).resolves.toBeUndefined();
      const batches = vi
        .mocked(readBlobs)
        .mock.calls.map(([, sizes]) => [...sizes.values()].reduce((sum, size) => sum + size, 0));
      expect(batches.length).toBe(2);
      for (const bytes of batches) expect(bytes).toBeLessThanOrEqual(16_000_000);
      expect(readOids()).toEqual(paths.map(oidFor));
    });

    it("stops on the first offending file and identifies it", async () => {
      const git = makeFakeGit({
        diff: stagedDiff([
          "clean.ts",
          { path: "bad.ts", content: "<<<<<<< HEAD\n" },
          { path: "other.ts", content: ">>>>>>> theirs\n" },
        ]),
      });
      await expect(scan(git)).rejects.toThrow(/Unresolved conflict markers found in bad\.ts/);
    });

    it("blocks a first-line marker that follows a UTF-8 BOM", async () => {
      const git = makeFakeGit({
        diff: stagedDiff([
          { path: "bom.txt", content: "\uFEFF<<<<<<< HEAD\nours\n=======\ntheirs\n>>>>>>> b\n" },
        ]),
      });
      await expect(scan(git)).rejects.toThrow(
        /Unresolved conflict markers found in bom\.txt \(line 1\)/
      );
    });

    it("blocks when content is exactly at the 1 MB byte cap", async () => {
      // Exactly STAGED_FILE_SIZE_CAP bytes (cap boundary) with the marker on
      // its own line. `>` not `>=` means this must still be scanned.
      const markerLine = "<<<<<<< HEAD\n";
      const content = markerLine + "a".repeat(1_000_000 - markerLine.length);
      const git = makeFakeGit({ diff: stagedDiff([{ path: "edge.txt", content }]) });
      expect(Buffer.byteLength(content, "utf8")).toBe(1_000_000);
      await expect(scan(git)).rejects.toThrow(/Unresolved conflict markers/);
    });

    it("skips a blob 1 byte over the cap without reading it", async () => {
      // `>` not `>=` check: 1_000_001 bytes → skip silently, commit proceeds.
      const content = "<<<<<<< HEAD\n" + "a".repeat(1_000_001 - "<<<<<<< HEAD\n".length);
      const git = makeFakeGit({
        diff: stagedDiff([{ path: "huge.txt", content }, "small.ts"]),
      });
      expect(Buffer.byteLength(content, "utf8")).toBe(1_000_001);
      await expect(scan(git)).resolves.toBeUndefined();
      expect(readOids()).toEqual([oidFor("small.ts")]);
    });

    it("propagates cat-file rejections (does not silently permit)", async () => {
      const git = makeFakeGit({ diff: stagedDiff(["src/foo.ts"]) });
      blobStore.clear();
      await expect(scan(git)).rejects.toThrow(/bad object/);
    });
  });

  describe("git:commit handler", () => {
    it("invokes git.commit when staged content is clean", async () => {
      const oid = "abc123".padEnd(40, "0");
      const parent = "f".repeat(40);
      const raw = vi.fn(async (args: string[]) =>
        args[0] === "rev-list" ? `${oid} ${parent}\n` : ""
      );
      const git = makeFakeGit({ diff: stagedDiff(["src/foo.ts"]), raw });
      createHardenedGitMock.mockReturnValue(git);
      registerGitWriteHandlers({} as Parameters<typeof registerGitWriteHandlers>[0]);
      const handler = getHandler("git:commit");

      const result = await handler(null, { cwd: "/tmp/repo", message: "feat: add foo" });
      // The staged blobs are read where the commit runs.
      expect(readBlobs).toHaveBeenCalledWith("/tmp/repo", expect.any(Map));
      expect(git.commit).toHaveBeenCalledWith("feat: add foo");
      // Read back from the hash git printed, never from HEAD.
      expect(raw).toHaveBeenCalledWith([
        "rev-list",
        "--parents",
        "--max-count=1",
        "abc123^{commit}",
      ]);
      expect(result).toEqual({
        hash: "abc123",
        summary: "1 changed, 1 insertions(+), 0 deletions(-)",
        oid,
        parentOids: [parent],
      });
    });

    it("still reports a commit it could not read back, with nothing to pin a push to", async () => {
      const raw = vi.fn(async (args: string[]) => {
        if (args[0] === "rev-list") throw new Error("ambiguous argument");
        return "";
      });
      const git = makeFakeGit({ diff: stagedDiff(["src/foo.ts"]), raw });
      createHardenedGitMock.mockReturnValue(git);
      registerGitWriteHandlers({} as Parameters<typeof registerGitWriteHandlers>[0]);
      const handler = getHandler("git:commit");

      const result = await handler(null, { cwd: "/tmp/repo", message: "feat: add foo" });
      expect(result).toMatchObject({ hash: "abc123", oid: null, parentOids: [] });
    });

    it("blocks the commit when a staged file carries conflict markers", async () => {
      const git = makeFakeGit({
        diff: stagedDiff([
          {
            path: "src/foo.ts",
            content: "<<<<<<< HEAD\nours\n=======\ntheirs\n>>>>>>> branch\n",
          },
        ]),
      });
      createHardenedGitMock.mockReturnValue(git);
      registerGitWriteHandlers({} as Parameters<typeof registerGitWriteHandlers>[0]);
      const handler = getHandler("git:commit");

      await expect(handler(null, { cwd: "/tmp/repo", message: "feat: add foo" })).rejects.toThrow(
        /Unresolved conflict markers found in src\/foo\.ts/
      );
      expect(git.commit).not.toHaveBeenCalled();
    });
  });

  describe("git:get-working-diff handler", () => {
    it("passes --no-ext-diff and --no-textconv for unstaged diff", async () => {
      const git = makeFakeGit({ diff: vi.fn().mockResolvedValue("diff content\n") });
      createHardenedGitMock.mockReturnValue(git);
      registerGitWriteHandlers({} as Parameters<typeof registerGitWriteHandlers>[0]);
      const handler = getHandler("git:get-working-diff");

      await handler(null, { cwd: "/tmp/repo", type: "unstaged" });

      expect(git.diff).toHaveBeenCalledWith(["--no-ext-diff", "--no-textconv"]);
    });

    it("passes --no-ext-diff and --no-textconv for staged diff", async () => {
      const git = makeFakeGit({ diff: vi.fn().mockResolvedValue("diff content\n") });
      createHardenedGitMock.mockReturnValue(git);
      registerGitWriteHandlers({} as Parameters<typeof registerGitWriteHandlers>[0]);
      const handler = getHandler("git:get-working-diff");

      await handler(null, { cwd: "/tmp/repo", type: "staged" });

      expect(git.diff).toHaveBeenCalledWith(["--no-ext-diff", "--no-textconv", "--cached"]);
    });

    it("passes --no-ext-diff and --no-textconv for HEAD diff", async () => {
      const git = makeFakeGit({ diff: vi.fn().mockResolvedValue("diff content\n") });
      createHardenedGitMock.mockReturnValue(git);
      registerGitWriteHandlers({} as Parameters<typeof registerGitWriteHandlers>[0]);
      const handler = getHandler("git:get-working-diff");

      await handler(null, { cwd: "/tmp/repo", type: "head" });

      expect(git.diff).toHaveBeenCalledWith(["--no-ext-diff", "--no-textconv", "HEAD", "--"]);
      expect(createStrictExitGitMock).not.toHaveBeenCalled();
    });

    describe("when the HEAD diff fails", () => {
      const headFailure = new Error("fatal: bad revision 'HEAD'");

      /** A strict git answering each probe by subcommand; anything unlisted fails. */
      function strictGit(answers: Record<string, string | Error>) {
        const strict = makeFakeGit({
          raw: vi.fn(async (args: string[]) => {
            const answer = answers[args[0]];
            if (answer === undefined || answer instanceof Error) {
              throw answer ?? new Error(`unexpected git ${args[0]}`);
            }
            return answer;
          }),
          diff: vi.fn().mockResolvedValue("diff --git a/a.txt b/a.txt\nnew file mode 100644\n"),
        });
        createStrictExitGitMock.mockResolvedValue(strict);
        return strict;
      }

      async function headDiff() {
        const git = makeFakeGit({ diff: vi.fn().mockRejectedValue(headFailure) });
        createHardenedGitMock.mockReturnValue(git);
        registerGitWriteHandlers({} as Parameters<typeof registerGitWriteHandlers>[0]);
        return getHandler("git:get-working-diff")(null, { cwd: "/tmp/repo", type: "head" });
      }

      beforeEach(() => {
        createStrictExitGitMock.mockReset();
      });

      it("diffs an unborn branch against its object format's empty tree", async () => {
        const strict = strictGit({
          "symbolic-ref": "refs/heads/main\n",
          "for-each-ref": "refs/heads/main/old\n",
          "rev-parse": "sha256\n",
        });

        await expect(headDiff()).resolves.toContain("new file mode");
        expect(strict.diff).toHaveBeenCalledWith([
          "--no-ext-diff",
          "--no-textconv",
          "6ef19b41225c5369f1c104d45d8d85efa9b057b53b14b4b9b939dd74decc5321",
          "--",
        ]);
      });

      // Every probe but the one under test answers as an unborn branch would, so
      // a guard that let the case through would reach the empty-tree diff.
      const unborn = {
        "symbolic-ref": "refs/heads/main\n",
        "for-each-ref": "",
        "rev-parse": "sha1\n",
      };
      it.each([
        ["HEAD is detached", { ...unborn, "symbolic-ref": new Error("exited with 1") }],
        ["HEAD's branch has a commit", { ...unborn, "for-each-ref": "refs/heads/main\n" }],
        ["HEAD names a ref outside the branches", { ...unborn, "symbolic-ref": "refs/tags/v1\n" }],
        ["the ref listing fails", { ...unborn, "for-each-ref": new Error("probe failed") }],
        ["the object format can't be read", { ...unborn, "rev-parse": new Error("probe failed") }],
        ["the object format is unknown", { ...unborn, "rev-parse": "sha512\n" }],
      ] as const)("rethrows git's own error when %s", async (_case, answers) => {
        const strict = strictGit(answers);

        await expect(headDiff()).rejects.toBe(headFailure);
        expect(strict.diff).not.toHaveBeenCalled();
      });

      it("rethrows git's own error when no strict git can be made", async () => {
        createStrictExitGitMock.mockRejectedValue(new Error("no git"));

        await expect(headDiff()).rejects.toBe(headFailure);
      });
    });

    it("rejects an invalid diff type without invoking git", async () => {
      const git = makeFakeGit();
      createHardenedGitMock.mockReturnValue(git);
      registerGitWriteHandlers({} as Parameters<typeof registerGitWriteHandlers>[0]);
      const handler = getHandler("git:get-working-diff");

      await expect(handler(null, { cwd: "/tmp/repo", type: "garbage" })).rejects.toThrow(
        /Invalid diff type/
      );
      expect(git.diff).not.toHaveBeenCalled();
    });
  });
});
