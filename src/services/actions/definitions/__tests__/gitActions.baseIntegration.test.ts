import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ActionCallbacks, ActionRegistry, AnyActionDefinition } from "../../actionTypes";
import { registerGitActions } from "../gitActions";
import { useGitWorktreeOperationConfirmStore } from "@/store/gitWorktreeOperationConfirmStore";
import {
  setWorktreePathIndexAccessor,
  resetStoreAccessorsForTesting,
} from "@/store/storeAccessors";

const dispatch = vi.hoisted(() => vi.fn().mockResolvedValue({ ok: true }));
vi.mock("@/services/ActionService", () => ({ actionService: { dispatch } }));

const refresh = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock("@/clients", () => ({ worktreeClient: { refresh } }));

const WT_ID = "wt-1";
const WT_PATH = "/repo/one";

type GitStub = Record<string, ReturnType<typeof vi.fn>>;

/** A staging status that reports no operation in progress. */
const CLEAN_STATUS = { repoState: "CLEAN", staged: [], unstaged: [] };
/** …and one that reports the worktree stranded mid-rebase. */
const HALTED_STATUS = { repoState: "REBASING", staged: [], unstaged: [] };

function makeGitStub(): GitStub {
  return {
    rebaseOntoBase: vi.fn().mockResolvedValue(undefined),
    mergeBaseIntoBranch: vi.fn().mockResolvedValue(undefined),
    abortRepositoryOperation: vi.fn().mockResolvedValue(undefined),
    continueRepositoryOperation: vi.fn().mockResolvedValue(undefined),
    getStagingStatus: vi.fn().mockResolvedValue(CLEAN_STATUS),
  };
}

function setupActions() {
  const actions: ActionRegistry = new Map();
  registerGitActions(actions, {} as unknown as ActionCallbacks);
  const git = makeGitStub();

  const run = (id: string, args?: unknown, ctx?: Record<string, unknown>): Promise<unknown> => {
    const factory = actions.get(id);
    if (!factory) throw new Error(`missing ${id}`);
    const def = factory() as AnyActionDefinition;
    Object.defineProperty(globalThis, "window", {
      value: { electron: { git } },
      configurable: true,
      writable: true,
    });
    return def.run(args, (ctx ?? {}) as never) as Promise<unknown>;
  };

  const schemaOf = (id: string) => (actions.get(id)!() as AnyActionDefinition).argsSchema;
  const defOf = (id: string) => actions.get(id)!() as AnyActionDefinition;

  return { git, run, schemaOf, defOf };
}

/** Resolve the deferred confirm the way a mounted dialog would. */
async function settleConfirm(ok: boolean): Promise<void> {
  await vi.waitFor(() => {
    expect(useGitWorktreeOperationConfirmStore.getState().pendingConfirm).not.toBeNull();
  });
  useGitWorktreeOperationConfirmStore.getState().resolveConfirmation(ok);
}

beforeEach(() => {
  dispatch.mockClear();
  refresh.mockClear();
  setWorktreePathIndexAccessor(() => new Map([[WT_ID, WT_PATH]]));
});

afterEach(() => {
  resetStoreAccessorsForTesting();
  Object.defineProperty(globalThis, "window", { value: undefined, configurable: true });
  // Module singleton: a test that failed mid-gate would otherwise leave a
  // pending request behind and contaminate the next one.
  if (useGitWorktreeOperationConfirmStore.getState().pendingConfirm) {
    useGitWorktreeOperationConfirmStore.getState().resolveConfirmation(false);
  }
});

