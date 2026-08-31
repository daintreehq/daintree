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

  const failing = async () => {
    throw new Error(failWith);
  };

  return {
    raw,
    revparse: vi.fn(async () => `${branch}\n`),
    status: vi.fn(async () => status),
    rebase: failWith ? vi.fn(failing) : vi.fn(async () => ""),
    merge: failWith ? vi.fn(failing) : vi.fn(async () => ""),
    log: vi.fn(async () => ({
      all: [{ hash: "aaaaaaaaaaaa", date: "2026-01-01", message: "one", author_name: "A" }],
    })),
  };
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
    expect(git.rebase).toHaveBeenCalledWith([BASE_TRACKING_REF]);
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
    expect(git.rebase).toHaveBeenCalledWith([BASE_TRACKING_REF]);
  });

  it("refuses a dirty worktree BEFORE touching history", async () => {
    const git = gitDouble({ status: { isClean: () => false, conflicted: [] } });
    createHardenedGitMock.mockResolvedValue(git);
    registerGitWriteHandlers({} as never);

    await expect(
      registeredHandlers().get(CHANNELS.GIT_REBASE_ONTO_BASE)!({}, { cwd: CWD, baseBranch: BASE })
    ).rejects.toMatchObject({ reason: "worktree-dirty" });
    expect(git.rebase).not.toHaveBeenCalled();
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
    expect(git.rebase).not.toHaveBeenCalled();
  });

  it("refuses on a detached HEAD before touching history", async () => {
    const git = gitDouble({ branch: "HEAD" });
    createHardenedGitMock.mockResolvedValue(git);
    registerGitWriteHandlers({} as never);

    await expect(
      registeredHandlers().get(CHANNELS.GIT_REBASE_ONTO_BASE)!({}, { cwd: CWD, baseBranch: BASE })
    ).rejects.toThrow(/no branch checked out/i);
    expect(git.rebase).not.toHaveBeenCalled();
  });

  it("refuses to start a second operation on top of a halted one", async () => {
    detectRepoOperationStateMock.mockResolvedValue({ state: "REBASING" });
    const git = gitDouble();
    createHardenedGitMock.mockResolvedValue(git);
    registerGitWriteHandlers({} as never);

    await expect(
      registeredHandlers().get(CHANNELS.GIT_REBASE_ONTO_BASE)!({}, { cwd: CWD, baseBranch: BASE })
    ).rejects.toMatchObject({ reason: "conflict-unresolved" });
    expect(git.rebase).not.toHaveBeenCalled();
  });

  it("refuses when no base ref resolves, rather than guessing origin", async () => {
    const git = gitDouble({ existingRefs: [], trackedRef: null, remotes: [] });
    createHardenedGitMock.mockResolvedValue(git);
    registerGitWriteHandlers({} as never);

    await expect(
      registeredHandlers().get(CHANNELS.GIT_REBASE_ONTO_BASE)!({}, { cwd: CWD, baseBranch: BASE })
    ).rejects.toMatchObject({ reason: "config-missing" });
    expect(git.rebase).not.toHaveBeenCalled();
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
    expect(git.rebase).toHaveBeenCalledWith([`refs/heads/${BASE}`]);
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
    expect(git.raw.mock.calls.map((c) => (c[0] as string[])[0])).not.toContain("rebase");
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
    expect(git.rebase).not.toHaveBeenCalled();
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
    expect(git.merge).toHaveBeenCalledWith([BASE_TRACKING_REF, "--no-edit"]);
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
    expect(git.merge).not.toHaveBeenCalled();
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
