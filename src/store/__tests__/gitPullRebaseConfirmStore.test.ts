import { afterEach, describe, expect, it } from "vitest";
import { useGitPullRebaseConfirmStore } from "../gitPullRebaseConfirmStore";

const REVIEW = { branch: "feature/x", headOid: "a".repeat(40) };
const DECLINED = { confirmed: false, review: null };

afterEach(() => {
  if (useGitPullRebaseConfirmStore.getState().pendingConfirm) {
    useGitPullRebaseConfirmStore.getState().resolveConfirmation(null);
  }
});

describe("gitPullRebaseConfirmStore", () => {
  it("resolves an approval with the review it was approved under (#17188)", async () => {
    const pending = useGitPullRebaseConfirmStore.getState().requestConfirmation("/repo");
    expect(useGitPullRebaseConfirmStore.getState().pendingConfirm?.cwd).toBe("/repo");

    useGitPullRebaseConfirmStore.getState().resolveConfirmation(REVIEW);
    await expect(pending).resolves.toEqual({ confirmed: true, review: REVIEW });
    expect(useGitPullRebaseConfirmStore.getState().pendingConfirm).toBeNull();
  });

  it("resolves a decline with no review", async () => {
    const pending = useGitPullRebaseConfirmStore.getState().requestConfirmation("/repo");

    useGitPullRebaseConfirmStore.getState().resolveConfirmation(null);
    await expect(pending).resolves.toEqual(DECLINED);
  });

  it("declines a prior pending request when a new one arrives, even for the same worktree", async () => {
    const first = useGitPullRebaseConfirmStore.getState().requestConfirmation("/repo");
    const second = useGitPullRebaseConfirmStore.getState().requestConfirmation("/repo");

    await expect(first).resolves.toEqual(DECLINED);
    expect(useGitPullRebaseConfirmStore.getState().pendingConfirm?.cwd).toBe("/repo");

    useGitPullRebaseConfirmStore.getState().resolveConfirmation(REVIEW);
    await expect(second).resolves.toEqual({ confirmed: true, review: REVIEW });
  });

  it("resolveConfirmation is a no-op when nothing is pending", () => {
    expect(() => useGitPullRebaseConfirmStore.getState().resolveConfirmation(REVIEW)).not.toThrow();
    expect(useGitPullRebaseConfirmStore.getState().pendingConfirm).toBeNull();
  });

  describe("requestSeq (preview key and ErrorBoundary reset signal, #9918, #17188)", () => {
    it("strictly increases on each request, including back-to-back supersede", () => {
      const before = useGitPullRebaseConfirmStore.getState().requestSeq;

      void useGitPullRebaseConfirmStore.getState().requestConfirmation("/repo-a");
      const afterFirst = useGitPullRebaseConfirmStore.getState().requestSeq;
      expect(afterFirst).toBeGreaterThan(before);

      void useGitPullRebaseConfirmStore.getState().requestConfirmation("/repo-a");
      const afterSecond = useGitPullRebaseConfirmStore.getState().requestSeq;
      expect(afterSecond).toBeGreaterThan(afterFirst);
    });

    it("does not change when a pending request is resolved", () => {
      void useGitPullRebaseConfirmStore.getState().requestConfirmation("/repo");
      const afterRequest = useGitPullRebaseConfirmStore.getState().requestSeq;

      useGitPullRebaseConfirmStore.getState().resolveConfirmation(REVIEW);
      expect(useGitPullRebaseConfirmStore.getState().requestSeq).toBe(afterRequest);
    });
  });
});
