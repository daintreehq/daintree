import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const notifyMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/notify", () => ({ notify: notifyMock }));

import { ActionService, actionService } from "@/services/ActionService";
import type { ActionDispatchOptions, ActionDispatchResult, ActionId } from "@shared/types/actions";
import type { GitOperationReason } from "@shared/types/ipc/errors";
import { humanizeAppError } from "@shared/utils/errorMessage";
import { getGitRecoveryAction } from "@shared/utils/gitOperationErrors";
import type { ActionCallbacks, ActionRegistry } from "../../actionTypes";
import { registerGitActions } from "../gitActions";
// The run bodies load on first dispatch (#14239). Evaluate them before the
// window stub each test installs, as the sibling suites do.
import "../gitActions.impl";
import { useGitPushConfirmStore } from "@/store/gitPushConfirmStore";
import { useGitPullRebaseConfirmStore } from "@/store/gitPullRebaseConfirmStore";
import { useGitForcePushStore } from "@/store/gitForcePushStore";
import { useAnnouncerStore } from "@/store/accessibilityAnnouncerStore";
import {
  setWorktreePathIndexAccessor,
  resetStoreAccessorsForTesting,
} from "@/store/storeAccessors";

const WT_ID = "wt-1";
const WT_PATH = "/repo/one";
const OTHER_ID = "wt-2";
const OTHER_PATH = "/repo/two";
const LEASE = "deadbeefcafe";

const PUSH_REVIEW = {
  branch: "feature/x",
  headOid: "e".repeat(40),
  destination: { remote: "origin", branch: "feature/x" },
};

interface GitStub {
  push: ReturnType<typeof vi.fn>;
  pullRebase: ReturnType<typeof vi.fn>;
  forcePushWithLease: ReturnType<typeof vi.fn>;
}

interface Toast {
  type: string;
  title: string;
  message: string;
  context: { worktreeId?: string; eventKind?: string };
  action?: { label: string; onClick: () => void };
}

let recoveryDispatch: ReturnType<typeof vi.spyOn>;

/**
 * A real ActionService with the real git definitions, so each test goes
 * through dispatch's own catch, which is what turns an action's throw into a
 * result nobody reads.
 */
function setup(active: { id?: string; path?: string } = { id: WT_ID, path: WT_PATH }): {
  service: ActionService;
  git: GitStub;
} {
  const actions: ActionRegistry = new Map();
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- git actions read no callbacks
  registerGitActions(actions, {} as unknown as ActionCallbacks);
  const service = new ActionService();
  for (const factory of actions.values()) service.register(factory());
  // A keybinding dispatch carries no args: the action resolves the worktree
  // from the active one, exactly as Cmd+K Cmd+P does.
  service.setContextProvider(() => ({
    activeWorktreeId: active.id,
    activeWorktreePath: active.path,
  }));
  const git: GitStub = {
    push: vi.fn().mockResolvedValue(undefined),
    pullRebase: vi.fn().mockResolvedValue(undefined),
    forcePushWithLease: vi.fn().mockResolvedValue(undefined),
  };
  Object.defineProperty(globalThis, "window", {
    value: { electron: { git } },
    configurable: true,
    writable: true,
  });
  return { service, git };
}

function dispatch(
  service: ActionService,
  id: string,
  args: unknown,
  options: ActionDispatchOptions
): Promise<ActionDispatchResult> {
  return service.dispatch(id as ActionId, args, options);
}

async function answerPushConfirm(ok: boolean): Promise<void> {
  await vi.waitFor(() => {
    expect(useGitPushConfirmStore.getState().pendingConfirm).not.toBeNull();
  });
  useGitPushConfirmStore.getState().resolveConfirmation(ok ? PUSH_REVIEW : null);
}

async function answerPullRebaseConfirm(ok: boolean): Promise<void> {
  await vi.waitFor(() => {
    expect(useGitPullRebaseConfirmStore.getState().pendingConfirm).not.toBeNull();
  });
  useGitPullRebaseConfirmStore.getState().resolveConfirmation(ok);
}

