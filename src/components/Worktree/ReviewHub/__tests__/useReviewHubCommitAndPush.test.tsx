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
import { useGitPullRebaseConfirmStore } from "@/store/gitPullRebaseConfirmStore";
import { useGitPushConfirmStore } from "@/store/gitPushConfirmStore";

const PATH = "/repo";
const DESTINATION = { remote: "origin", branch: "feature/x" };
const COMMITTED: GitCommitResult = {
  hash: "abc123",
  summary: "1 changed",
  oid: "abc123".padEnd(40, "0"),
  parentOids: ["f".repeat(40)],
};
const OPTED_OUT = { branch: "feature/x", destination: DESTINATION, reviewedHeadOid: null };

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

function renderPushHook() {
  return renderHook(() =>
    useReviewHubCommitAndPush({
      worktreePath: PATH,
      refresh: () => Promise.resolve(),
      setActionError: () => {},
      debouncedBgRefreshRef: { current: null },
      onCommitted: () => {},
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
  const FIRST_PUSH = {
    branch: "main",
    headOid: ROOT.oid!,
    destination: { remote: "origin", branch: "main" },
  };
  const originalRequestConfirmation = useGitPushConfirmStore.getState().requestConfirmation;

  afterEach(() => {
    useGitPushConfirmStore.setState({ requestConfirmation: originalRequestConfirmation });
  });

  function reviewPush(result: Awaited<ReturnType<typeof originalRequestConfirmation>>) {
    const order: string[] = [];
    commit.mockImplementation(async () => {
      order.push("commit");
      return ROOT;
    });
    const requestConfirmation = vi.fn(async (cwd: string) => {
      order.push(`review ${cwd}`);
      return result;
    });
    useGitPushConfirmStore.setState({ requestConfirmation });
    return { order, requestConfirmation };
  }

  it("reviews the push only once the commit has landed, and pushes what the review approved", async () => {
    const { order } = reviewPush({ confirmed: true, review: FIRST_PUSH });
    const { result } = renderPushHook();

    await act(() => result.current.handleCommitThenReviewPush("Initial commit"));

    expect(commit).toHaveBeenCalledWith(PATH, "Initial commit");
    expect(order).toEqual(["commit", `review ${PATH}`]);
    expect(push).toHaveBeenCalledWith(PATH, undefined, undefined, FIRST_PUSH);
    expect(result.current.isCommitPushInFlight).toBe(false);
  });

  it("keeps the commit and pushes nothing when the review is declined", async () => {
    reviewPush({ confirmed: false, review: null });
    const { result } = renderPushHook();

    await act(() => result.current.handleCommitThenReviewPush("Initial commit"));

    expect(commit).toHaveBeenCalledTimes(1);
    expect(push).not.toHaveBeenCalled();
    expect(result.current.pushError).toBeNull();
  });

  it("asks for no review when the commit fails", async () => {
    const { requestConfirmation } = reviewPush({ confirmed: true, review: FIRST_PUSH });
    commit.mockRejectedValue(new Error("nothing to commit"));
    const { result } = renderPushHook();

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

  // The composer stays mounted on this flag, so a review that empties the
  // tree must not unmount it before the push's progress has somewhere to show.
  it("holds the composer in flight while the push review is open", async () => {
    let approve!: (value: Awaited<ReturnType<typeof originalRequestConfirmation>>) => void;
    commit.mockResolvedValue(ROOT);
    useGitPushConfirmStore.setState({
      requestConfirmation: vi.fn(() => new Promise((resolve) => (approve = resolve))),
    });
    const { result } = renderPushHook();

    let done!: Promise<void>;
    act(() => {
      done = result.current.handleCommitThenReviewPush("Initial commit");
    });
    await act(async () => {});
    expect(result.current.isCommitPushInFlight).toBe(true);

    await act(async () => {
      approve({ confirmed: true, review: FIRST_PUSH });
      await done;
    });
    expect(result.current.isCommitPushInFlight).toBe(false);
    expect(push).toHaveBeenCalledTimes(1);
  });
});
