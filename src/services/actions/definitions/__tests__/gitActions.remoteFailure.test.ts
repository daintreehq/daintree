import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const notifyMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/notify", () => ({ notify: notifyMock }));

import { ActionService, actionService } from "@/services/ActionService";
import type { ActionDispatchOptions, ActionId } from "@shared/types/actions";
import type { ActionCallbacks, ActionRegistry } from "../../actionTypes";
import { registerGitActions } from "../gitActions";
// The run bodies load on first dispatch (#14239). Evaluate them before the
// window stub each test installs, as the sibling suites do.
import "../gitActions.impl";
import { useGitPushConfirmStore } from "@/store/gitPushConfirmStore";
import { useGitPullRebaseConfirmStore } from "@/store/gitPullRebaseConfirmStore";
import { useGitForcePushStore } from "@/store/gitForcePushStore";
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
) {
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
function gitError(reason: string, message: string, fields: { lease?: string; branch?: string } = {}) {
  const lease = fields.lease ? encodeURIComponent(fields.lease) : "";
  const branch = fields.branch ? encodeURIComponent(fields.branch) : "";
  return new Error(`[GitError|${reason}|${lease}|${branch}] ${message}`);
}

function onlyToast(): Toast {
  expect(notifyMock).toHaveBeenCalledTimes(1);
  return notifyMock.mock.calls[0]![0] as Toast;
}

beforeEach(() => {
  setWorktreePathIndexAccessor(
    () =>
      new Map([
        [WT_ID, WT_PATH],
        [OTHER_ID, OTHER_PATH],
      ])
  );
  notifyMock.mockClear();
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

  it("offers Pull and rebase for a divergence whose lease could not be read", async () => {
    const { service, git } = setup();
    git.push.mockRejectedValueOnce(
      gitError("push-rejected-outdated", "Updates were rejected", { branch: "feature/x" })
    );

    const dispatched = dispatch(service, "git.push", undefined, { source: "keybinding" });
    await answerPushConfirm(true);
    await dispatched;

    const toast = onlyToast();
    expect(toast.title).not.toBe("Push failed");
    expect(toast.message).not.toContain("[GitError|");
    expect(toast.action?.label).toBe("Pull and rebase");
    toast.action!.onClick();
    expect(recoveryDispatch).toHaveBeenCalledWith(
      "git.pullRebase",
      { cwd: WT_PATH },
      { source: "keybinding" }
    );
  });

  it("never offers a force push off a lease an earlier push captured", async () => {
    // The store is cleared before each push, but the offer must come from this
    // attempt's rejection, so an auth failure can't inherit a stale capture.
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

  it("routes an auth failure to the table's own settings tab", async () => {
    const { service, git } = setup();
    git.push.mockRejectedValueOnce(gitError("auth-failed", "Permission denied"));

    const dispatched = dispatch(service, "git.push", undefined, { source: "keybinding" });
    await answerPushConfirm(true);
    await dispatched;

    const toast = onlyToast();
    expect(toast.action?.label).toBe("Sign in with GitHub");
    toast.action!.onClick();
    const [actionId, args] = recoveryDispatch.mock.calls[0]!;
    expect(actionId).toBe("app.settings.openTab");
    // The table's args, not a worktree location it would have stripped.
    expect(args).toMatchObject({ tab: "code-forge" });
    expect(args).not.toHaveProperty("cwd");
  });

  it("reports an unrouted failure without inventing an action", async () => {
    const { service, git } = setup();
    git.push.mockRejectedValueOnce(gitError("network-unavailable", "Could not resolve host"));

    const dispatched = dispatch(service, "git.push", undefined, { source: "keybinding" });
    await answerPushConfirm(true);
    await dispatched;

    const toast = onlyToast();
    expect(toast.action).toBeUndefined();
    expect(toast.context.worktreeId).toBe(WT_ID);
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
    git.push.mockRejectedValueOnce(gitError("auth-failed", "Permission denied"));

    const result = await dispatch(
      service,
      "git.push",
      { worktreePath: WT_PATH },
      { source: "agent", confirmed: true }
    );

    expect(git.push).toHaveBeenCalled();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain("Permission denied");
    expect(notifyMock).not.toHaveBeenCalled();
  });

  it("raises no toast for a caller that reports the failure itself", async () => {
    const { service, git } = setup();
    git.push.mockRejectedValueOnce(gitError("auth-failed", "Permission denied"));

    const dispatched = dispatch(service, "git.push", undefined, {
      source: "user",
      callerReportsFailure: true,
    });
    await answerPushConfirm(true);
    const result = await dispatched;

    expect(result.ok).toBe(false);
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
    expect(toast.action?.label).toBe("Resolve conflicts");
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

    expect(onlyToast().title).toBe("Pull and rebase failed");
  });

  it("stays silent when the confirm is cancelled", async () => {
    const { service, git } = setup();

    const dispatched = dispatch(service, "git.pullRebase", undefined, { source: "keybinding" });
    await answerPullRebaseConfirm(false);
    await dispatched;

    expect(git.pullRebase).not.toHaveBeenCalled();
    expect(notifyMock).not.toHaveBeenCalled();
  });

  it("raises no toast for an agent", async () => {
    const { service, git } = setup();
    git.pullRebase.mockRejectedValueOnce(gitError("conflict-unresolved", "Merge conflict"));

    const result = await dispatch(
      service,
      "git.pullRebase",
      { worktreePath: WT_PATH },
      { source: "agent", confirmed: true }
    );

    expect(result.ok).toBe(false);
    expect(notifyMock).not.toHaveBeenCalled();
  });
});

describe("git.forcePushWithLease failure (#16667)", () => {
  function seedLease(): void {
    useGitForcePushStore
      .getState()
      .recordRejection({ cwd: WT_PATH, branchName: "feature/x", leaseSha: LEASE });
  }

  it("reports a refused lease and drops it", async () => {
    const { service, git } = setup();
    seedLease();
    git.forcePushWithLease.mockRejectedValueOnce(
      gitError("push-rejected-outdated", "! [rejected] feature/x (stale info)")
    );

    const dispatched = dispatch(service, "git.forcePushWithLease", { cwd: WT_PATH }, {
      source: "menu",
    });
    await answerForcePushConfirm(true);
    const result = await dispatched;

    expect(result.ok).toBe(false);
    expect(useGitForcePushStore.getState().getRecovery(WT_PATH)).toBeNull();
    const toast = onlyToast();
    // Not another force push: the lease it would spend was just disproven.
    expect(toast.action?.label).toBe("Pull and rebase");
  });

  it("reports a force push with no lease to spend", async () => {
    const { service, git } = setup();

    const result = await dispatch(service, "git.forcePushWithLease", { cwd: WT_PATH }, {
      source: "menu",
    });

    expect(result.ok).toBe(false);
    expect(git.forcePushWithLease).not.toHaveBeenCalled();
    const toast = onlyToast();
    expect(toast.title).toBe("Force push failed");
    expect(toast.message).toMatch(/only after a push was rejected/);
  });

  it("reports a lease replaced while the confirm was open", async () => {
    const { service, git } = setup();
    seedLease();

    const dispatched = dispatch(service, "git.forcePushWithLease", { cwd: WT_PATH }, {
      source: "menu",
    });
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

    const dispatched = dispatch(service, "git.forcePushWithLease", { cwd: WT_PATH }, {
      source: "menu",
    });
    await answerForcePushConfirm(false);
    const result = await dispatched;

    expect(result).toMatchObject({ ok: true, result: { forced: false } });
    expect(git.forcePushWithLease).not.toHaveBeenCalled();
    expect(notifyMock).not.toHaveBeenCalled();
  });

  it("leaves a failure to the caller that banners it, such as Review Hub", async () => {
    const { service, git } = setup();
    seedLease();
    git.forcePushWithLease.mockRejectedValueOnce(gitError("network-unavailable", "offline"));

    const dispatched = dispatch(service, "git.forcePushWithLease", { cwd: WT_PATH }, {
      source: "user",
      callerReportsFailure: true,
    });
    await answerForcePushConfirm(true);
    const result = await dispatched;

    expect(result.ok).toBe(false);
    expect(notifyMock).not.toHaveBeenCalled();
    // A transport failure says nothing about the remote, so the lease stays.
    expect(useGitForcePushStore.getState().getRecovery(WT_PATH)).not.toBeNull();
  });
});

describe("toast ownership", () => {
  it("each of the three stands the palette's and the HUD's generic toast down", () => {
    const { service } = setup();
    for (const id of ["git.push", "git.pullRebase", "git.forcePushWithLease"]) {
      expect(service.selfNotifiesOnExecutionError(id as ActionId), id).toBe(true);
    }
  });
});
