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

vi.mock("../../../utils/hardenedGit.js", () => ({
  validateCwd: vi.fn(),
  createHardenedGit: createHardenedGitMock,
  createAuthenticatedGit: createAuthenticatedGitMock,
  buildContinueEnv: vi.fn(() => ({})),
}));

const detectRepoOperationStateMock = vi.hoisted(() => vi.fn());
vi.mock("../../../services/git/repoOperationState.js", () => ({
  detectRepoOperationState: detectRepoOperationStateMock,
  resolveGitDir: vi.fn(async () => "/repo/.git"),
  getRepoOperationStateSync: vi.fn(() => undefined),
}));

import { registerGitWriteHandlers } from "../git-write.js";
import { CHANNELS } from "../../channels.js";
import { _resetRateLimitQueuesForTest } from "../../utils.js";

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

type Handlers = Map<string, (...args: unknown[]) => unknown>;

function registeredHandlers(): Handlers {
  const map: Handlers = new Map();
  for (const call of ipcMainMock.handle.mock.calls) {
    map.set(call[0] as string, call[1] as (...args: unknown[]) => unknown);
  }
  return map;
}

interface GitDoubleOptions {
  /** `git status` result. Clean unless overridden. */
  status?: { isClean: () => boolean; conflicted: string[] };
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
    status = { isClean: () => true, conflicted: [] },
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
      if (existingRefs.includes(ref)) return "0123456789abcdef\n";
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
    log: vi.fn(async () => ({
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
    const git = gitDouble({ status: { isClean: () => false, conflicted: [] } });
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
    const git = gitDouble({ status: { isClean: () => true, conflicted: ["a.ts"] } });
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

  it("rejects a base branch that could reach argv as a flag", async () => {
    const git = gitDouble();
    createHardenedGitMock.mockResolvedValue(git);
    registerGitWriteHandlers({} as never);

    await expect(
      registeredHandlers().get(CHANNELS.GIT_REBASE_ONTO_BASE)!(
        {},
        { cwd: CWD, baseBranch: "--exec=rm -rf /" }
      )
    ).rejects.toThrow(/invalid base branch/i);
    expect(callsTo(git, "rebase")).toEqual([]);
  });
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
    const git = gitDouble({ status: { isClean: () => false, conflicted: [] } });
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
  const HEAD_OID = "1111111111111111111111111111111111111111";
  const BASE_OID = "2222222222222222222222222222222222222222";

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

  it("runs unpinned when no expectation is supplied", async () => {
    // A keybinding, plugin or agent dispatch has no preview to bind to. It gets
    // today's behaviour rather than a hard failure.
    const git = gitDouble();
    createHardenedGitMock.mockResolvedValue(git);
    registerGitWriteHandlers({} as never);

    await registeredHandlers().get(CHANNELS.GIT_REBASE_ONTO_BASE)!(
      {},
      { cwd: CWD, baseBranch: BASE }
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

    expect(git.log).toHaveBeenCalledWith([
      "--max-count=20",
      "--no-merges",
      "--cherry-pick",
      "--right-only",
      `${BASE_TRACKING_REF}...refs/heads/${BRANCH}`,
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

    expect(git.log).toHaveBeenCalledWith([
      "--max-count=20",
      `refs/heads/${BRANCH}..${BASE_TRACKING_REF}`,
    ]);
  });

  it("always measures `behind` base→branch, for both kinds", async () => {
    const git = gitDouble();
    createHardenedGitMock.mockResolvedValue(git);
    registerGitWriteHandlers({} as never);

    await registeredHandlers().get(CHANNELS.GIT_LIST_BASE_INTEGRATION_COMMITS)!(
      {},
      { cwd: CWD, baseBranch: BASE, kind: "rebase-onto-base" }
    );

    const revLists = git.raw.mock.calls
      .map((c) => c[0] as string[])
      .filter((args) => args[0] === "rev-list");
    expect(
      revLists.some((args) => args.includes(`refs/heads/${BRANCH}..${BASE_TRACKING_REF}`))
    ).toBe(true);
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
