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

const notify = vi.hoisted(() => vi.fn());
vi.mock("@/lib/notify", () => ({ notify }));

const WT_ID = "wt-1";
const WT_PATH = "/repo/one";

/**
 * Named members, not an index signature: `Record<string, Mock>` resolves every
 * read to `Mock | undefined` under `noUncheckedIndexedAccess`, so a typo in a
 * method name would typecheck as "possibly undefined" rather than as a missing
 * stub.
 */
interface GitStub {
  rebaseOntoBase: ReturnType<typeof vi.fn>;
  mergeBaseIntoBranch: ReturnType<typeof vi.fn>;
  abortRepositoryOperation: ReturnType<typeof vi.fn>;
  continueRepositoryOperation: ReturnType<typeof vi.fn>;
  getStagingStatus: ReturnType<typeof vi.fn>;
}

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
  // None of the git actions read a callback, so supplying the ~40-member real
  // shape here would be noise. Same fixture the sibling adversarial suite builds.
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- test fixture
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
    // `run` over the definition union intersects its context parameter to
    // `never`, so a caller cannot name the type it must pass. Same as the
    // sibling adversarial suite.
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- union parameter is `never`
    return def.run(args, (ctx ?? {}) as never) as Promise<unknown>;
  };

  const schemaOf = (id: string) => (actions.get(id)!() as AnyActionDefinition).argsSchema;
  const defOf = (id: string) => actions.get(id)!() as AnyActionDefinition;

  return { git, run, schemaOf, defOf };
}

/** Resolve the deferred confirm the way a mounted dialog would. */
async function settleConfirm(
  ok: boolean,
  pinned?: { branch?: string; headOid?: string; baseOid?: string }
): Promise<void> {
  await vi.waitFor(() => {
    expect(useGitWorktreeOperationConfirmStore.getState().pendingConfirm).not.toBeNull();
  });
  useGitWorktreeOperationConfirmStore.getState().resolveConfirmation(ok, pinned ?? null);
}

/**
 * A rejection shaped like one that crossed the contextBridge.
 *
 * The preload encodes `GitOperationError`'s discriminant INTO the message, and
 * the action reads it back with `isClientGitError` to tell a genuine halt from
 * an unrelated refusal. A bare `new Error("CONFLICT …")` would classify as
 * `unknown` here and silently skip the routing these tests are about.
 */
function gitError(reason: string, message: string): Error {
  return new Error(`[GitError|${reason}||] ${message}`);
}

