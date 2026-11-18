import { describe, it, expect, vi, beforeEach } from "vitest";

const ipcMainMock = vi.hoisted(() => ({
  handle: vi.fn(),
  removeHandler: vi.fn(),
}));

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
const createContinueGitMock = vi.hoisted(() => vi.fn());

vi.mock("../../../utils/hardenedGit.js", () => ({
  validateCwd: vi.fn(),
  createHardenedGit: createHardenedGitMock,
  createAuthenticatedGit: createAuthenticatedGitMock,
  createContinueGit: createContinueGitMock,
}));

const detectRepoOperationStateMock = vi.hoisted(() => vi.fn());
const resolveGitDirMock = vi.hoisted(() => vi.fn(async () => "/repo/.git"));
const readRepoOperationIdMock = vi.hoisted(() => vi.fn(async (): Promise<string | null> => null));
vi.mock("../../../services/git/repoOperationState.js", () => ({
  detectRepoOperationState: detectRepoOperationStateMock,
  resolveGitDir: resolveGitDirMock,
  getRepoOperationStateSync: vi.fn(() => undefined),
  readRepoOperationId: readRepoOperationIdMock,
  readCurrentRepoOperationId: vi.fn(async () => null),
}));

import { registerGitWriteHandlers } from "../git-write.js";
import { CHANNELS } from "../../channels.js";
import { _resetRateLimitQueuesForTest } from "../../utils.js";
import type { RepoState } from "../../../../shared/types/git.js";

const CWD = "/repo";
const BRANCH = "feature/topic";

/**
 * The awkward layout on purpose, from #11747's permutation table: the base
 * branch tracks a remote whose own name carries a slash. Every ref assertion
 * below uses it, so a regression that falls back to a hardcoded `origin` — or
 * that splits the remote name positionally — fails loudly rather than passing
 * by coincidence.
 */
const REMOTE = "team/fork";
const BASE = "develop";
const BASE_TRACKING_REF = `refs/remotes/${REMOTE}/${BASE}`;
const HEAD_OID = "1111111111111111111111111111111111111111";
const BASE_OID = "2222222222222222222222222222222222222222";

type Handlers = Map<string, (...args: unknown[]) => unknown>;

function registeredHandlers(): Handlers {
  const map: Handlers = new Map();
  for (const call of ipcMainMock.handle.mock.calls) {
    map.set(call[0] as string, call[1] as (...args: unknown[]) => unknown);
  }
  return map;
}

interface StatusDouble {
  isClean: () => boolean;
  conflicted: string[];
  files: Array<{ path: string }>;
}

/** A `git status` result as simple-git shapes it: conflicted paths are in `files` too. */
function statusOf(paths: string[], conflicted: string[] = []): StatusDouble {
  return {
    isClean: () => paths.length === 0,
    conflicted,
    files: paths.map((path) => ({ path })),
  };
}

interface GitDoubleOptions {
  /** `git status` result. Clean unless overridden. */
  status?: StatusDouble;
  /** Refs `rev-parse --verify` should report as existing. */
  existingRefs?: string[];
  /** Branch `rev-parse --abbrev-ref HEAD` reports. */
  branch?: string;
  /** Make `rebase`/`merge` reject with this message. */
  failWith?: string;
  /** Remotes `git remote` lists. */
  remotes?: string[];
  /** What `<base>@{upstream}` resolves to, or null. */
  trackedRef?: string | null;
}

function gitDouble(options: GitDoubleOptions = {}) {
  const {
    status = statusOf([]),
    existingRefs = [BASE_TRACKING_REF],
    branch = BRANCH,
    failWith,
    remotes = [REMOTE],
    trackedRef = BASE_TRACKING_REF,
  } = options;

  const raw = vi.fn(async (args: string[]) => {
    if (args[0] === "remote") return `${remotes.join("\n")}\n`;
    if (args[0] === "rev-parse" && args[1] === "--symbolic-full-name") {
      if (trackedRef === null) throw new Error("fatal: no upstream configured");
      return `${trackedRef}\n`;
    }
    if (args[0] === "rev-parse" && args[1] === "--verify") {
      const ref = (args[3] ?? "").replace(/\^\{commit\}$/, "");
      // A checked-out branch always names a commit; the base refs each name one.
      if (ref === "HEAD" || ref === `refs/heads/${branch}`) return `${HEAD_OID}\n`;
      if (existingRefs.includes(ref)) return `${BASE_OID}\n`;
      throw new Error("fatal: needed a single revision");
    }
    if (args[0] === "for-each-ref") {
      return remotes
        .filter((r) => existingRefs.includes(`refs/remotes/${r}/${BASE}`))
        .map((r) => `refs/remotes/${r}/${BASE}`)
        .join("\n");
    }
    if (args[0] === "rev-list") return "3\n";
    return "";
  });

  const wrappedRaw = vi.fn(async (args: string[]) => {
    // The mutating subcommands go through `raw` so the handler can pass `-c`
    // config pins ahead of them. Fail them here when the test asked for it.
    const subcommand = args.find((a, i) => a !== "-c" && args[i - 1] !== "-c");
    if (failWith && (subcommand === "rebase" || subcommand === "merge")) {
      throw new Error(failWith);
    }
    return raw(args);
  });

  return {
    raw: wrappedRaw,
    revparse: vi.fn(async () => `${branch}\n`),
    status: vi.fn(async () => status),
    log: vi.fn(async (_args: string[]) => ({
      all: [{ hash: "aaaaaaaaaaaa", date: "2026-01-01", message: "one", author_name: "A" }],
    })),
  };
}

