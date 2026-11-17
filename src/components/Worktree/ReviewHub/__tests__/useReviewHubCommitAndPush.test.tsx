/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
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

  function approvePullRebase() {
    useGitPullRebaseConfirmStore.setState({
      requestConfirmation: vi.fn().mockResolvedValue({ confirmed: true, review: REVIEW }),
    });
  }

  it("reports the tip moved as soon as a commit lands, before the push", async () => {
    const order: string[] = [];
    headMoved.mockImplementation((path: string) => order.push(`moved ${path}`));
    push.mockImplementation(async () => {
      order.push("push");
    });
    const { result } = renderPushHook();

    await act(async () => {
      await result.current.handleCommit("first");
    });
    await act(async () => {
      await result.current.handleCommitAndPush("second", OPTED_OUT);
    });
    expect(order).toEqual([`moved ${PATH}`, `moved ${PATH}`, "push"]);
  });

  it("says nothing when the commit fails", async () => {
    commit.mockRejectedValue(new Error("nothing to commit"));
    const { result } = renderPushHook();

    await act(async () => {
      await result.current.handleCommit("msg").catch(() => {});
    });
    expect(headMoved).not.toHaveBeenCalled();
  });

  it("reports the tip moved after a pull with rebase, even one that failed part way", async () => {
    approvePullRebase();
    const { result } = renderPushHook();

    await act(async () => {
      await result.current.confirmPullRebase();
    });
    expect(pullRebase).toHaveBeenCalledWith(PATH, REVIEW);
    expect(headMoved).toHaveBeenCalledTimes(1);

    pullRebase.mockRejectedValueOnce(new Error("CONFLICT (content): Merge conflict in a.ts"));
    await act(async () => {
      await result.current.confirmPullRebase();
    });
    expect(headMoved).toHaveBeenCalledTimes(2);
  });
});
