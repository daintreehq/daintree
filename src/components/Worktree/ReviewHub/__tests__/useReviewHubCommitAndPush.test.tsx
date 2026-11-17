/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, renderHook } from "@testing-library/react";
import type { GitCommitResult } from "@shared/types/git";

vi.mock("@/clients/forgeClient", () => ({
  forgeClient: { classifyPushError: vi.fn().mockResolvedValue(null) },
}));
vi.mock("@/services/ActionService", () => ({ actionService: { dispatch: vi.fn() } }));
vi.mock("@/hooks/useHostConnection", () => ({
  runHostOperation: (_opId: unknown, run: () => Promise<unknown>) => run(),
}));
vi.mock("@/clients/operationsClient", () => ({ mintRemoteOperationId: () => undefined }));

import { useReviewHubCommitAndPush } from "../useReviewHubCommitAndPush";
import { useDiffViewedStore } from "@/store/diffViewedStore";
import { useGitPullRebaseConfirmStore } from "@/store/gitPullRebaseConfirmStore";
import { useGitPushConfirmStore, type GitPushConfirmResult } from "@/store/gitPushConfirmStore";

const PATH = "/repo";
const DESTINATION = { remote: "origin", branch: "feature/x" };
const COMMITTED: GitCommitResult = {
  hash: "abc123",
  summary: "1 changed",
  oid: "abc123".padEnd(40, "0"),
  parentOids: ["f".repeat(40)],
};
const OPTED_OUT = { branch: "feature/x", destination: DESTINATION, reviewed: null };
const REVIEWED_STAGED = "e".repeat(64);
const CONFIRMED = {
  branch: "feature/x",
  destination: DESTINATION,
  reviewed: { headOid: "f".repeat(40), stagedIdentity: REVIEWED_STAGED },
};

const commit = vi.fn();
const push = vi.fn();
const pullRebase = vi.fn();
const headMoved = vi.fn();

function networkDown() {
  return Object.assign(new Error("Could not resolve host: github.com"), {
    name: "GitOperationError",
    gitReason: "network-unavailable",
  });
}

beforeEach(() => {
  commit.mockReset().mockResolvedValue(COMMITTED);
  push.mockReset().mockResolvedValue(undefined);
  pullRebase.mockReset().mockResolvedValue(undefined);
  headMoved.mockReset();
  Object.defineProperty(window, "electron", {
    value: { git: { commit, push, pullRebase, onPushProgress: vi.fn(() => vi.fn()) } },
    writable: true,
    configurable: true,
  });
});

function renderPushHook(
  overrides: {
    setActionError?: (failure: { title: string; detail?: string } | null) => void;
    onCommitted?: (path: string, message: string) => void;
  } = {}
) {
  return renderHook(() =>
    useReviewHubCommitAndPush({
      worktreePath: PATH,
      refresh: () => Promise.resolve(),
      setActionError: overrides.setActionError ?? (() => {}),
      debouncedBgRefreshRef: { current: null },
      onCommitted: overrides.onCommitted ?? (() => {}),
      onHeadMoved: headMoved,
    })
  );
}

describe("useReviewHubCommitAndPush — Retry stays pinned (#16790)", () => {
  it("retries a failed Commit & push under the review of the commit it made", async () => {
    push.mockRejectedValueOnce(networkDown());
    const { result } = renderPushHook();

    await act(() => result.current.handleCommitAndPush("feat: x", OPTED_OUT));
    expect(result.current.pushError?.reason).toBe("network-unavailable");
    await act(() => result.current.handleRetryPush());

    const pinned = { branch: "feature/x", headOid: COMMITTED.oid, destination: DESTINATION };
    expect(push).toHaveBeenCalledTimes(2);
    expect(push).toHaveBeenNthCalledWith(1, PATH, undefined, undefined, pinned);
    expect(push).toHaveBeenNthCalledWith(2, PATH, undefined, undefined, pinned);
  });

  it("never pushes from Retry when no push was approved", async () => {
    const { result } = renderPushHook();

    await act(() => result.current.handleRetryPush());

    expect(push).not.toHaveBeenCalled();
    expect(result.current.pushError?.reason).toBe("push-review-stale");
  });

  it("drops the retained review when the hub resets", async () => {
    push.mockRejectedValueOnce(networkDown());
    const { result } = renderPushHook();
    await act(() => result.current.handleCommitAndPush("feat: x", OPTED_OUT));

    act(() => result.current.reset());
    await act(() => result.current.handleRetryPush());

    expect(push).toHaveBeenCalledTimes(1);
    expect(result.current.pushError?.reason).toBe("push-review-stale");
  });

  it("drops an earlier push's review when a later Commit & push is withheld", async () => {
    push.mockRejectedValueOnce(networkDown());
    const { result } = renderPushHook();
    await act(() => result.current.handleCommitAndPush("feat: first", OPTED_OUT));

    commit.mockResolvedValueOnce({ ...COMMITTED, oid: null, parentOids: [] });
    await act(() => result.current.handleCommitAndPush("feat: second", OPTED_OUT));
    expect(result.current.pushError?.reason).toBe("push-review-stale");
    await act(() => result.current.handleRetryPush());

    expect(commit).toHaveBeenCalledTimes(2);
    expect(push).toHaveBeenCalledTimes(1);
    expect(result.current.pushError?.reason).toBe("push-review-stale");
  });
});

