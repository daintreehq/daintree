import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ActionCallbacks, ActionRegistry, AnyActionDefinition } from "../../actionTypes";
import { registerGitActions } from "../gitActions";
import { useGitPullRebaseConfirmStore } from "@/store/gitPullRebaseConfirmStore";
import {
  setWorktreePathIndexAccessor,
  resetStoreAccessorsForTesting,
} from "@/store/storeAccessors";

const dispatch = vi.hoisted(() => vi.fn().mockResolvedValue({ ok: true }));
vi.mock("@/services/ActionService", () => ({ actionService: { dispatch } }));

const refresh = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock("@/clients", () => ({ worktreeClient: { refresh } }));

const notify = vi.hoisted(() => vi.fn<(toast: Toast) => string>().mockReturnValue("toast-1"));
vi.mock("@/lib/notify", () => ({ notify }));

const WT_ID = "wt-1";
const WT_PATH = "/repo/one";
const REVIEW = { branch: "feature/x", headOid: "f".repeat(40) };

const CLEAN_STATUS = { repoState: "CLEAN", staged: [], unstaged: [] };
const HALTED_STATUS = { repoState: "REBASING", staged: [], unstaged: [] };

interface GitStub {
  pullRebase: ReturnType<typeof vi.fn>;
  getStagingStatus: ReturnType<typeof vi.fn>;
}

interface Toast {
  title: string;
  message: string;
  context: { worktreeId?: string };
  action?: { label: string; onClick: () => void };
}

function setupActions() {
  const actions: ActionRegistry = new Map();
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- git actions read no callbacks
  registerGitActions(actions, {} as unknown as ActionCallbacks);
  const git: GitStub = {
    pullRebase: vi.fn().mockResolvedValue(undefined),
    getStagingStatus: vi.fn().mockResolvedValue(CLEAN_STATUS),
  };

  const run = (args?: unknown, ctx?: Record<string, unknown>): Promise<unknown> => {
    const factory = actions.get("git.pullRebase");
    if (!factory) throw new Error("missing git.pullRebase");
    const def = factory() as AnyActionDefinition;
    Object.defineProperty(globalThis, "window", {
      value: { electron: { git } },
      configurable: true,
      writable: true,
    });
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- union parameter is `never`
    return def.run(args, (ctx ?? {}) as never) as Promise<unknown>;
  };

  return { git, run };
}

/** Resolve the deferred confirm the way a mounted dialog would. */
async function settleConfirm(review: typeof REVIEW | null): Promise<void> {
  await vi.waitFor(() => {
    expect(useGitPullRebaseConfirmStore.getState().pendingConfirm).not.toBeNull();
  });
  useGitPullRebaseConfirmStore.getState().resolveConfirmation(review);
}

/** A rejection shaped like one that crossed the contextBridge. */
function gitError(reason: string, message: string): Error {
  return new Error(`[GitError|${reason}||] ${message}`);
}

function callOrder(mock: ReturnType<typeof vi.fn>): number {
  expect(mock).toHaveBeenCalled();
  return mock.mock.invocationCallOrder[0]!;
}

beforeEach(() => {
  dispatch.mockReset();
  dispatch.mockResolvedValue({ ok: true });
  refresh.mockReset();
  refresh.mockResolvedValue(undefined);
  notify.mockReset();
  notify.mockReturnValue("toast-1");
  setWorktreePathIndexAccessor(() => new Map([[WT_ID, WT_PATH]]));
});

afterEach(() => {
  resetStoreAccessorsForTesting();
  Object.defineProperty(globalThis, "window", { value: undefined, configurable: true });
  if (useGitPullRebaseConfirmStore.getState().pendingConfirm) {
    useGitPullRebaseConfirmStore.getState().resolveConfirmation(null);
  }
});