/** Every `git.raw` invocation whose subcommand (past the `-c` pins) is `name`. */
function callsTo(git: { raw: ReturnType<typeof vi.fn> }, name: string): string[][] {
  return git.raw.mock.calls
    .map((c) => c[0] as string[])
    .filter((args) => args.find((a, i) => a !== "-c" && args[i - 1] !== "-c") === name);
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

beforeEach(() => {
  vi.clearAllMocks();
  _resetRateLimitQueuesForTest();
  detectRepoOperationStateMock.mockResolvedValue({ state: "CLEAN" });
});

describe("git:rebase-onto-base", () => {
  it("rebases onto the resolved base ref, fully qualified", async () => {
    const git = gitDouble();
    createHardenedGitMock.mockResolvedValue(git);
    registerGitWriteHandlers({} as never);

    const handler = registeredHandlers().get(CHANNELS.GIT_REBASE_ONTO_BASE)!;
    await handler({}, { cwd: CWD, baseBranch: BASE });

    // The fully-qualified form, not `team/fork/develop`: `refs/remotes/` makes a
    // leading `-` unrepresentable, and a short ref is ambiguous with a path.
    //
    // The `-c` pins are asserted verbatim, not just present. Each one closes a
    // gap between what the confirm dialog described and what a user's git
    // config would otherwise do — `rebase.updateRefs` in particular can
    // force-update `refs/heads/<base>`, the one write this path exists to
    // avoid.
    expect(callsTo(git, "rebase")).toEqual([
      [
        "-c",
        "rebase.updateRefs=false",
        "-c",
        "rebase.rebaseMerges=false",
        "-c",
        "rebase.autoStash=false",
        "rebase",
        BASE_TRACKING_REF,
      ],
    ]);
  });

  it("never writes the local base ref, fetches, or pushes", async () => {
    // The whole reason the operation targets the remote-tracking ref: git
    // refuses to update a branch checked out in another worktree, which the
    // main worktree normally has.
    const git = gitDouble();
    createHardenedGitMock.mockResolvedValue(git);
    registerGitWriteHandlers({} as never);

    await registeredHandlers().get(CHANNELS.GIT_REBASE_ONTO_BASE)!(
      {},
      { cwd: CWD, baseBranch: BASE }
    );

    const invoked = git.raw.mock.calls.map((c) => (c[0] as string[])[0]);
    expect(invoked).not.toContain("fetch");
    expect(invoked).not.toContain("push");
    expect(invoked).not.toContain("update-ref");
    expect(invoked).not.toContain("branch");
    expect(invoked).not.toContain("update-ref");
    expect(callsTo(git, "rebase")).toHaveLength(1);
  });

  it("refuses a dirty worktree BEFORE touching history", async () => {
    const git = gitDouble({ status: statusOf(["a.ts"]) });
    createHardenedGitMock.mockResolvedValue(git);
    registerGitWriteHandlers({} as never);

    await expect(
      registeredHandlers().get(CHANNELS.GIT_REBASE_ONTO_BASE)!({}, { cwd: CWD, baseBranch: BASE })
    ).rejects.toMatchObject({ reason: "worktree-dirty" });
    expect(callsTo(git, "rebase")).toEqual([]);
  });

  it("refuses when only unmerged files are present", async () => {
    // `isClean()` can be true while conflicts stand, so the conflicted list is
    // checked separately rather than trusted to fold into it.
    const git = gitDouble({
      status: { isClean: () => true, conflicted: ["a.ts"], files: [] },
    });
    createHardenedGitMock.mockResolvedValue(git);
    registerGitWriteHandlers({} as never);

    await expect(
      registeredHandlers().get(CHANNELS.GIT_REBASE_ONTO_BASE)!({}, { cwd: CWD, baseBranch: BASE })
    ).rejects.toMatchObject({ reason: "worktree-dirty" });
    expect(callsTo(git, "rebase")).toEqual([]);
  });

  it("refuses on a detached HEAD before touching history", async () => {
    const git = gitDouble({ branch: "HEAD" });
    createHardenedGitMock.mockResolvedValue(git);
    registerGitWriteHandlers({} as never);

    await expect(
      registeredHandlers().get(CHANNELS.GIT_REBASE_ONTO_BASE)!({}, { cwd: CWD, baseBranch: BASE })
    ).rejects.toThrow(/no branch checked out/i);
    expect(callsTo(git, "rebase")).toEqual([]);
  });

  it("refuses to start a second operation on top of a halted one", async () => {
    detectRepoOperationStateMock.mockResolvedValue({ state: "REBASING" });
    const git = gitDouble();
    createHardenedGitMock.mockResolvedValue(git);
    registerGitWriteHandlers({} as never);

    await expect(
      registeredHandlers().get(CHANNELS.GIT_REBASE_ONTO_BASE)!({}, { cwd: CWD, baseBranch: BASE })
    ).rejects.toMatchObject({ reason: "conflict-unresolved" });
    expect(callsTo(git, "rebase")).toEqual([]);
  });

  it("refuses when no base ref resolves, rather than guessing origin", async () => {
    const git = gitDouble({ existingRefs: [], trackedRef: null, remotes: [] });
    createHardenedGitMock.mockResolvedValue(git);
    registerGitWriteHandlers({} as never);

    await expect(
      registeredHandlers().get(CHANNELS.GIT_REBASE_ONTO_BASE)!({}, { cwd: CWD, baseBranch: BASE })
    ).rejects.toMatchObject({ reason: "config-missing" });
    expect(callsTo(git, "rebase")).toEqual([]);
  });

  it("works against a purely local base branch in a repo with no remote", async () => {
    const git = gitDouble({
      remotes: [],
      trackedRef: null,
      existingRefs: [`refs/heads/${BASE}`],
    });
    createHardenedGitMock.mockResolvedValue(git);
    registerGitWriteHandlers({} as never);

    await registeredHandlers().get(CHANNELS.GIT_REBASE_ONTO_BASE)!(
      {},
      { cwd: CWD, baseBranch: BASE }
    );
    expect(callsTo(git, "rebase")).toEqual([
      [
        "-c",
        "rebase.updateRefs=false",
        "-c",
        "rebase.rebaseMerges=false",
        "-c",
        "rebase.autoStash=false",
        "rebase",
        `refs/heads/${BASE}`,
      ],
    ]);
  });

  it("leaves a conflicted rebase halted instead of auto-aborting", async () => {
    // The halt IS the recovery path: `repoState` flipping to REBASING is what
    // routes the user to Review Hub's ConflictPanel. Aborting here would delete
    // the conflict they are about to resolve.
    const git = gitDouble({ failWith: "CONFLICT (content): Merge conflict in src/a.ts" });
    createHardenedGitMock.mockResolvedValue(git);
    registerGitWriteHandlers({} as never);

    await expect(
      registeredHandlers().get(CHANNELS.GIT_REBASE_ONTO_BASE)!({}, { cwd: CWD, baseBranch: BASE })
    ).rejects.toMatchObject({ reason: "conflict-unresolved" });
    // Exactly one rebase invocation — the one that halted. An auto-abort would
    // show up here as a second `rebase` call carrying `--abort`, which the old
    // "raw was never called with rebase" assertion could not have seen at all.
    const rebases = callsTo(git, "rebase");
    expect(rebases).toHaveLength(1);
    expect(rebases[0]).not.toContain("--abort");
    expect(callsTo(git, "merge")).toEqual([]);
  });

  it("classifies a raw rebase dirty-tree refusal as worktree-dirty", async () => {
    // The message a RAW `git rebase` emits, which differs from the one
    // `git pull --rebase` emits and had no arm in the classifier (#12092).
    const git = gitDouble({ failWith: "error: cannot rebase: You have unstaged changes." });
    createHardenedGitMock.mockResolvedValue(git);
    registerGitWriteHandlers({} as never);

    await expect(
      registeredHandlers().get(CHANNELS.GIT_REBASE_ONTO_BASE)!({}, { cwd: CWD, baseBranch: BASE })
    ).rejects.toMatchObject({ reason: "worktree-dirty" });
  });

  it.each(["--exec=rm -rf /", "-f", "--onto"])(
    "rejects a flag-shaped base branch (%j)",
    async (name) => {
      // `-f` and `--onto` carry no whitespace, so they exercise the leading-dash
      // guard specifically rather than passing on the whitespace rule.
      const git = gitDouble();
      createHardenedGitMock.mockResolvedValue(git);
      registerGitWriteHandlers({} as never);

      await expect(
        registeredHandlers().get(CHANNELS.GIT_REBASE_ONTO_BASE)!({}, { cwd: CWD, baseBranch: name })
      ).rejects.toThrow(/invalid base branch/i);
      expect(callsTo(git, "rebase")).toEqual([]);
    }
  );
});

describe("git:merge-base-into-branch", () => {
  it("merges the resolved base ref with --no-edit", async () => {
    // `--no-edit` is load-bearing: a real merge commit opens an editor, and a
    // utility process has no TTY for it to open on — the spawn would hang.
    const git = gitDouble();
    createHardenedGitMock.mockResolvedValue(git);
    registerGitWriteHandlers({} as never);

    await registeredHandlers().get(CHANNELS.GIT_MERGE_BASE_INTO_BRANCH)!(
      {},
      { cwd: CWD, baseBranch: BASE }
    );
    // `--no-squash` is not cosmetic: `branch.<name>.mergeOptions = --squash` is
    // applied BEFORE command-line args, and under it the merge reports success
    // having created no commit and left everything staged.
    expect(callsTo(git, "merge")).toEqual([
      ["-c", "merge.autoStash=false", "merge", "--no-edit", "--no-squash", BASE_TRACKING_REF],
    ]);
  });

  it("refuses a dirty worktree before merging", async () => {
    const git = gitDouble({ status: statusOf(["a.ts"]) });
    createHardenedGitMock.mockResolvedValue(git);
    registerGitWriteHandlers({} as never);

    await expect(
      registeredHandlers().get(CHANNELS.GIT_MERGE_BASE_INTO_BRANCH)!(
        {},
        { cwd: CWD, baseBranch: BASE }
      )
    ).rejects.toMatchObject({ reason: "worktree-dirty" });
    expect(callsTo(git, "merge")).toEqual([]);
  });
});

describe("git:rebase-onto-base — the base ref is never written", () => {
  it("refuses when the worktree has the BASE branch itself checked out", async () => {
    // The one input on which "write only this worktree's HEAD" and "write
    // refs/heads/<base>" are the same sentence. Reachable on a fork layout
    // where the feature branch is also called `develop`, or a hand-arranged
    // tree — and the source ref being a remote-tracking ref does not save it,
    // because rebase updates the CURRENT branch either way.
    const git = gitDouble({ branch: BASE });
    createHardenedGitMock.mockResolvedValue(git);
    registerGitWriteHandlers({} as never);

    await expect(
      registeredHandlers().get(CHANNELS.GIT_REBASE_ONTO_BASE)!({}, { cwd: CWD, baseBranch: BASE })
    ).rejects.toMatchObject({ reason: "config-missing" });
    expect(callsTo(git, "rebase")).toEqual([]);
  });

  it("refuses a merge onto the base branch for the same reason", async () => {
    const git = gitDouble({ branch: BASE });
    createHardenedGitMock.mockResolvedValue(git);
    registerGitWriteHandlers({} as never);

    await expect(
      registeredHandlers().get(CHANNELS.GIT_MERGE_BASE_INTO_BRANCH)!(
        {},
        { cwd: CWD, baseBranch: BASE }
      )
    ).rejects.toMatchObject({ reason: "config-missing" });
    expect(callsTo(git, "merge")).toEqual([]);
  });

  it.each(["@", "HEAD"])(
    "refuses %j as a base branch — it is a revision, not just a ref",
    async (name) => {
      // `@` is shorthand for HEAD, so `<base>@{upstream}` would resolve the
      // CURRENT branch's upstream and "rebase onto @" would target that.
      const git = gitDouble();
      createHardenedGitMock.mockResolvedValue(git);
      registerGitWriteHandlers({} as never);

      await expect(
        registeredHandlers().get(CHANNELS.GIT_REBASE_ONTO_BASE)!({}, { cwd: CWD, baseBranch: name })
      ).rejects.toThrow(/invalid base branch/i);
      expect(callsTo(git, "rebase")).toEqual([]);
    }
  );
});

describe("git:rebase-onto-base — bound to what was previewed", () => {
  /** A double whose `rev-parse --verify` reports per-ref OIDs. */
  function gitWithOids(oids: Record<string, string>) {
    const git = gitDouble();
    const inner = git.raw;
    git.raw = vi.fn(async (args: string[]) => {
      if (args[0] === "rev-parse" && args[1] === "--verify") {
        const ref = (args[3] ?? "").replace(/\^\{commit\}$/, "");
        if (ref in oids) return `${oids[ref]}\n`;
      }
      return inner(args);
    });
    return git;
  }

  it("proceeds when both pinned commits still hold", async () => {
    const git = gitWithOids({
      [`refs/heads/${BRANCH}`]: HEAD_OID,
      HEAD: HEAD_OID,
      [BASE_TRACKING_REF]: BASE_OID,
    });
    createHardenedGitMock.mockResolvedValue(git);
    registerGitWriteHandlers({} as never);

    await registeredHandlers().get(CHANNELS.GIT_REBASE_ONTO_BASE)!(
      {},
      { cwd: CWD, baseBranch: BASE, expectedHeadOid: HEAD_OID, expectedBaseOid: BASE_OID }
    );
    expect(callsTo(git, "rebase")).toHaveLength(1);
  });

  it("refuses when the branch gained a commit since the preview", async () => {
    // The ordinary case in this product, not a race to shrug at: agents commit
    // into worktrees while a dialog sits open.
    const git = gitWithOids({ HEAD: "9999999999999999999999999999999999999999" });
    createHardenedGitMock.mockResolvedValue(git);
    registerGitWriteHandlers({} as never);

    await expect(
      registeredHandlers().get(CHANNELS.GIT_REBASE_ONTO_BASE)!(
        {},
        { cwd: CWD, baseBranch: BASE, expectedHeadOid: HEAD_OID }
      )
    ).rejects.toMatchObject({ reason: "conflict-unresolved" });
    expect(callsTo(git, "rebase")).toEqual([]);
  });

  it("refuses when the base ref moved since the preview", async () => {
    const git = gitWithOids({
      HEAD: HEAD_OID,
      [BASE_TRACKING_REF]: "8888888888888888888888888888888888888888",
    });
    createHardenedGitMock.mockResolvedValue(git);
    registerGitWriteHandlers({} as never);

    await expect(
      registeredHandlers().get(CHANNELS.GIT_MERGE_BASE_INTO_BRANCH)!(
        {},
        { cwd: CWD, baseBranch: BASE, expectedHeadOid: HEAD_OID, expectedBaseOid: BASE_OID }
      )
    ).rejects.toMatchObject({ reason: "conflict-unresolved" });
    expect(callsTo(git, "merge")).toEqual([]);
  });

  it("refuses when the worktree switched to a DIFFERENT branch at the same commit", async () => {
    // The hole an OID-only pin leaves: checking out another branch that happens
    // to sit on the previewed commit passes every OID check, and the operation
    // then rewrites a branch the user never saw named.
    const git = gitWithOids({ HEAD: HEAD_OID, [BASE_TRACKING_REF]: BASE_OID });
    createHardenedGitMock.mockResolvedValue(git);
    registerGitWriteHandlers({} as never);

    await expect(
      registeredHandlers().get(CHANNELS.GIT_REBASE_ONTO_BASE)!(
        {},
        {
          cwd: CWD,
          baseBranch: BASE,
          expectedBranch: "feature/something-else",
          expectedHeadOid: HEAD_OID,
          expectedBaseOid: BASE_OID,
        }
      )
    ).rejects.toMatchObject({ reason: "conflict-unresolved" });
    expect(callsTo(git, "rebase")).toEqual([]);
  });

  it("proceeds when the branch name still matches", async () => {
    const git = gitWithOids({ HEAD: HEAD_OID, [BASE_TRACKING_REF]: BASE_OID });
    createHardenedGitMock.mockResolvedValue(git);
    registerGitWriteHandlers({} as never);

    await registeredHandlers().get(CHANNELS.GIT_REBASE_ONTO_BASE)!(
      {},
      {
        cwd: CWD,
        baseBranch: BASE,
        expectedBranch: BRANCH,
        expectedHeadOid: HEAD_OID,
        expectedBaseOid: BASE_OID,
      }
    );
    expect(callsTo(git, "rebase")).toHaveLength(1);
  });
});

describe("git:merge-base-into-branch — halted merges", () => {
  it("leaves a conflicted merge halted instead of auto-aborting", async () => {
    const git = gitDouble({ failWith: "CONFLICT (content): Merge conflict in src/a.ts" });
    createHardenedGitMock.mockResolvedValue(git);
    registerGitWriteHandlers({} as never);

    await expect(
      registeredHandlers().get(CHANNELS.GIT_MERGE_BASE_INTO_BRANCH)!(
        {},
        { cwd: CWD, baseBranch: BASE }
      )
    ).rejects.toMatchObject({ reason: "conflict-unresolved" });
    const merges = callsTo(git, "merge");
    expect(merges).toHaveLength(1);
    expect(merges[0]).not.toContain("--abort");
  });
});

describe("base-integration in-flight guard", () => {
  it("releases the worktree when the git factory itself fails", async () => {
    // The guard was claimed before `createHardenedGit` was awaited, so a
    // rejecting factory — a deleted worktree — marked the cwd busy forever and
    // every later attempt reported "already running".
    createHardenedGitMock.mockRejectedValueOnce(new Error("ENOENT: no such directory"));
    registerGitWriteHandlers({} as never);
    const handler = registeredHandlers().get(CHANNELS.GIT_REBASE_ONTO_BASE)!;

    await expect(handler({}, { cwd: CWD, baseBranch: BASE })).rejects.toThrow(/ENOENT/);

    const git = gitDouble();
    createHardenedGitMock.mockResolvedValue(git);
    await handler({}, { cwd: CWD, baseBranch: BASE });
    expect(callsTo(git, "rebase")).toHaveLength(1);
  });
});

describe("git:list-base-integration-commits", () => {
  it("measures a rebase preview with git's own todo-list selection", async () => {
    const git = gitDouble();
    createHardenedGitMock.mockResolvedValue(git);
    registerGitWriteHandlers({} as never);

    const result = (await registeredHandlers().get(CHANNELS.GIT_LIST_BASE_INTEGRATION_COMMITS)!(
      {},
      { cwd: CWD, baseBranch: BASE, kind: "rebase-onto-base" }
    )) as { kind: string; compareRef: string; remote: string | null; behind: number };

    const replaySet = ["--no-merges", "--cherry-pick", "--right-only", `${BASE_OID}...${HEAD_OID}`];
    expect(git.log.mock.calls).toEqual([[["--max-count=20", ...replaySet]]]);
    // The replay total, then `behind`.
    expect(callsTo(git, "rev-list")).toEqual([
      ["rev-list", "--count", ...replaySet],
      ["rev-list", "--count", `${HEAD_OID}..${BASE_OID}`],
    ]);
    expect(result.kind).toBe("rebase-onto-base");
    expect(result.compareRef).toBe(`${REMOTE}/${BASE}`);
    expect(result.remote).toBe(REMOTE);
  });

  it("measures a merge preview in the opposite direction, keeping merges", async () => {
    const git = gitDouble();
    createHardenedGitMock.mockResolvedValue(git);
    registerGitWriteHandlers({} as never);

    await registeredHandlers().get(CHANNELS.GIT_LIST_BASE_INTEGRATION_COMMITS)!(
      {},
      { cwd: CWD, baseBranch: BASE, kind: "merge-base" }
    );

    expect(git.log.mock.calls).toEqual([[["--max-count=20", `${HEAD_OID}..${BASE_OID}`]]]);
    // The incoming total and `behind` are the same range, counted for each.
    expect(callsTo(git, "rev-list")).toEqual([
      ["rev-list", "--count", `${HEAD_OID}..${BASE_OID}`],
      ["rev-list", "--count", `${HEAD_OID}..${BASE_OID}`],
    ]);
  });

  it("measures a purely local base from its own commit", async () => {
    // A repo with no remote resolves the base to `refs/heads/<base>`, and that
    // ref is what the approval pins and every range runs from.
    const LOCAL_BASE_OID = "4444444444444444444444444444444444444444";
    const git = gitDouble({ remotes: [], trackedRef: null, existingRefs: [`refs/heads/${BASE}`] });
    const inner = git.raw;
    git.raw = vi.fn(async (args: string[]) => {
      if (
        args[0] === "rev-parse" &&
        args[1] === "--verify" &&
        args[3] === `refs/heads/${BASE}^{commit}`
      ) {
        return `${LOCAL_BASE_OID}\n`;
      }
      return inner(args);
    });
    createHardenedGitMock.mockResolvedValue(git);
    registerGitWriteHandlers({} as never);

    const result = (await registeredHandlers().get(CHANNELS.GIT_LIST_BASE_INTEGRATION_COMMITS)!(
      {},
      { cwd: CWD, baseBranch: BASE, kind: "merge-base" }
    )) as { compareRef: string; remote: string | null; headOid: string; baseOid: string };

    expect(result).toMatchObject({
      compareRef: BASE,
      remote: null,
      headOid: HEAD_OID,
      baseOid: LOCAL_BASE_OID,
    });
    expect(git.log.mock.calls).toEqual([[["--max-count=20", `${HEAD_OID}..${LOCAL_BASE_OID}`]]]);
  });

  it("rejects an unknown integration kind", async () => {
    const git = gitDouble();
    createHardenedGitMock.mockResolvedValue(git);
    registerGitWriteHandlers({} as never);

    await expect(
      registeredHandlers().get(CHANNELS.GIT_LIST_BASE_INTEGRATION_COMMITS)!(
        {},
        { cwd: CWD, baseBranch: BASE, kind: "pull-rebase" }
      )
    ).rejects.toThrow(/invalid integration kind/i);
  });

  it("fails CLOSED when no base ref resolves, never an empty list", async () => {
    // An empty commit list reads as "nothing to do", which is the reassuring
    // answer and the wrong one when the read simply could not resolve a target.
    const git = gitDouble({ existingRefs: [], trackedRef: null, remotes: [] });
    createHardenedGitMock.mockResolvedValue(git);
    registerGitWriteHandlers({} as never);

    await expect(
      registeredHandlers().get(CHANNELS.GIT_LIST_BASE_INTEGRATION_COMMITS)!(
        {},
        { cwd: CWD, baseBranch: BASE, kind: "rebase-onto-base" }
      )
    ).rejects.toMatchObject({ reason: "config-missing" });
  });
});

describe("git:list-base-integration-commits — measured from the commits it pins (#17583)", () => {
  const MOVED_OID = "3333333333333333333333333333333333333333";
  const LOCAL_REF = `refs/heads/${BRANCH}`;

  /**
   * A repository whose refs are live: `rev-parse` answers from `refs`, which
   * `onLog` may change while the preview's `git log` is running — an agent
   * committing, or background fetch advancing the base, mid-measurement.
   */
  function liveRefsDouble(onLog: (refs: Record<string, string>) => void) {
    const git = gitDouble();
    const inner = git.raw;
    const refs: Record<string, string> = {
      HEAD: HEAD_OID,
      [LOCAL_REF]: HEAD_OID,
      [BASE_TRACKING_REF]: BASE_OID,
    };
    git.raw = vi.fn(async (args: string[]) => {
      if (args[0] === "rev-parse" && args[1] === "--verify") {
        const ref = (args[3] ?? "").replace(/\^\{commit\}$/, "");
        if (ref in refs) return `${refs[ref]}\n`;
      }
      return inner(args);
    });
    const log = git.log;
    // How many counts had already run when the ref moved: the move has to land
    // between the rows and the counts for the case to be the reported race.
    let countsBeforeMove: number | null = null;
    git.log = vi.fn(async (args: string[]) => {
      const rows = await log(args);
      countsBeforeMove = callsTo(git, "rev-list").length;
      onLog(refs);
      return rows;
    });
    return { git, countsBeforeMove: () => countsBeforeMove };
  }

  /** The argument lists of every `git log` and `rev-list` the preview ran, in order. */
  function measurements(git: ReturnType<typeof gitDouble>): string[][] {
    return [...git.log.mock.calls.map(([args]) => ["log", ...args]), ...callsTo(git, "rev-list")];
  }

  const REPLAY_SET = ["--no-merges", "--cherry-pick", "--right-only", `${BASE_OID}...${HEAD_OID}`];
  const INCOMING = `${HEAD_OID}..${BASE_OID}`;
  const MEASURED = {
    "rebase-onto-base": [
      ["log", "--max-count=20", ...REPLAY_SET],
      ["rev-list", "--count", ...REPLAY_SET],
      ["rev-list", "--count", INCOMING],
    ],
    "merge-base": [
      ["log", "--max-count=20", INCOMING],
      ["rev-list", "--count", INCOMING],
      ["rev-list", "--count", INCOMING],
    ],
  };

  it.each([
    {
      label: "the base advances",
      kind: "rebase-onto-base",
      channel: CHANNELS.GIT_REBASE_ONTO_BASE,
      subcommand: "rebase",
      stale: /has moved since/,
      move: (refs: Record<string, string>) => {
        refs[BASE_TRACKING_REF] = MOVED_OID;
      },
    },
    {
      label: "the base advances",
      kind: "merge-base",
      channel: CHANNELS.GIT_MERGE_BASE_INTO_BRANCH,
      subcommand: "merge",
      stale: /has moved since/,
      move: (refs: Record<string, string>) => {
        refs[BASE_TRACKING_REF] = MOVED_OID;
      },
    },
    {
      label: "the branch gains a commit",
      kind: "rebase-onto-base",
      channel: CHANNELS.GIT_REBASE_ONTO_BASE,
      subcommand: "rebase",
      stale: /has new commits since/,
      move: (refs: Record<string, string>) => {
        refs[LOCAL_REF] = MOVED_OID;
        refs.HEAD = MOVED_OID;
      },
    },
    {
      label: "the branch gains a commit",
      kind: "merge-base",
      channel: CHANNELS.GIT_MERGE_BASE_INTO_BRANCH,
      subcommand: "merge",
      stale: /has new commits since/,
      move: (refs: Record<string, string>) => {
        refs[LOCAL_REF] = MOVED_OID;
        refs.HEAD = MOVED_OID;
      },
    },
  ] as const)(
    "$kind: $label mid-read, and the approval is refused as stale",
    async ({ kind, channel, subcommand, stale, move }) => {
      const { git, countsBeforeMove } = liveRefsDouble(move);
      createHardenedGitMock.mockResolvedValue(git);
      registerGitWriteHandlers({} as never);

      const preview = (await registeredHandlers().get(CHANNELS.GIT_LIST_BASE_INTEGRATION_COMMITS)!(
        {},
        { cwd: CWD, baseBranch: BASE, kind }
      )) as { branch: string; headOid: string; baseOid: string };

      // The pins are the commits the rows were measured from, not whatever the
      // refs named once the log had finished.
      expect(preview).toMatchObject({ branch: BRANCH, headOid: HEAD_OID, baseOid: BASE_OID });
      // Every count runs after the move, and still describes the pinned pair.
      expect(countsBeforeMove()).toBe(0);
      expect(measurements(git)).toEqual(MEASURED[kind]);

      // Approving that preview is refused on the side that moved: that commit
      // was never listed.
      await expect(
        registeredHandlers().get(channel)!(
          {},
          {
            cwd: CWD,
            baseBranch: BASE,
            expectedBranch: preview.branch,
            expectedHeadOid: preview.headOid,
            expectedBaseOid: preview.baseOid,
          }
        )
      ).rejects.toMatchObject({
        reason: "conflict-unresolved",
        message: expect.stringMatching(stale),
      });
      expect(callsTo(git, subcommand)).toEqual([]);
    }
  );

  it.each([
    { label: "the branch", unresolved: LOCAL_REF, message: /Branch 'feature\/topic'/ },
    { label: "the base", unresolved: BASE_TRACKING_REF, message: /Base ref 'team\/fork\/develop'/ },
  ])(
    "fails the read when $label stops resolving, never offering an unpinned approval",
    async ({ unresolved, message }) => {
      // The base passed the resolver's existence probe and was then deleted (or
      // the branch's tip vanished) before its commit was captured. A preview
      // with a null pin would hand the write nothing to hold it to.
      const git = gitDouble();
      const inner = git.raw;
      let probes = 0;
      git.raw = vi.fn(async (args: string[]) => {
        if (args[0] === "rev-parse" && args[1] === "--verify" && args[3]?.startsWith(unresolved)) {
          // The base's first probe is the resolver's; only the capture misses.
          probes += 1;
          if (unresolved === LOCAL_REF || probes > 1) {
            throw new Error("fatal: needed a single revision");
          }
        }
        return inner(args);
      });
      createHardenedGitMock.mockResolvedValue(git);
      registerGitWriteHandlers({} as never);

      await expect(
        registeredHandlers().get(CHANNELS.GIT_LIST_BASE_INTEGRATION_COMMITS)!(
          {},
          { cwd: CWD, baseBranch: BASE, kind: "rebase-onto-base" }
        )
      ).rejects.toMatchObject({
        reason: "pathspec-invalid",
        message: expect.stringMatching(message),
      });
      expect(git.log).not.toHaveBeenCalled();
      expect(callsTo(git, "rev-list")).toEqual([]);
    }
  );
});

describe("git:list-base-integration-commits — blockers the write would refuse (#17189)", () => {
  async function readPreview(
    git: ReturnType<typeof gitDouble>,
    kind: "rebase-onto-base" | "merge-base" = "rebase-onto-base"
  ) {
    createHardenedGitMock.mockResolvedValue(git);
    registerGitWriteHandlers({} as never);
    return (await registeredHandlers().get(CHANNELS.GIT_LIST_BASE_INTEGRATION_COMMITS)!(
      {},
      { cwd: CWD, baseBranch: BASE, kind }
    )) as { blocker: unknown; branch: string | null; commits: unknown[] };
  }

  it("reports no blocker for a clean feature branch", async () => {
    const result = await readPreview(gitDouble());
    expect(result.blocker).toBeNull();
    expect(result.commits).toHaveLength(1);
  });

  it("counts uncommitted changes, untracked files included", async () => {
    const result = await readPreview(gitDouble({ status: statusOf(["a.ts", "new.txt"]) }));
    expect(result.blocker).toEqual({ reason: "uncommitted-changes", count: 2 });
  });

  it("names unresolved conflicts ahead of the other changes", async () => {
    const result = await readPreview(
      gitDouble({ status: statusOf(["a.ts", "b.ts", "c.ts"], ["a.ts"]) }),
      "merge-base"
    );
    expect(result.blocker).toEqual({ reason: "conflicts", count: 1 });
  });

  it("flags the base branch itself checked out, ahead of a dirty tree", async () => {
    const result = await readPreview(gitDouble({ branch: BASE, status: statusOf(["a.ts"]) }));
    expect(result.blocker).toEqual({ reason: "base-checked-out" });
  });

  it("flags a halted rebase on its detached HEAD instead of failing the read", async () => {
    // A halted rebase detaches HEAD, so a read that asked for the branch first
    // would fail with "no branch checked out" — the wrong diagnosis and the
    // wrong fix, the same trap the pull-rebase confirm already avoids.
    detectRepoOperationStateMock.mockResolvedValue({
      state: "REBASING",
      rebaseStep: 2,
      rebaseTotalSteps: 5,
    });
    const git = gitDouble({ branch: "HEAD", status: statusOf(["a.ts"], ["a.ts"]) });
    const result = await readPreview(git);

    expect(result.blocker).toEqual({
      reason: "operation-in-progress",
      operation: "REBASING",
      rebaseStep: 2,
      rebaseTotalSteps: 5,
    });
    expect(result.branch).toBeNull();
    expect(result.commits).toEqual([]);
    // Nothing is measured against a HEAD that is mid-replay.
    expect(git.log).not.toHaveBeenCalled();
  });

  it.each(["MERGING", "CHERRY_PICKING", "REVERTING"] as const)(
    "flags a halted %s without progress it doesn't have",
    async (state) => {
      detectRepoOperationStateMock.mockResolvedValue({ state });
      const git = gitDouble();
      const result = await readPreview(git, "merge-base");

      expect(result.blocker).toEqual({
        reason: "operation-in-progress",
        operation: state,
        rebaseStep: null,
        rebaseTotalSteps: null,
      });
      expect(git.log).not.toHaveBeenCalled();
    }
  );

  it("flags conflicts even when the status otherwise reads clean", async () => {
    const result = await readPreview(
      gitDouble({ status: { isClean: () => true, conflicted: ["a.ts"], files: [] } })
    );
    expect(result.blocker).toEqual({ reason: "conflicts", count: 1 });
  });

  it("leaves a checked-out base unmeasured rather than reporting zero to integrate", async () => {
    const git = gitDouble({ branch: BASE });
    const result = (await readPreview(git)) as unknown as {
      branch: string | null;
      compareRef: string | null;
      total: number | null;
      behind: number | null;
    };

    expect(result.branch).toBe(BASE);
    expect(result.compareRef).toBeNull();
    expect(result.total).toBeNull();
    expect(result.behind).toBeNull();
    expect(git.log).not.toHaveBeenCalled();
  });

  it("still measures a dirty tree, so the commits stay visible while blocked", async () => {
    const result = (await readPreview(gitDouble({ status: statusOf(["a.ts"]) }))) as unknown as {
      blocker: unknown;
      commits: unknown[];
      behind: number | null;
    };
    expect(result.blocker).toEqual({ reason: "uncommitted-changes", count: 1 });
    expect(result.commits).toHaveLength(1);
    expect(result.behind).toBe(3);
  });

  it("fails the read when the status can't be read, never reporting no blocker", async () => {
    const git = gitDouble();
    git.status.mockRejectedValue(new Error("fatal: index file corrupt"));
    createHardenedGitMock.mockResolvedValue(git);
    registerGitWriteHandlers({} as never);

    await expect(
      registeredHandlers().get(CHANNELS.GIT_LIST_BASE_INTEGRATION_COMMITS)!(
        {},
        { cwd: CWD, baseBranch: BASE, kind: "rebase-onto-base" }
      )
    ).rejects.toThrow(/index file corrupt/);
  });

  it("refuses the write over a halted rebase as mid-operation, not as a detached HEAD", async () => {
    detectRepoOperationStateMock.mockResolvedValue({ state: "REBASING" });
    const git = gitDouble({ branch: "HEAD" });
    createHardenedGitMock.mockResolvedValue(git);
    registerGitWriteHandlers({} as never);

    await expect(
      registeredHandlers().get(CHANNELS.GIT_REBASE_ONTO_BASE)!({}, { cwd: CWD, baseBranch: BASE })
    ).rejects.toThrow(/mid-operation/);
    expect(callsTo(git, "rebase")).toEqual([]);
  });

  // Each row pins the preview's diagnosis AND the write's own refusal for the
  // same repository, so a blocker that drifted to a different reason, or a
  // write that refused for some unrelated cause, fails here.
  it.each([
    {
      label: "uncommitted changes",
      options: { status: statusOf(["a.ts", "new.txt"]) },
      halted: null,
      blocker: { reason: "uncommitted-changes", count: 2 },
      refusal: { reason: "worktree-dirty" },
    },
    {
      label: "unresolved conflicts",
      options: { status: statusOf(["a.ts", "b.ts", "c.ts"], ["a.ts", "b.ts"]) },
      halted: null,
      blocker: { reason: "conflicts", count: 2 },
      refusal: { reason: "worktree-dirty" },
    },
    {
      label: "the base branch checked out",
      options: { branch: BASE },
      halted: null,
      blocker: { reason: "base-checked-out" },
      refusal: { reason: "config-missing" },
    },
    {
      label: "a halted merge",
      options: {},
      halted: "MERGING",
      blocker: {
        reason: "operation-in-progress",
        operation: "MERGING",
        rebaseStep: null,
        rebaseTotalSteps: null,
      },
      refusal: { reason: "conflict-unresolved", message: expect.stringMatching(/mid-operation/) },
    },
    {
      label: "a clean feature branch",
      options: {},
      halted: null,
      blocker: null,
      refusal: null,
    },
  ] as const)(
    "flags exactly what the write then refuses: $label",
    async ({ options, halted, blocker, refusal }) => {
      for (const [kind, channel, subcommand] of [
        ["rebase-onto-base", CHANNELS.GIT_REBASE_ONTO_BASE, "rebase"],
        ["merge-base", CHANNELS.GIT_MERGE_BASE_INTO_BRANCH, "merge"],
      ] as const) {
        vi.clearAllMocks();
        _resetRateLimitQueuesForTest();
        detectRepoOperationStateMock.mockResolvedValue({ state: halted ?? "CLEAN" });
        const git = gitDouble(options);
        const result = await readPreview(git, kind);
        expect(result.blocker).toEqual(blocker);

        const write = registeredHandlers().get(channel)!({}, { cwd: CWD, baseBranch: BASE });
        if (refusal) {
          await expect(write).rejects.toMatchObject(refusal);
          expect(callsTo(git, subcommand)).toEqual([]);
        } else {
          await write;
          expect(callsTo(git, subcommand)).toHaveLength(1);
        }
      }
    }
  );

  it("refuses the read while an integration is already running in the worktree", async () => {
    // Until git writes its first sentinel, a running integration leaves the
    // tree clean and level, so the read would measure an approval the write is
    // certain to refuse as already running.
    const factory = deferred<ReturnType<typeof gitDouble>>();
    createHardenedGitMock.mockReturnValueOnce(factory.promise);
    registerGitWriteHandlers({} as never);
    const running = registeredHandlers().get(CHANNELS.GIT_REBASE_ONTO_BASE)!(
      {},
      { cwd: CWD, baseBranch: BASE }
    );

    try {
      await expect(
        registeredHandlers().get(CHANNELS.GIT_LIST_BASE_INTEGRATION_COMMITS)!(
          {},
          { cwd: CWD, baseBranch: BASE, kind: "merge-base" }
        )
      ).rejects.toThrow(/already running/);
    } finally {
      // Settled even when the assertion fails, so the claim on the worktree
      // never outlives this test.
      factory.resolve(gitDouble());
      await running;
    }
    // Released once the write settles, so the next read measures normally.
    createHardenedGitMock.mockResolvedValue(gitDouble());
    const after = (await registeredHandlers().get(CHANNELS.GIT_LIST_BASE_INTEGRATION_COMMITS)!(
      {},
      { cwd: CWD, baseBranch: BASE, kind: "merge-base" }
    )) as { blocker: unknown };
    expect(after.blocker).toBeNull();
  });
});

describe("git:continue-repository-operation handler", () => {
  type FakeGit = {
    env: ReturnType<typeof vi.fn>;
    merge: ReturnType<typeof vi.fn>;
    rebase: ReturnType<typeof vi.fn>;
    raw: ReturnType<typeof vi.fn>;
  };

  function makeFakeGit(): FakeGit {
    const git: FakeGit = {
      env: vi.fn(),
      merge: vi.fn().mockResolvedValue(undefined),
      rebase: vi.fn().mockResolvedValue(undefined),
      raw: vi.fn().mockResolvedValue(""),
    };
    // .env() is chainable in simple-git — return the same instance.
    git.env.mockReturnValue(git);
    return git;
  }

  function getHandler(channel: string) {
    const call = ipcMainMock.handle.mock.calls.find((c: unknown[]) => c[0] === channel);
    if (!call) throw new Error(`Handler for ${channel} not registered`);
    return call[1] as (_e: unknown, ...args: unknown[]) => unknown;
  }

  const CONTINUE_CHANNEL = "git:continue-repository-operation";

  function setup(state: RepoState) {
    const git = makeFakeGit();
    createContinueGitMock.mockResolvedValue(git);
    resolveGitDirMock.mockResolvedValue("/tmp/repo/.git");
    detectRepoOperationStateMock.mockResolvedValue({
      state,
      rebaseStep: null,
      rebaseTotalSteps: null,
      rebaseSequence: null,
    });
    registerGitWriteHandlers({} as Parameters<typeof registerGitWriteHandlers>[0]);
    return { git, handler: getHandler(CONTINUE_CHANNEL) };
  }

  // A later .env() would replace the continue profile's hardened env wholesale
  // (#7058), and the plain hardened profile is refused GIT_EDITOR outright.
  it("runs on the continue profile without layering another env over it", async () => {
    const { git, handler } = setup("REBASING");

    await handler(null, "/tmp/repo");

    expect(createContinueGitMock).toHaveBeenCalledWith("/tmp/repo");
    expect(createHardenedGitMock).not.toHaveBeenCalled();
    expect(git.env).not.toHaveBeenCalled();
  });

  it("continues a rebase with --continue (no --no-edit, env suppresses editor)", async () => {
    const { git, handler } = setup("REBASING");

    await handler(null, "/tmp/repo");

    expect(git.rebase).toHaveBeenCalledWith(["--continue"]);
  });

  it("continues a merge with bare --continue (git rejects extra args)", async () => {
    const { git, handler } = setup("MERGING");

    await handler(null, "/tmp/repo");

    // `git merge --continue` errors on any extra argument ("--continue expects
    // no arguments", exit 129); the env overlay handles editor suppression.
    expect(git.merge).toHaveBeenCalledWith(["--continue"]);
  });

  it("continues a cherry-pick with --continue --no-edit", async () => {
    const { git, handler } = setup("CHERRY_PICKING");

    await handler(null, "/tmp/repo");

    expect(git.raw).toHaveBeenCalledWith(["cherry-pick", "--continue", "--no-edit"]);
  });

  it("continues a revert with --continue --no-edit", async () => {
    const { git, handler } = setup("REVERTING");

    await handler(null, "/tmp/repo");

    expect(git.raw).toHaveBeenCalledWith(["revert", "--continue", "--no-edit"]);
  });

  it("continues a git am session with git am, never git rebase", async () => {
    const { git, handler } = setup("APPLYING_MAILBOX");

    await handler(null, "/tmp/repo");

    // `git rebase --continue` refuses an am session outright (exit 128).
    expect(git.raw).toHaveBeenCalledWith(["am", "--continue"]);
    expect(git.rebase).not.toHaveBeenCalled();
  });

  it("propagates a rebase failure instead of swallowing it", async () => {
    const { git, handler } = setup("REBASING");
    git.rebase.mockRejectedValueOnce(new Error("could not apply abc123"));

    await expect(handler(null, "/tmp/repo")).rejects.toThrow(/could not apply abc123/);
  });

  it("propagates a cherry-pick failure instead of swallowing it", async () => {
    const { git, handler } = setup("CHERRY_PICKING");
    git.raw.mockRejectedValueOnce(new Error("cherry-pick failed"));

    await expect(handler(null, "/tmp/repo")).rejects.toThrow(/cherry-pick failed/);
  });

  it("throws when no operation is in progress", async () => {
    const { git, handler } = setup("CLEAN");

    await expect(handler(null, "/tmp/repo")).rejects.toThrow(
      /No repository operation is in progress/
    );
    expect(git.rebase).not.toHaveBeenCalled();
    expect(git.merge).not.toHaveBeenCalled();
  });
});

describe("abort and continue check the operation they were chosen for (#17559)", () => {
  const CHOSEN = { operation: "MERGING", operationId: "merge-a" } as const;

  function setup(channel: string, state: RepoState, currentId: string | null) {
    const git = {
      env: vi.fn(),
      merge: vi.fn().mockResolvedValue(undefined),
      rebase: vi.fn().mockResolvedValue(undefined),
      raw: vi.fn().mockResolvedValue(""),
    };
    createContinueGitMock.mockResolvedValue(git);
    createHardenedGitMock.mockResolvedValue(git);
    detectRepoOperationStateMock.mockResolvedValue({
      state,
      rebaseStep: null,
      rebaseTotalSteps: null,
      rebaseSequence: null,
    });
    readRepoOperationIdMock.mockResolvedValue(currentId);
    registerGitWriteHandlers({} as Parameters<typeof registerGitWriteHandlers>[0]);
    const handler = registeredHandlers().get(channel)!;
    const gitRan = () =>
      git.merge.mock.calls.length + git.rebase.mock.calls.length + git.raw.mock.calls.length;
    return { git, handler, gitRan };
  }

  const CHANNELS_UNDER_TEST = [
    ["abort", CHANNELS.GIT_ABORT_REPOSITORY_OPERATION],
    ["continue", CHANNELS.GIT_CONTINUE_REPOSITORY_OPERATION],
  ] as const;

  describe.each(CHANNELS_UNDER_TEST)("%s", (verb, channel) => {
    it.each([
      ["the same kind replaced it", "MERGING", "merge-b", /restarted or replaced/],
      // The same id, so only the kind comparison can refuse it.
      ["another kind replaced it", "REBASING", "merge-a", /rebase is in progress now/],
      ["it ended", "CLEAN", null, /no longer in progress/],
      ["its identity can't be read now", "MERGING", null, /couldn't confirm/],
    ] as const)("refuses, running no git, when %s", async (_case, state, currentId, message) => {
      const { handler, gitRan } = setup(channel, state, currentId);

      const refusal = handler(null, CWD, CHOSEN) as Promise<void>;
      // Plain prose: the preload adds the transport prefix from the reason.
      await expect(refusal).rejects.toMatchObject({
        reason: "repo-operation-changed",
        message: expect.not.stringContaining("[GitError"),
      });
      await expect(refusal).rejects.toThrow(message);
      expect(gitRan()).toBe(0);
    });

    it("refuses a choice made without an identity, even over the same kind", async () => {
      const { handler, gitRan } = setup(channel, "MERGING", null);
      await expect(
        handler(null, CWD, { operation: "MERGING", operationId: null })
      ).rejects.toMatchObject({ reason: "repo-operation-changed" });
      expect(gitRan()).toBe(0);
    });

    it("refuses a malformed pin before reading the worktree, never treating it as none", async () => {
      const { handler, gitRan } = setup(channel, "MERGING", "merge-a");
      for (const pin of [
        null,
        {},
        { operation: "CLEAN", operationId: "x" },
        { operation: "MERGING", operationId: "" },
      ]) {
        await expect(handler(null, CWD, pin)).rejects.toThrow(/Invalid repository operation pin/);
      }
      expect(createContinueGitMock).not.toHaveBeenCalled();
      expect(createHardenedGitMock).not.toHaveBeenCalled();
      expect(resolveGitDirMock).not.toHaveBeenCalled();
      expect(gitRan()).toBe(0);
    });

    it("runs on the operation it was chosen for", async () => {
      const { git, handler } = setup(channel, "MERGING", "merge-a");
      await handler(null, CWD, CHOSEN);
      expect(git.merge).toHaveBeenCalledWith([verb === "abort" ? "--abort" : "--continue"]);
    });

    it("acts on what it finds when no pin was sent, as an agent dispatch does", async () => {
      const { git, handler } = setup(channel, "MERGING", "merge-b");
      await handler(null, CWD);
      expect(git.merge).toHaveBeenCalledTimes(1);
      expect(readRepoOperationIdMock).not.toHaveBeenCalled();
    });
  });
});