describe("useReviewHubCommitAndPush — tip moves (#17196)", () => {
  const REVIEW = { branch: "feature/x", headOid: "f".repeat(40) };
  const originalRequestConfirmation = useGitPullRebaseConfirmStore.getState().requestConfirmation;

  afterEach(() => {
    useGitPullRebaseConfirmStore.setState({ requestConfirmation: originalRequestConfirmation });
  });

  function approvePullRebase() {
    useGitPullRebaseConfirmStore.setState({
      requestConfirmation: vi.fn().mockResolvedValue({ confirmed: true, review: REVIEW }),
    });
  }

  function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (reason: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject };
  }

  it.each([
    [
      "Commit",
      (hook: ReturnType<typeof renderPushHook>["result"]["current"]) => hook.handleCommit("msg"),
    ],
    [
      "Commit & push",
      (hook: ReturnType<typeof renderPushHook>["result"]["current"]) =>
        hook.handleCommitAndPush("msg", OPTED_OUT),
    ],
  ])("%s reports the tip moved once the commit lands, before any push", async (_, run) => {
    const order: string[] = [];
    headMoved.mockImplementation((path: string) => order.push(`moved ${path}`));
    push.mockImplementation(async () => {
      order.push("push");
    });
    const landed = deferred<GitCommitResult>();
    commit.mockReturnValue(landed.promise);
    const { result } = renderPushHook();

    let done!: Promise<unknown>;
    act(() => {
      done = run(result.current);
    });
    await act(async () => {});
    expect(headMoved).not.toHaveBeenCalled();

    await act(async () => {
      landed.resolve(COMMITTED);
      await done;
    });
    expect(order[0]).toBe(`moved ${PATH}`);
    expect(headMoved).toHaveBeenCalledTimes(1);
  });

  it.each([
    [
      "Commit",
      (hook: ReturnType<typeof renderPushHook>["result"]["current"]) => hook.handleCommit("msg"),
    ],
    [
      "Commit & push",
      (hook: ReturnType<typeof renderPushHook>["result"]["current"]) =>
        hook.handleCommitAndPush("msg", OPTED_OUT),
    ],
  ])("%s says nothing when the commit fails", async (_, run) => {
    commit.mockRejectedValue(new Error("nothing to commit"));
    const { result } = renderPushHook();

    let outcome: unknown;
    await act(async () => {
      outcome = await run(result.current).then(
        () => "resolved",
        (err: unknown) => err
      );
    });
    expect(outcome).toBeInstanceOf(Error);
    expect(headMoved).not.toHaveBeenCalled();
    expect(push).not.toHaveBeenCalled();
  });

  it("reports the tip moved after a pull with rebase, even one that failed part way", async () => {
    approvePullRebase();
    const { result } = renderPushHook();

    const pulled = deferred<void>();
    pullRebase.mockReturnValueOnce(pulled.promise);
    let done!: Promise<void>;
    act(() => {
      done = result.current.confirmPullRebase();
    });
    await act(async () => {});
    expect(pullRebase).toHaveBeenCalledWith(PATH, REVIEW);
    expect(headMoved).not.toHaveBeenCalled();

    await act(async () => {
      pulled.resolve();
      await done;
    });
    expect(headMoved).toHaveBeenCalledTimes(1);
    expect(headMoved).toHaveBeenLastCalledWith(PATH);

    pullRebase.mockRejectedValueOnce(new Error("CONFLICT (content): Merge conflict in a.ts"));
    await act(async () => {
      await result.current.confirmPullRebase();
    });
    expect(headMoved).toHaveBeenCalledTimes(2);
  });
});