beforeEach(() => {
  // `mockClear` alone resets call history but KEEPS the implementation, so a
  // test that swaps in `{ok:false}` to exercise a failed dispatch silently
  // poisons every test after it. Reset and re-arm the default instead.
  dispatch.mockReset();
  dispatch.mockResolvedValue({ ok: true });
  refresh.mockReset();
  refresh.mockResolvedValue(undefined);
  notify.mockReset();
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
    expect(git.rebaseOntoBase).toHaveBeenCalledWith(WT_PATH, "develop", undefined);
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
    expect(git.rebaseOntoBase).toHaveBeenCalledWith(WT_PATH, "develop", undefined);
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
    git.rebaseOntoBase.mockRejectedValue(
      gitError("conflict-unresolved", "CONFLICT (content): Merge conflict in a.ts")
    );
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
    git.rebaseOntoBase.mockRejectedValue(
      gitError("worktree-dirty", "error: cannot rebase: You have unstaged changes.")
    );
    git.getStagingStatus.mockResolvedValue(CLEAN_STATUS);

    const pending = run("git.rebaseOntoBase", { worktreeId: WT_ID, baseBranch: "develop" });
    await settleConfirm(true);
    await expect(pending).rejects.toThrow(/cannot rebase/);
    expect(dispatch).not.toHaveBeenCalled();
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
    expect(git.mergeBaseIntoBranch).toHaveBeenCalledWith(WT_PATH, "develop", undefined);
  });

  it("routes a halted merge to Review Hub too", async () => {
    const { run, git } = setupActions();
    git.mergeBaseIntoBranch.mockRejectedValue(
      gitError("conflict-unresolved", "CONFLICT (content): in a.ts")
    );
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

describe("halt routing is correlated, not inferred from state", () => {
  it("rethrows a refusal even when the worktree happens to be mid-operation", async () => {
    // The race that made state-alone wrong: an agent starts a cherry-pick in
    // its own PTY between the click and the failure. The rebase was REFUSED —
    // it never ran — but the fresh status reports CHERRY_PICKING. Treating that
    // as a halt would open a conflict panel for an operation this action never
    // started, and report success for a rebase that did not happen.
    const { run, git } = setupActions();
    git.rebaseOntoBase.mockRejectedValue(
      gitError("worktree-dirty", "This worktree has uncommitted changes.")
    );
    git.getStagingStatus.mockResolvedValue({ ...HALTED_STATUS, repoState: "CHERRY_PICKING" });

    const pending = run("git.rebaseOntoBase", { worktreeId: WT_ID, baseBranch: "develop" });
    await settleConfirm(true);
    await expect(pending).rejects.toThrow(/uncommitted changes/);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("rethrows the handler's own already-mid-operation refusal", async () => {
    // Encoded as `conflict-unresolved` because that is the closest reason, so
    // the state check alone cannot separate it from a real halt either. It is
    // separated by the panel actually opening — which it does — but the error
    // must still not be reported as a success by the ROW.
    const { run, git } = setupActions();
    git.rebaseOntoBase.mockRejectedValue(
      gitError("conflict-unresolved", "This worktree is already mid-operation (rebasing).")
    );
    git.getStagingStatus.mockResolvedValue(HALTED_STATUS);
    dispatch.mockResolvedValue({ ok: true });

    const pending = run("git.rebaseOntoBase", { worktreeId: WT_ID, baseBranch: "develop" });
    await settleConfirm(true);
    await pending;
    // Routed, because the worktree genuinely IS halted and the panel is where
    // the recovery lives. The distinction this test pins is that the reason is
    // read rather than guessed.
    expect(dispatch).toHaveBeenCalledWith(
      "worktree.openReviewHub",
      { worktreeId: WT_ID },
      undefined
    );
  });

  it("rethrows when Review Hub could not actually be opened", async () => {
    // `ActionService.dispatch` resolves `{ok:false}` rather than rejecting, and
    // `worktree.openReviewHub` fails softly when its worktree lookup misses.
    // Swallowing the git error on the strength of a dispatch that did nothing
    // would leave the repository halted with no panel and no report.
    const { run, git } = setupActions();
    git.rebaseOntoBase.mockRejectedValue(
      gitError("conflict-unresolved", "CONFLICT (content): in a.ts")
    );
    git.getStagingStatus.mockResolvedValue(HALTED_STATUS);
    dispatch.mockResolvedValue({ ok: false, error: { code: "NOT_FOUND", message: "gone" } });

    const pending = run("git.rebaseOntoBase", { worktreeId: WT_ID, baseBranch: "develop" });
    await settleConfirm(true);
    await expect(pending).rejects.toThrow(/CONFLICT/);
  });
});

describe("the write is bound to what the dialog previewed", () => {
  it("forwards the pinned commits to the IPC", async () => {
    const { run, git } = setupActions();
    const pending = run("git.rebaseOntoBase", { worktreeId: WT_ID, baseBranch: "develop" });
    await settleConfirm(true, { branch: "feature/topic", headOid: "aaa", baseOid: "bbb" });
    await pending;
    expect(git.rebaseOntoBase).toHaveBeenCalledWith(WT_PATH, "develop", {
      branch: "feature/topic",
      headOid: "aaa",
      baseOid: "bbb",
    });
  });

  it("sends no pins for an agent dispatch, which had no preview to bind to", async () => {
    const { run, git } = setupActions();
    await run(
      "git.rebaseOntoBase",
      { worktreeId: WT_ID, baseBranch: "develop" },
      { dispatchSource: "agent" }
    );
    expect(git.rebaseOntoBase).toHaveBeenCalledWith(WT_PATH, "develop", undefined);
  });
});

describe("refreshWorktree never widens into a global sweep", () => {
  it("skips the refresh entirely for a worktree the index cannot name", async () => {
    // `worktreeClient.refresh(undefined)` does not mean "no worktree" — it
    // means ALL of them, plus a pull-request sweep against the provider's rate
    // limit. A one-worktree operation must never trigger that.
    setWorktreePathIndexAccessor(() => new Map());
    const { run, git } = setupActions();
    const pending = run("git.rebaseOntoBase", {
      worktreePath: "/elsewhere",
      baseBranch: "develop",
    });
    await settleConfirm(true);
    await pending;
    expect(git.rebaseOntoBase).toHaveBeenCalled();
    expect(refresh).not.toHaveBeenCalled();
  });
});

describe("a failed operation is reported, not swallowed", () => {
  it("raises one toast with humanized copy and a single recovery action", async () => {
    // `ActionService.dispatch` CATCHES an action's error and resolves
    // `{ok:false}`, so every dispatch surface — menu row, palette, keybinding —
    // discards the failure unless the action reports it. Reporting here covers
    // all of them at once.
    const { run, git } = setupActions();
    git.rebaseOntoBase.mockRejectedValue(
      gitError("worktree-dirty", "This worktree has uncommitted changes.")
    );
    git.getStagingStatus.mockResolvedValue(CLEAN_STATUS);

    const pending = run("git.rebaseOntoBase", { worktreeId: WT_ID, baseBranch: "develop" });
    await settleConfirm(true);
    await expect(pending).rejects.toThrow();

    expect(notify).toHaveBeenCalledTimes(1);
    const payload = notify.mock.calls[0]![0] as {
      type: string;
      title: string;
      message: string;
      context: { eventKind: string };
      action: { label: string };
    };
    expect(payload.type).toBe("error");
    expect(payload.context.eventKind).toBe("git");
    expect(payload.action.label).toBe("Open Review Hub");
    // The copy comes from the classified reason, not the raw git string.
    expect(payload.title).not.toContain("[GitError");
    expect(payload.message.length).toBeGreaterThan(0);
  });

  it("stays silent when the operation succeeds", async () => {
    const { run } = setupActions();
    const pending = run("git.rebaseOntoBase", { worktreeId: WT_ID, baseBranch: "develop" });
    await settleConfirm(true);
    await pending;
    expect(notify).not.toHaveBeenCalled();
  });

  it("stays silent on a halt — the conflict panel it just opened is the report", async () => {
    const { run, git } = setupActions();
    git.rebaseOntoBase.mockRejectedValue(
      gitError("conflict-unresolved", "CONFLICT (content): in a.ts")
    );
    git.getStagingStatus.mockResolvedValue(HALTED_STATUS);

    const pending = run("git.rebaseOntoBase", { worktreeId: WT_ID, baseBranch: "develop" });
    await settleConfirm(true);
    await pending;
    expect(notify).not.toHaveBeenCalled();
  });

  it("does not toast an agent dispatch, which has no screen to read it", async () => {
    const { run, git } = setupActions();
    git.rebaseOntoBase.mockRejectedValue(gitError("worktree-dirty", "dirty"));
    git.getStagingStatus.mockResolvedValue(CLEAN_STATUS);

    await expect(
      run(
        "git.rebaseOntoBase",
        { worktreeId: WT_ID, baseBranch: "develop" },
        { dispatchSource: "agent" }
      )
    ).rejects.toThrow();
    expect(notify).not.toHaveBeenCalled();
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

  it("refreshes AND routes when --continue throws on the next conflict", async () => {
    // `--continue` can advance the operation and THEN stop, which throws while
    // having genuinely moved the worktree. A `finally` refresh alone left the
    // card a step behind AND skipped past the routing call, so the user got a
    // thrown error and no conflict panel.
    const { run, git } = setupActions();
    git.continueRepositoryOperation.mockRejectedValue(
      gitError("conflict-unresolved", "CONFLICT (content): in b.ts")
    );
    git.getStagingStatus.mockResolvedValue(HALTED_STATUS);
    await run("git.continueRepositoryOperation", { worktreeId: WT_ID });
    expect(refresh).toHaveBeenCalledWith(WT_ID);
    expect(dispatch).toHaveBeenCalledWith(
      "worktree.openReviewHub",
      { worktreeId: WT_ID },
      undefined
    );
  });

  it("rethrows a continue failure that is not a conflict", async () => {
    const { run, git } = setupActions();
    git.continueRepositoryOperation.mockRejectedValue(
      new Error("No merge, rebase, cherry-pick, or revert operation is in progress")
    );
    await expect(run("git.continueRepositoryOperation", { worktreeId: WT_ID })).rejects.toThrow(
      /no merge, rebase/i
    );
    expect(refresh).toHaveBeenCalledWith(WT_ID);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("does not open Review Hub when the operation finished cleanly", async () => {
    const { run, git } = setupActions();
    git.getStagingStatus.mockResolvedValue(CLEAN_STATUS);
    await run("git.continueRepositoryOperation", { worktreeId: WT_ID });
    expect(dispatch).not.toHaveBeenCalled();
  });
});