async function answerForcePushConfirm(ok: boolean): Promise<void> {
  await vi.waitFor(() => {
    expect(useGitForcePushStore.getState().pendingConfirm).not.toBeNull();
  });
  const pending = useGitForcePushStore.getState().pendingConfirm!;
  useGitForcePushStore.getState().resolveConfirmation(pending.requestId, ok);
}

/** The error shape the preload reconstructs from a `GitOperationError`. */
function gitError(
  reason: GitOperationReason,
  message: string,
  fields: { lease?: string; branch?: string } = {}
): Error {
  const lease = fields.lease ? encodeURIComponent(fields.lease) : "";
  const branch = fields.branch ? encodeURIComponent(fields.branch) : "";
  return new Error(`[GitError|${reason}|${lease}|${branch}] ${message}`);
}

function onlyToast(): Toast {
  expect(notifyMock).toHaveBeenCalledTimes(1);
  return notifyMock.mock.calls[0]![0] as Toast;
}

/** The copy a classified failure must carry: the translation table's, not a constant. */
function humanized(reason: GitOperationReason): { title: string; body: string } {
  return humanizeAppError({ type: "git", source: "test", message: "", gitReason: reason });
}

/** The failure came out of the IPC this test rejected, not out of something earlier. */
function expectFailedWith(result: ActionDispatchResult, cause: Error): void {
  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.error.code).toBe("EXECUTION_ERROR");
  expect(result.error.details).toBe(cause);
}

beforeEach(() => {
  setWorktreePathIndexAccessor(
    () =>
      new Map([
        [WT_ID, WT_PATH],
        [OTHER_ID, OTHER_PATH],
      ])
  );
  // `notify` hands back the toast's id, or "" when the toast was kept to the inbox.
  notifyMock.mockReset().mockReturnValue("toast-1");
  useAnnouncerStore.setState({ polite: null, assertive: null, nextId: 1 });
  recoveryDispatch = vi.spyOn(actionService, "dispatch").mockResolvedValue({
    ok: true,
    result: undefined,
  });
});

afterEach(() => {
  recoveryDispatch.mockRestore();
  resetStoreAccessorsForTesting();
  Object.defineProperty(globalThis, "window", { value: undefined, configurable: true });
  if (useGitPushConfirmStore.getState().pendingConfirm) {
    useGitPushConfirmStore.getState().resolveConfirmation(null);
  }
  if (useGitPullRebaseConfirmStore.getState().pendingConfirm) {
    useGitPullRebaseConfirmStore.getState().resolveConfirmation(false);
  }
  const forcePending = useGitForcePushStore.getState().pendingConfirm;
  if (forcePending) {
    useGitForcePushStore.getState().resolveConfirmation(forcePending.requestId, false);
  }
  useGitForcePushStore.setState({ recovery: {}, pendingConfirm: null });
});