describe("git.pullRebase refreshes and routes like a base integration (#17188)", () => {
  it("pulls under the review the confirm approved, then refreshes the worktree", async () => {
    const { run, git } = setupActions();
    const pending = run({ worktreeId: WT_ID });
    await settleConfirm(REVIEW);
    await pending;

    expect(git.pullRebase).toHaveBeenCalledWith(WT_PATH, REVIEW);
    expect(refresh).toHaveBeenCalledWith(WT_ID);
    expect(callOrder(refresh)).toBeGreaterThan(callOrder(git.pullRebase));
    expect(notify).not.toHaveBeenCalled();
  });

  it("refreshes the worktree a cwd names, not the active one", async () => {
    const { run } = setupActions();
    setWorktreePathIndexAccessor(
      () =>
        new Map([
          [WT_ID, WT_PATH],
          ["wt-2", "/repo/two"],
        ])
    );
    const pending = run({ cwd: "/repo/two" }, { activeWorktreeId: WT_ID });
    await settleConfirm(REVIEW);
    await pending;

    expect(refresh).toHaveBeenCalledWith("wt-2");
    expect(refresh).not.toHaveBeenCalledWith(WT_ID);
  });

  it("neither pulls nor refreshes when the confirm is declined", async () => {
    const { run, git } = setupActions();
    const pending = run({ worktreeId: WT_ID });
    await settleConfirm(null);
    await pending;

    expect(git.pullRebase).not.toHaveBeenCalled();
    expect(refresh).not.toHaveBeenCalled();
  });

  it("refreshes nothing when there is no worktree to pull in", async () => {
    const { run, git } = setupActions();

    await expect(run({ worktreeId: "missing" })).rejects.toThrow();

    expect(git.pullRebase).not.toHaveBeenCalled();
    expect(refresh).not.toHaveBeenCalled();
  });

  it("refreshes, then opens Review Hub instead of a toast when the rebase halts", async () => {
    const { run, git } = setupActions();
    git.pullRebase.mockRejectedValue(
      gitError("conflict-unresolved", "CONFLICT (content): Merge conflict in a.ts")
    );
    git.getStagingStatus.mockResolvedValue(HALTED_STATUS);

    const pending = run({ worktreeId: WT_ID }, { dispatchSource: "context-menu" });
    await settleConfirm(REVIEW);
    await pending;

    expect(refresh).toHaveBeenCalledWith(WT_ID);
    expect(dispatch).toHaveBeenCalledWith(
      "worktree.openReviewHub",
      { worktreeId: WT_ID },
      { source: "context-menu" }
    );
    expect(callOrder(dispatch)).toBeGreaterThan(callOrder(refresh));
    expect(notify).not.toHaveBeenCalled();
  });

  it("still reports and rethrows when Review Hub didn't open", async () => {
    // A panel that never opened can't stand in for the error; swallowing it
    // would turn a halted rebase into a silent success.
    const { run, git } = setupActions();
    git.pullRebase.mockRejectedValue(gitError("conflict-unresolved", "Merge conflict"));
    git.getStagingStatus.mockResolvedValue(HALTED_STATUS);
    dispatch.mockResolvedValue({ ok: false, error: { code: "NOT_FOUND", message: "no" } });

    const pending = run({ worktreeId: WT_ID });
    await settleConfirm(REVIEW);
    await expect(pending).rejects.toThrow(/Merge conflict/);

    expect(refresh).toHaveBeenCalledWith(WT_ID);
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it("reports a conflict refusal that halted nothing rather than opening a panel", async () => {
    const { run, git } = setupActions();
    git.pullRebase.mockRejectedValue(gitError("conflict-unresolved", "Merge conflict"));
    git.getStagingStatus.mockResolvedValue(CLEAN_STATUS);

    const pending = run({ worktreeId: WT_ID });
    await settleConfirm(REVIEW);
    await expect(pending).rejects.toThrow(/Merge conflict/);

    expect(refresh).toHaveBeenCalledWith(WT_ID);
    expect(dispatch).not.toHaveBeenCalled();
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it("reports a stale preview with a fresh pull, never a conflict panel", async () => {
    // Correlated on the reason, not inferred from state: an agent mid-rebase in
    // its own PTY must not turn a refused pull into a conflict panel.
    const { run, git } = setupActions();
    git.pullRebase.mockRejectedValue(
      gitError(
        "pull-rebase-review-stale",
        "The branch changed since this pull and rebase was previewed: 'feature/x' moved to a different commit."
      )
    );
    git.getStagingStatus.mockResolvedValue(HALTED_STATUS);

    const pending = run({ worktreeId: WT_ID }, { dispatchSource: "keybinding" });
    await settleConfirm(REVIEW);
    await expect(pending).rejects.toThrow(/previewed/);

    expect(refresh).toHaveBeenCalledWith(WT_ID);
    expect(dispatch).not.toHaveBeenCalledWith(
      "worktree.openReviewHub",
      expect.anything(),
      expect.anything()
    );
    const toast = notify.mock.calls[0]![0];
    expect(toast.context.worktreeId).toBe(WT_ID);
    expect(toast.action?.label).toBe("Pull and rebase");
    // The recovery asks again, through a fresh confirm, for the same worktree.
    toast.action!.onClick();
    expect(dispatch).toHaveBeenCalledWith(
      "git.pullRebase",
      { cwd: WT_PATH },
      { source: "keybinding" }
    );
  });

  it("hands an agent its halt as the result, without opening a panel", async () => {
    const { run, git } = setupActions();
    const cause = gitError("conflict-unresolved", "Merge conflict");
    git.pullRebase.mockRejectedValue(cause);
    git.getStagingStatus.mockResolvedValue(HALTED_STATUS);

    await expect(run({ worktreeId: WT_ID }, { dispatchSource: "agent" })).rejects.toBe(cause);

    // Unpinned: no renderer confirm previewed an agent's pull.
    expect(git.pullRebase).toHaveBeenCalledWith(WT_PATH, undefined);
    expect(refresh).toHaveBeenCalledWith(WT_ID);
    expect(dispatch).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
  });
});