describe("useReviewHubCommitAndPush — first commit (#17588)", () => {
  const ROOT: GitCommitResult = { ...COMMITTED, parentOids: [] };
  // Not the root commit's OID: what is pushed is what the review approved,
  // which may include a commit that landed before the review read the branch.
  const FIRST_PUSH = {
    branch: "main",
    headOid: "b".repeat(40),
    destination: { remote: "origin", branch: "main" },
  };
  const APPROVED: GitPushConfirmResult = { confirmed: true, review: FIRST_PUSH };
  const DECLINED: GitPushConfirmResult = { confirmed: false, review: null };
  const originalRequestConfirmation = useGitPushConfirmStore.getState().requestConfirmation;

  afterEach(() => {
    useGitPushConfirmStore.setState({ requestConfirmation: originalRequestConfirmation });
    // A failed assertion must not leave a review pending for the next test.
    useGitPushConfirmStore.getState().resolveConfirmation(null);
  });

  function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((res) => (resolve = res));
    return { promise, resolve };
  }

  function stubReview(answer: () => Promise<GitPushConfirmResult>) {
    const requestConfirmation = vi.fn((_cwd: string, _options?: { yieldToPending?: boolean }) =>
      answer()
    );
    useGitPushConfirmStore.setState({ requestConfirmation });
    return requestConfirmation;
  }

  function renderFirstPushHook(refresh: () => Promise<void> = () => Promise.resolve()) {
    return renderHook(
      ({ path }: { path: string }) =>
        useReviewHubCommitAndPush({
          worktreePath: path,
          refresh,
          setActionError: () => {},
          debouncedBgRefreshRef: { current: null },
          onCommitted: () => {},
          onHeadMoved: headMoved,
        }),
      { initialProps: { path: PATH } }
    );
  }

  it("asks for the push review only after the commit and the refresh both land", async () => {
    const landed = deferred<GitCommitResult>();
    const refreshed = deferred<void>();
    commit.mockReturnValue(landed.promise);
    const requestConfirmation = stubReview(async () => APPROVED);
    const { result } = renderFirstPushHook(() => refreshed.promise);

    let done!: Promise<void>;
    act(() => {
      done = result.current.handleCommitThenReviewPush("Initial commit");
    });
    await act(async () => {});
    // No confirm listed its staged changes, so nothing holds it to them.
    expect(commit).toHaveBeenCalledWith(PATH, "Initial commit", undefined);
    expect(requestConfirmation).not.toHaveBeenCalled();

    await act(async () => landed.resolve(ROOT));
    expect(requestConfirmation).not.toHaveBeenCalled();

    await act(async () => {
      refreshed.resolve();
      await done;
    });
    expect(requestConfirmation).toHaveBeenCalledWith(PATH, { yieldToPending: true });
    expect(push).toHaveBeenCalledTimes(1);
    expect(push).toHaveBeenCalledWith(PATH, undefined, undefined, FIRST_PUSH);
    expect(push).toHaveBeenCalledWith(
      PATH,
      undefined,
      undefined,
      expect.objectContaining({ headOid: "b".repeat(40) })
    );
  });

  it("keeps the commit and pushes nothing when the review is declined", async () => {
    commit.mockResolvedValue(ROOT);
    const requestConfirmation = stubReview(async () => DECLINED);
    const { result } = renderFirstPushHook();

    await act(() => result.current.handleCommitThenReviewPush("Initial commit"));

    expect(commit).toHaveBeenCalledTimes(1);
    expect(requestConfirmation).toHaveBeenCalledTimes(1);
    expect(push).not.toHaveBeenCalled();
    expect(result.current.pushError).toBeNull();
  });

  it("asks for no review when the commit fails", async () => {
    commit.mockRejectedValue(new Error("nothing to commit"));
    const requestConfirmation = stubReview(async () => APPROVED);
    const { result } = renderFirstPushHook();

    let outcome: unknown;
    await act(async () => {
      outcome = await result.current.handleCommitThenReviewPush("Initial commit").then(
        () => "resolved",
        (err: unknown) => err
      );
    });

    expect(outcome).toBeInstanceOf(Error);
    expect(requestConfirmation).not.toHaveBeenCalled();
    expect(push).not.toHaveBeenCalled();
  });

  // The composer stays mounted on this flag: a commit that empties the tree
  // must not take away the place the push's progress shows.
  it("stays in flight through the review and the push, until the push settles", async () => {
    commit.mockResolvedValue(ROOT);
    const review = deferred<GitPushConfirmResult>();
    const pushed = deferred<void>();
    stubReview(() => review.promise);
    push.mockReturnValue(pushed.promise);
    const { result } = renderFirstPushHook();

    let done!: Promise<void>;
    act(() => {
      done = result.current.handleCommitThenReviewPush("Initial commit");
    });
    await act(async () => {});
    expect(result.current.isCommitPushInFlight).toBe(true);
    expect(push).not.toHaveBeenCalled();

    await act(async () => review.resolve(APPROVED));
    expect(push).toHaveBeenCalledTimes(1);
    expect(result.current.isCommitPushInFlight).toBe(true);

    await act(async () => {
      pushed.resolve();
      await done;
    });
    expect(result.current.isCommitPushInFlight).toBe(false);
  });

  // The push confirm holds one request app-wide. A hub that closed or moved
  // on while its commit ran would cancel whatever review is open by then.
  it.each([
    [
      "closed",
      (hook: ReturnType<typeof renderFirstPushHook>) => act(() => hook.result.current.reset()),
    ],
    [
      "moved to another worktree",
      (hook: ReturnType<typeof renderFirstPushHook>) => hook.rerender({ path: "/other" }),
    ],
  ])("leaves the review alone when the hub %s while the commit ran", async (_, leave) => {
    const landed = deferred<GitCommitResult>();
    commit.mockReturnValue(landed.promise);
    const requestConfirmation = stubReview(async () => APPROVED);
    const hook = renderFirstPushHook();

    let done!: Promise<void>;
    act(() => {
      done = hook.result.current.handleCommitThenReviewPush("Initial commit");
    });
    await act(async () => {});
    leave(hook);
    await act(async () => {
      landed.resolve(ROOT);
      await done;
    });

    expect(commit).toHaveBeenCalledTimes(1);
    expect(requestConfirmation).not.toHaveBeenCalled();
    expect(push).not.toHaveBeenCalled();
  });

  it("never takes over a push review opened elsewhere while the commit ran", async () => {
    const landed = deferred<GitCommitResult>();
    commit.mockReturnValue(landed.promise);
    const { result } = renderFirstPushHook();
    let done!: Promise<void>;
    act(() => {
      done = result.current.handleCommitThenReviewPush("Initial commit");
    });
    await act(async () => {});
    let other: GitPushConfirmResult | null = null;
    void useGitPushConfirmStore
      .getState()
      .requestConfirmation("/other")
      .then((answer) => (other = answer));

    await act(async () => landed.resolve(ROOT));
    expect(useGitPushConfirmStore.getState().pendingConfirm?.cwd).toBe("/other");
    await act(() => done);

    expect(commit).toHaveBeenCalledTimes(1);
    expect(useGitPushConfirmStore.getState().pendingConfirm?.cwd).toBe("/other");
    expect(other).toBeNull();
    expect(push).not.toHaveBeenCalled();
    act(() => useGitPushConfirmStore.getState().resolveConfirmation(null));
  });

  it("leaves the review alone when the hub unmounts while the commit ran", async () => {
    const landed = deferred<GitCommitResult>();
    commit.mockReturnValue(landed.promise);
    const requestConfirmation = stubReview(async () => APPROVED);
    const hook = renderFirstPushHook();

    let done!: Promise<void>;
    act(() => {
      done = hook.result.current.handleCommitThenReviewPush("Initial commit");
    });
    await act(async () => {});
    hook.unmount();
    await act(async () => {
      landed.resolve(ROOT);
      await done;
    });

    expect(requestConfirmation).not.toHaveBeenCalled();
  });
});