describe("git.push failure from a keybinding (#16667)", () => {
  it("reports a rejected push with the Force push recovery the card offers", async () => {
    const { service, git } = setup();
    git.push.mockRejectedValueOnce(
      gitError("push-rejected-outdated", "Updates were rejected", {
        lease: LEASE,
        branch: "feature/x",
      })
    );

    const dispatched = dispatch(service, "git.push", undefined, { source: "keybinding" });
    await answerPushConfirm(true);
    const result = await dispatched;

    expect(result.ok).toBe(false);
    const toast = onlyToast();
    expect(toast.type).toBe("error");
    expect(toast.title).toBe("Push failed");
    expect(toast.message).toContain("feature/x");
    expect(toast.context.worktreeId).toBe(WT_ID);
    expect(toast.action?.label).toBe("Force push…");

    // The recovery force pushes the worktree that failed, as the surface the
    // failure came from.
    toast.action!.onClick();
    expect(recoveryDispatch).toHaveBeenCalledWith(
      "git.forcePushWithLease",
      { cwd: WT_PATH },
      { source: "keybinding" }
    );
  });

  it("names the rejected branch and worktree, not the active one's", async () => {
    const { service, git } = setup();
    git.push.mockRejectedValueOnce(
      gitError("push-rejected-outdated", "Updates were rejected", {
        lease: LEASE,
        branch: "release/2",
      })
    );

    const dispatched = dispatch(service, "git.push", { cwd: OTHER_PATH }, { source: "menu" });
    await answerPushConfirm(true);
    await dispatched;

    const toast = onlyToast();
    expect(toast.message).toContain("release/2");
    expect(toast.context.worktreeId).toBe(OTHER_ID);
    toast.action!.onClick();
    expect(recoveryDispatch).toHaveBeenCalledWith(
      "git.forcePushWithLease",
      { cwd: OTHER_PATH },
      { source: "menu" }
    );
  });

  it("offers the table's recovery for a divergence whose lease could not be read", async () => {
    const { service, git } = setup();
    git.push.mockRejectedValueOnce(
      gitError("push-rejected-outdated", "Updates were rejected", { branch: "feature/x" })
    );

    const dispatched = dispatch(service, "git.push", undefined, { source: "keybinding" });
    await answerPushConfirm(true);
    await dispatched;

    const toast = onlyToast();
    const expected = humanized("push-rejected-outdated");
    expect({ title: toast.title, message: toast.message }).toEqual({
      title: expected.title,
      message: expected.body,
    });
    const recovery = getGitRecoveryAction("push-rejected-outdated")!;
    expect(toast.action?.label).toBe(recovery.label);
    toast.action!.onClick();
    expect(recoveryDispatch).toHaveBeenCalledWith(
      recovery.actionId,
      { cwd: WT_PATH },
      { source: "keybinding" }
    );
  });

  it("never offers a force push off a lease an earlier push captured", async () => {
    // The store is cleared before each push, so the lease is recorded inside
    // the IPC: reading the store instead of this attempt's rejection would
    // find it and offer a force push for an auth failure.
    const { service, git } = setup();
    git.push.mockImplementationOnce(async () => {
      useGitForcePushStore
        .getState()
        .recordRejection({ cwd: WT_PATH, branchName: "feature/x", leaseSha: LEASE });
      throw gitError("auth-failed", "Permission denied");
    });

    const dispatched = dispatch(service, "git.push", undefined, { source: "keybinding" });
    await answerPushConfirm(true);
    await dispatched;

    expect(onlyToast().action?.label).not.toBe("Force push…");
  });

  it("routes an auth failure with the table's own args, never a worktree location", async () => {
    const { service, git } = setup();
    git.push.mockRejectedValueOnce(gitError("auth-failed", "Permission denied"));

    const dispatched = dispatch(service, "git.push", undefined, { source: "keybinding" });
    await answerPushConfirm(true);
    await dispatched;

    const toast = onlyToast();
    expect(toast.title).toBe(humanized("auth-failed").title);
    const recovery = getGitRecoveryAction("auth-failed")!;
    expect(recovery.args).toBeDefined();
    expect(toast.action?.label).toBe(recovery.label);
    toast.action!.onClick();
    expect(recoveryDispatch).toHaveBeenCalledWith(recovery.actionId, recovery.args, {
      source: "keybinding",
    });
  });

  it("reports an unrouted failure in the table's words, without inventing an action", async () => {
    const { service, git } = setup();
    git.push.mockRejectedValueOnce(gitError("network-unavailable", "Could not resolve host"));

    const dispatched = dispatch(service, "git.push", undefined, { source: "keybinding" });
    await answerPushConfirm(true);
    await dispatched;

    const toast = onlyToast();
    const expected = humanized("network-unavailable");
    expect(toast.title).toBe(expected.title);
    expect(toast.message).toBe(expected.body);
    expect(toast.action).toBeUndefined();
    expect(toast.context.worktreeId).toBe(WT_ID);
  });

  it("names the push and git's own sentence for a failure classified as unknown", async () => {
    const { service, git } = setup();
    git.push.mockRejectedValueOnce(gitError("unknown", "remote: internal server error"));

    const dispatched = dispatch(service, "git.push", undefined, { source: "keybinding" });
    await answerPushConfirm(true);
    await dispatched;

    const toast = onlyToast();
    expect(toast.title).toBe("Push failed");
    expect(toast.message).toBe("remote: internal server error");
    expect(toast.action).toBeUndefined();
  });

  it("names the push and the thrown cause for a failure with no git reason", async () => {
    const { service, git } = setup();
    git.push.mockRejectedValueOnce(new Error("The remote hung up unexpectedly"));

    const dispatched = dispatch(service, "git.push", undefined, { source: "keybinding" });
    await answerPushConfirm(true);
    await dispatched;

    const toast = onlyToast();
    expect(toast.title).toBe("Push failed");
    expect(toast.message).toBe("The remote hung up unexpectedly");
  });

  it("reports a push with no worktree to run in, before any confirm", async () => {
    // The definition stands the palette's generic toast down, so a throw from
    // worktree resolution must be reported here or nowhere.
    const { service, git } = setup({});

    const result = await dispatch(service, "git.push", undefined, { source: "keybinding" });

    expect(result.ok).toBe(false);
    expect(git.push).not.toHaveBeenCalled();
    expect(useGitPushConfirmStore.getState().pendingConfirm).toBeNull();
    const toast = onlyToast();
    expect(toast.title).toBe("Push failed");
    expect(toast.message).toMatch(/no active worktree/i);
    expect(toast.action).toBeUndefined();
  });

  it("stays silent when the confirm is cancelled", async () => {
    const { service, git } = setup();

    const dispatched = dispatch(service, "git.push", undefined, { source: "keybinding" });
    await answerPushConfirm(false);
    const result = await dispatched;

    expect(result.ok).toBe(true);
    expect(git.push).not.toHaveBeenCalled();
    expect(notifyMock).not.toHaveBeenCalled();
  });

  it("raises no toast for an agent, which still gets the error as its result", async () => {
    const { service, git } = setup();
    const cause = gitError("auth-failed", "Permission denied");
    git.push.mockRejectedValueOnce(cause);

    const result = await dispatch(
      service,
      "git.push",
      { worktreePath: WT_PATH },
      { source: "agent", confirmed: true }
    );

    expect(git.push).toHaveBeenCalled();
    expectFailedWith(result, cause);
    expect(notifyMock).not.toHaveBeenCalled();
  });

  it("raises no toast for a caller that reports the failure itself", async () => {
    const { service, git } = setup();
    const cause = gitError("auth-failed", "Permission denied");
    git.push.mockRejectedValueOnce(cause);

    const dispatched = dispatch(service, "git.push", undefined, {
      source: "user",
      callerReportsFailure: true,
    });
    await answerPushConfirm(true);
    const result = await dispatched;

    expect(git.push).toHaveBeenCalled();
    expectFailedWith(result, cause);
    expect(notifyMock).not.toHaveBeenCalled();
  });

  it("is not silenced by a context that claims the caller reports it", async () => {
    const { service, git } = setup();
    git.push.mockRejectedValueOnce(gitError("auth-failed", "Permission denied"));

    const dispatched = dispatch(service, "git.push", undefined, {
      source: "user",
      contextOverride: {
        activeWorktreeId: WT_ID,
        activeWorktreePath: WT_PATH,
        callerReportsFailure: true,
      },
    });
    await answerPushConfirm(true);
    await dispatched;

    expect(notifyMock).toHaveBeenCalledTimes(1);
  });
});