describe("git.rebaseOntoBase", () => {
  it("waits for the confirm before touching git", async () => {
    const { run, git } = setupActions();
    const pending = run("git.rebaseOntoBase", { worktreeId: WT_ID, baseBranch: "develop" });

    await vi.waitFor(() => {
      expect(useGitWorktreeOperationConfirmStore.getState().pendingConfirm).not.toBeNull();
    });
    expect(git.rebaseOntoBase).not.toHaveBeenCalled();

    await settleConfirm(true);
    await pending;
    expect(git.rebaseOntoBase).toHaveBeenCalledWith(WT_PATH, "develop");
  });

  it("does nothing at all when the confirm is declined", async () => {
    const { run, git } = setupActions();
    const pending = run("git.rebaseOntoBase", { worktreeId: WT_ID, baseBranch: "develop" });
    await settleConfirm(false);
    await pending;
    expect(git.rebaseOntoBase).not.toHaveBeenCalled();
    expect(refresh).not.toHaveBeenCalled();
  });

  it("previews the SAME base branch the operation will use", async () => {
    // The dialog must not re-derive the base independently — a preview measured
    // against one ref and an operation run against another is the silent
    // wrong-target failure this whole path is built to avoid.
    const { run } = setupActions();
    const pending = run("git.rebaseOntoBase", { worktreeId: WT_ID, baseBranch: "release/2.0" });
    await vi.waitFor(() => {
      expect(useGitWorktreeOperationConfirmStore.getState().pendingConfirm).not.toBeNull();
    });
    expect(useGitWorktreeOperationConfirmStore.getState().pendingConfirm!.request).toEqual({
      kind: "rebase-onto-base",
      cwd: WT_PATH,
      baseBranch: "release/2.0",
    });
    await settleConfirm(false);
    await pending;
  });

  it("skips the renderer confirm for agent dispatch", async () => {
    // ActionService has already cleared an agent dispatch against the MCP
    // bridge's own confirm, and this store resolves only from a renderer dialog
    // no headless client can click — re-requesting would hang forever (#11538).
    const { run, git } = setupActions();
    await run(
      "git.rebaseOntoBase",
      { worktreeId: WT_ID, baseBranch: "develop" },
      { dispatchSource: "agent" }
    );
    expect(git.rebaseOntoBase).toHaveBeenCalledWith(WT_PATH, "develop");
    expect(useGitWorktreeOperationConfirmStore.getState().pendingConfirm).toBeNull();
  });

  it("refreshes the worktree on success", async () => {
    const { run } = setupActions();
    const pending = run("git.rebaseOntoBase", { worktreeId: WT_ID, baseBranch: "develop" });
    await settleConfirm(true);
    await pending;
    expect(refresh).toHaveBeenCalledWith(WT_ID);
  });

  it("refreshes AND opens Review Hub when the rebase halts", async () => {
    // A halt moves the worktree while throwing. Refreshing only on success
    // would leave the card claiming the pre-rebase state, and the card's own
    // badge is deliberately passive (#10921) — so nothing would take the user
    // to the conflict UI.
    const { run, git } = setupActions();
    git.rebaseOntoBase.mockRejectedValue(new Error("CONFLICT (content): Merge conflict in a.ts"));
    git.getStagingStatus.mockResolvedValue(HALTED_STATUS);

    const pending = run("git.rebaseOntoBase", { worktreeId: WT_ID, baseBranch: "develop" });
    await settleConfirm(true);
    await pending;

    expect(refresh).toHaveBeenCalledWith(WT_ID);
    expect(dispatch).toHaveBeenCalledWith(
      "worktree.openReviewHub",
      { worktreeId: WT_ID },
      undefined
    );
  });

  it("rethrows a failure that did NOT halt, so the caller can report it", async () => {
    // A refusal (dirty tree, unresolvable base) leaves no operation in
    // progress. Swallowing it would report a rebase that never ran as done.
    const { run, git } = setupActions();
    git.rebaseOntoBase.mockRejectedValue(new Error("error: cannot rebase: You have unstaged"));
    git.getStagingStatus.mockResolvedValue(CLEAN_STATUS);

    const pending = run("git.rebaseOntoBase", { worktreeId: WT_ID, baseBranch: "develop" });
    await settleConfirm(true);
    await expect(pending).rejects.toThrow(/cannot rebase/);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("still completes when the worktree is unknown to the index", async () => {
    // A path-only dispatch for a worktree the renderer has not indexed is a
    // valid target for the operation; it just cannot be refreshed by id. That
    // must never turn a successful rebase into a reported failure.
    setWorktreePathIndexAccessor(() => new Map());
    const { run, git } = setupActions();
    const pending = run("git.rebaseOntoBase", {
      worktreePath: "/elsewhere",
      baseBranch: "develop",
    });
    await settleConfirm(true);
    await pending;
    expect(git.rebaseOntoBase).toHaveBeenCalledWith("/elsewhere", "develop");
  });

  it("requires a base branch in its schema", () => {
    const { schemaOf } = setupActions();
    expect(schemaOf("git.rebaseOntoBase")!.safeParse({ worktreeId: WT_ID }).success).toBe(false);
  });
});

describe("git.mergeBaseIntoBranch", () => {
  it("confirms as its own kind, then merges", async () => {
    const { run, git } = setupActions();
    const pending = run("git.mergeBaseIntoBranch", { worktreeId: WT_ID, baseBranch: "develop" });
    await vi.waitFor(() => {
      expect(useGitWorktreeOperationConfirmStore.getState().pendingConfirm).not.toBeNull();
    });
    expect(useGitWorktreeOperationConfirmStore.getState().pendingConfirm!.request).toMatchObject({
      kind: "merge-base",
    });
    await settleConfirm(true);
    await pending;
    expect(git.mergeBaseIntoBranch).toHaveBeenCalledWith(WT_PATH, "develop");
  });

  it("routes a halted merge to Review Hub too", async () => {
    const { run, git } = setupActions();
    git.mergeBaseIntoBranch.mockRejectedValue(new Error("CONFLICT (content): in a.ts"));
    git.getStagingStatus.mockResolvedValue({ ...HALTED_STATUS, repoState: "MERGING" });

    const pending = run("git.mergeBaseIntoBranch", { worktreeId: WT_ID, baseBranch: "develop" });
    await settleConfirm(true);
    await pending;
    expect(dispatch).toHaveBeenCalledWith(
      "worktree.openReviewHub",
      { worktreeId: WT_ID },
      undefined
    );
  });
});

describe("git.abortRepositoryOperation", () => {
  it("confirms before discarding anything", async () => {
    const { run, git } = setupActions();
    const pending = run("git.abortRepositoryOperation", {
      worktreeId: WT_ID,
      operation: "REBASING",
    });
    await vi.waitFor(() => {
      expect(useGitWorktreeOperationConfirmStore.getState().pendingConfirm).not.toBeNull();
    });
    expect(git.abortRepositoryOperation).not.toHaveBeenCalled();
    expect(useGitWorktreeOperationConfirmStore.getState().pendingConfirm!.request).toEqual({
      kind: "abort-operation",
      cwd: WT_PATH,
      operation: "REBASING",
    });
    await settleConfirm(true);
    await pending;
    expect(git.abortRepositoryOperation).toHaveBeenCalledWith(WT_PATH);
    expect(refresh).toHaveBeenCalledWith(WT_ID);
  });

  it("does nothing when declined", async () => {
    const { run, git } = setupActions();
    const pending = run("git.abortRepositoryOperation", {
      worktreeId: WT_ID,
      operation: "REBASING",
    });
    await settleConfirm(false);
    await pending;
    expect(git.abortRepositoryOperation).not.toHaveBeenCalled();
  });

  it("carries danger: confirm so it is excluded from repeatLast and the palette MRU", () => {
    const { defOf } = setupActions();
    expect(defOf("git.abortRepositoryOperation").danger).toBe("confirm");
  });
});

describe("git.continueRepositoryOperation", () => {
  it("continues without a confirm — the user already started this operation", async () => {
    const { run, git, defOf } = setupActions();
    expect(defOf("git.continueRepositoryOperation").danger).toBe("safe");
    await run("git.continueRepositoryOperation", { worktreeId: WT_ID });
    expect(git.continueRepositoryOperation).toHaveBeenCalledWith(WT_PATH);
    expect(useGitWorktreeOperationConfirmStore.getState().pendingConfirm).toBeNull();
  });

  it("opens Review Hub when continuing stops on the NEXT conflict", async () => {
    const { run, git } = setupActions();
    git.getStagingStatus.mockResolvedValue(HALTED_STATUS);
    await run("git.continueRepositoryOperation", { worktreeId: WT_ID });
    expect(dispatch).toHaveBeenCalledWith(
      "worktree.openReviewHub",
      { worktreeId: WT_ID },
      undefined
    );
  });

  it("refreshes even when --continue throws", async () => {
    // `--continue` can advance the operation and THEN stop, which throws while
    // having genuinely moved the worktree. Refreshing only on success would
    // leave the card showing the step before last.
    const { run, git } = setupActions();
    git.continueRepositoryOperation.mockRejectedValue(new Error("CONFLICT (content): in b.ts"));
    await expect(run("git.continueRepositoryOperation", { worktreeId: WT_ID })).rejects.toThrow();
    expect(refresh).toHaveBeenCalledWith(WT_ID);
  });

  it("does not open Review Hub when the operation finished cleanly", async () => {
    const { run, git } = setupActions();
    git.getStagingStatus.mockResolvedValue(CLEAN_STATUS);
    await run("git.continueRepositoryOperation", { worktreeId: WT_ID });
    expect(dispatch).not.toHaveBeenCalled();
  });
});