describe("useReviewHubCommitAndPush — held to the staged changes the confirm listed (#17563)", () => {
  /** What main throws across the bridge for a refused reviewed commit. */
  function commitReviewStale() {
    return new Error(
      "[GitError|commit-review-stale||feature%2Fx] This commit changed after it was reviewed: the staged changes are different. Nothing was committed or pushed. Commit and push again to review what is staged now."
    );
  }

  it("hands the commit the tip and staged changes the confirm reviewed, and pushes when they hold", async () => {
    commit.mockResolvedValueOnce({ ...COMMITTED, stagedIdentity: REVIEWED_STAGED });
    const { result } = renderPushHook();

    await act(() => result.current.handleCommitAndPush("feat: x", CONFIRMED));

    expect(commit).toHaveBeenCalledWith(PATH, "feat: x", {
      branch: "feature/x",
      headOid: "f".repeat(40),
      stagedIdentity: REVIEWED_STAGED,
    });
    expect(push).toHaveBeenCalledWith(PATH, undefined, undefined, {
      branch: "feature/x",
      headOid: COMMITTED.oid,
      destination: DESTINATION,
    });
  });

  it("holds an opted-out commit to nothing", async () => {
    const { result } = renderPushHook();

    await act(() => result.current.handleCommitAndPush("feat: x", OPTED_OUT));

    expect(commit).toHaveBeenCalledWith(PATH, "feat: x", undefined);
    expect(push).toHaveBeenCalledTimes(1);
  });

  it("keeps the draft and says why when main refuses a restaged commit", async () => {
    commit.mockRejectedValueOnce(commitReviewStale());
    const clearViewed = vi.spyOn(useDiffViewedStore.getState(), "clearWorktree");
    const setActionError = vi.fn();
    const onCommitted = vi.fn();
    const { result } = renderPushHook({ setActionError, onCommitted });

    let rethrown: unknown;
    await act(async () => {
      await result.current.handleCommitAndPush("feat: x", CONFIRMED).catch((err: unknown) => {
        rethrown = err;
      });
    });

    // Rethrown with its reason readable, so the composer can tell a refused
    // review from any other failed commit.
    expect(rethrown).toHaveProperty("gitReason", "commit-review-stale");
    expect(push).not.toHaveBeenCalled();
    expect(onCommitted).not.toHaveBeenCalled();
    expect(headMoved).not.toHaveBeenCalled();
    expect(clearViewed).not.toHaveBeenCalled();
    expect(setActionError).toHaveBeenLastCalledWith({
      title: "Couldn't commit changes",
      detail: expect.stringMatching(
        /^This commit changed after it was reviewed: .*Nothing was committed or pushed/
      ),
    });
  });

  it("pushes nothing, then or on Retry, when the commit holds other staged changes than the confirm listed", async () => {
    // An earlier Commit & push whose push failed leaves an approval Retry could use.
    commit.mockResolvedValueOnce({ ...COMMITTED, stagedIdentity: REVIEWED_STAGED });
    push.mockRejectedValueOnce(networkDown());
    commit.mockResolvedValueOnce({ ...COMMITTED, stagedIdentity: "d".repeat(64) });
    const onCommitted = vi.fn();
    const { result } = renderPushHook({ onCommitted });
    await act(() => result.current.handleCommitAndPush("feat: first", CONFIRMED));
    expect(push).toHaveBeenCalledTimes(1);

    let outcome: unknown;
    await act(async () => {
      outcome = await result.current.handleCommitAndPush("feat: x", CONFIRMED);
    });

    // The commit landed, so the draft goes; only the push is withheld.
    expect(outcome).toBe("withheld");
    expect(onCommitted).toHaveBeenLastCalledWith(PATH, "feat: x");
    expect(push).toHaveBeenCalledTimes(1);
    expect(result.current.pushError?.reason).toBe("push-review-stale");
    expect(result.current.pushError?.summary).toMatch(
      /staged changes changed.*Nothing was pushed\.$/
    );
    await act(() => result.current.handleRetryPush());
    expect(push).toHaveBeenCalledTimes(1);
  });

  it("reports a push main refused as stale after a clean commit as withheld", async () => {
    commit.mockResolvedValueOnce({ ...COMMITTED, stagedIdentity: REVIEWED_STAGED });
    push.mockRejectedValueOnce(
      new Error(
        "[GitError|push-review-stale||feature%2Fx] The branch changed since this push was reviewed: 'feature/x' moved to a different commit. Nothing was pushed."
      )
    );
    const { result } = renderPushHook();

    let outcome: unknown;
    await act(async () => {
      outcome = await result.current.handleCommitAndPush("feat: x", CONFIRMED);
    });

    expect(push).toHaveBeenCalledTimes(1);
    expect(outcome).toBe("withheld");
    expect(result.current.pushError?.reason).toBe("push-review-stale");
  });

  it("reports an ordinary push failure after a clean commit as nothing special", async () => {
    commit.mockResolvedValueOnce({ ...COMMITTED, stagedIdentity: REVIEWED_STAGED });
    push.mockRejectedValueOnce(networkDown());
    const { result } = renderPushHook();

    let outcome: unknown = "unset";
    await act(async () => {
      outcome = await result.current.handleCommitAndPush("feat: x", CONFIRMED);
    });

    expect(outcome).toBeUndefined();
    expect(result.current.pushError?.reason).toBe("network-unavailable");
  });

  it("pushes nothing when a host answers a reviewed commit without saying what it holds", async () => {
    const { result } = renderPushHook();

    await act(() => result.current.handleCommitAndPush("feat: x", CONFIRMED));

    expect(push).not.toHaveBeenCalled();
    expect(result.current.pushError?.rawMessage).toMatch(/couldn't be checked/);
  });
});