describe("git.pullRebase failure (#16667)", () => {
  it("reports a conflict with Review Hub for the worktree that failed, not the active one", async () => {
    const { service, git } = setup();
    git.pullRebase.mockRejectedValueOnce(gitError("conflict-unresolved", "Merge conflict"));

    const dispatched = dispatch(
      service,
      "git.pullRebase",
      { cwd: OTHER_PATH },
      { source: "context-menu" }
    );
    await answerPullRebaseConfirm(true);
    const result = await dispatched;

    expect(result.ok).toBe(false);
    const toast = onlyToast();
    expect(toast.context.worktreeId).toBe(OTHER_ID);
    const recovery = getGitRecoveryAction("conflict-unresolved")!;
    expect(recovery.actionId).toBe("worktree.openReviewHub");
    expect(toast.action?.label).toBe(recovery.label);
    // `worktree.openReviewHub` strips a `cwd`, so it must get the id.
    toast.action!.onClick();
    expect(recoveryDispatch).toHaveBeenCalledWith(
      "worktree.openReviewHub",
      { worktreeId: OTHER_ID },
      { source: "context-menu" }
    );
  });

  it("names the operation for a failure with no git reason", async () => {
    const { service, git } = setup();
    git.pullRebase.mockRejectedValueOnce(new Error("fatal: no upstream configured"));

    const dispatched = dispatch(service, "git.pullRebase", undefined, { source: "keybinding" });
    await answerPullRebaseConfirm(true);
    await dispatched;

    const toast = onlyToast();
    expect(toast.title).toBe("Pull and rebase failed");
    expect(toast.message).toBe("fatal: no upstream configured");
  });

  it("reports a pull-rebase with no worktree to run in, before any confirm", async () => {
    const { service, git } = setup({});

    const result = await dispatch(service, "git.pullRebase", undefined, { source: "keybinding" });

    expect(result.ok).toBe(false);
    expect(git.pullRebase).not.toHaveBeenCalled();
    expect(useGitPullRebaseConfirmStore.getState().pendingConfirm).toBeNull();
    const toast = onlyToast();
    expect(toast.title).toBe("Pull and rebase failed");
    expect(toast.message).toMatch(/no active worktree/i);
  });

  it("stays silent when the confirm is cancelled", async () => {
    const { service, git } = setup();

    const dispatched = dispatch(service, "git.pullRebase", undefined, { source: "keybinding" });
    await answerPullRebaseConfirm(false);
    const result = await dispatched;

    expect(result.ok).toBe(true);
    expect(git.pullRebase).not.toHaveBeenCalled();
    expect(notifyMock).not.toHaveBeenCalled();
  });

  it("raises no toast for an agent, which still gets the error as its result", async () => {
    const { service, git } = setup();
    const cause = gitError("conflict-unresolved", "Merge conflict");
    git.pullRebase.mockRejectedValueOnce(cause);

    const result = await dispatch(
      service,
      "git.pullRebase",
      { worktreePath: WT_PATH },
      { source: "agent", confirmed: true }
    );

    expect(git.pullRebase).toHaveBeenCalledWith(WT_PATH);
    expectFailedWith(result, cause);
    expect(notifyMock).not.toHaveBeenCalled();
  });
});

describe("git.forcePushWithLease failure (#16667)", () => {
  function seedLease(): void {
    useGitForcePushStore
      .getState()
      .recordRejection({ cwd: WT_PATH, branchName: "feature/x", leaseSha: LEASE });
  }

  it("reports a refused lease in git's words, drops it, and offers no second force push", async () => {
    const { service, git } = setup();
    seedLease();
    // A refused lease is git's `(stale info)`, which no reason pattern claims.
    const cause = gitError("unknown", "! [rejected] feature/x -> feature/x (stale info)");
    git.forcePushWithLease.mockRejectedValueOnce(cause);

    const dispatched = dispatch(
      service,
      "git.forcePushWithLease",
      { cwd: WT_PATH },
      { source: "menu" }
    );
    await answerForcePushConfirm(true);
    const result = await dispatched;

    expectFailedWith(result, cause);
    expect(useGitForcePushStore.getState().getRecovery(WT_PATH)).toBeNull();
    const toast = onlyToast();
    expect(toast.title).toBe("Force push failed");
    expect(toast.message).toBe("! [rejected] feature/x -> feature/x (stale info)");
    expect(toast.action).toBeUndefined();
  });

  it("routes a force push the remote refused as out of date to the table's recovery", async () => {
    const { service, git } = setup();
    seedLease();
    git.forcePushWithLease.mockRejectedValueOnce(
      gitError("push-rejected-outdated", "! [rejected] feature/x (fetch first)")
    );

    const dispatched = dispatch(
      service,
      "git.forcePushWithLease",
      { cwd: WT_PATH },
      { source: "menu" }
    );
    await answerForcePushConfirm(true);
    await dispatched;

    const recovery = getGitRecoveryAction("push-rejected-outdated")!;
    const toast = onlyToast();
    expect(toast.action?.label).toBe(recovery.label);
    toast.action!.onClick();
    expect(recoveryDispatch).toHaveBeenCalledWith(
      recovery.actionId,
      { cwd: WT_PATH },
      { source: "menu" }
    );
  });

  it("reports a force push with no lease to spend", async () => {
    const { service, git } = setup();

    const result = await dispatch(
      service,
      "git.forcePushWithLease",
      { cwd: WT_PATH },
      { source: "menu" }
    );

    expect(result.ok).toBe(false);
    expect(git.forcePushWithLease).not.toHaveBeenCalled();
    const toast = onlyToast();
    expect(toast.title).toBe("Force push failed");
    expect(toast.message).toMatch(/only after a push was rejected/);
  });

  it("reports a force push with no worktree to run in", async () => {
    const { service, git } = setup({});

    const result = await dispatch(service, "git.forcePushWithLease", undefined, {
      source: "menu",
    });

    expect(result.ok).toBe(false);
    expect(git.forcePushWithLease).not.toHaveBeenCalled();
    expect(onlyToast().message).toMatch(/no active worktree/i);
  });

  it("reports a lease replaced while the confirm was open", async () => {
    const { service, git } = setup();
    seedLease();

    const dispatched = dispatch(
      service,
      "git.forcePushWithLease",
      { cwd: WT_PATH },
      { source: "menu" }
    );
    await vi.waitFor(() => {
      expect(useGitForcePushStore.getState().pendingConfirm).not.toBeNull();
    });
    seedLease();
    await answerForcePushConfirm(true);
    await dispatched;

    expect(git.forcePushWithLease).not.toHaveBeenCalled();
    expect(onlyToast().title).toBe("Force push failed");
  });

  it("stays silent when the confirm is declined", async () => {
    const { service, git } = setup();
    seedLease();

    const dispatched = dispatch(
      service,
      "git.forcePushWithLease",
      { cwd: WT_PATH },
      { source: "menu" }
    );
    await answerForcePushConfirm(false);
    const result = await dispatched;

    expect(result).toMatchObject({ ok: true, result: { forced: false } });
    expect(git.forcePushWithLease).not.toHaveBeenCalled();
    expect(notifyMock).not.toHaveBeenCalled();
  });

  it("leaves a failure to the caller that banners it, such as Review Hub", async () => {
    const { service, git } = setup();
    seedLease();
    const cause = gitError("network-unavailable", "offline");
    git.forcePushWithLease.mockRejectedValueOnce(cause);

    const dispatched = dispatch(
      service,
      "git.forcePushWithLease",
      { cwd: WT_PATH },
      { source: "user", callerReportsFailure: true }
    );
    await answerForcePushConfirm(true);
    const result = await dispatched;

    expect(git.forcePushWithLease).toHaveBeenCalledWith(WT_PATH, "feature/x", LEASE);
    expectFailedWith(result, cause);
    expect(notifyMock).not.toHaveBeenCalled();
    // The banner is the caller's alert, so nothing is announced on top of it.
    expect(useAnnouncerStore.getState().assertive).toBeNull();
  });

  it("says a failed force push aloud when its toast was kept to the inbox", async () => {
    // Quiet hours, disabled toasts and a blurred window all route to the inbox,
    // and `notify` hands back no toast id then.
    notifyMock.mockReturnValue("");
    const { service, git } = setup();
    seedLease();
    git.forcePushWithLease.mockRejectedValueOnce(gitError("network-unavailable", "offline"));

    const dispatched = dispatch(
      service,
      "git.forcePushWithLease",
      { cwd: WT_PATH },
      { source: "menu" }
    );
    await answerForcePushConfirm(true);
    await dispatched;

    expect(notifyMock).toHaveBeenCalledTimes(1);
    expect(useAnnouncerStore.getState().assertive?.msg).toContain("feature/x");
  });

  it("leaves a toasted failure to the toast's own alert", async () => {
    const { service, git } = setup();
    seedLease();
    git.forcePushWithLease.mockRejectedValueOnce(gitError("network-unavailable", "offline"));

    const dispatched = dispatch(
      service,
      "git.forcePushWithLease",
      { cwd: WT_PATH },
      { source: "menu" }
    );
    await answerForcePushConfirm(true);
    await dispatched;

    expect(notifyMock).toHaveBeenCalledTimes(1);
    expect(useAnnouncerStore.getState().assertive).toBeNull();
  });
});
