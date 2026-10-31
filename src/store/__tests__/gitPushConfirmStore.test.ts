import { afterEach, describe, expect, it } from "vitest";
import type { GitPushReview } from "@shared/types/git";
import { useGitPushConfirmStore } from "../gitPushConfirmStore";

const review = (branch: string): GitPushReview => ({
  branch,
  headOid: "a".repeat(40),
  destination: { remote: "origin", branch },
});

afterEach(() => {
  // Resolve any leaked pending request so it can't bleed into the next test.
  if (useGitPushConfirmStore.getState().pendingConfirm) {
    useGitPushConfirmStore.getState().resolveConfirmation(null);
  }
});

describe("gitPushConfirmStore", () => {
  it("resolves the awaited Promise with the review the approval carried", async () => {
    const { requestConfirmation } = useGitPushConfirmStore.getState();
    const pending = requestConfirmation("/repo");

    expect(useGitPushConfirmStore.getState().pendingConfirm?.cwd).toBe("/repo");

    const shown = review("topic");
    useGitPushConfirmStore.getState().resolveConfirmation(shown);
    await expect(pending).resolves.toEqual({ confirmed: true, review: shown });
    expect(useGitPushConfirmStore.getState().pendingConfirm).toBeNull();
  });

  it("resolves a decline with no review", async () => {
    const pending = useGitPushConfirmStore.getState().requestConfirmation("/repo");

    useGitPushConfirmStore.getState().resolveConfirmation(null);

    await expect(pending).resolves.toEqual({ confirmed: false, review: null });
  });

  it("cancels a prior pending request (declined, no review) when a new one arrives", async () => {
    const first = useGitPushConfirmStore.getState().requestConfirmation("/repo-a");
    const second = useGitPushConfirmStore.getState().requestConfirmation("/repo-b");

    await expect(first).resolves.toEqual({ confirmed: false, review: null });
    expect(useGitPushConfirmStore.getState().pendingConfirm?.cwd).toBe("/repo-b");

    // The second request's approval belongs to it alone.
    const shown = review("other");
    useGitPushConfirmStore.getState().resolveConfirmation(shown);
    await expect(second).resolves.toEqual({ confirmed: true, review: shown });
  });

  it("resolveConfirmation is a no-op when nothing is pending", () => {
    expect(() =>
      useGitPushConfirmStore.getState().resolveConfirmation(review("topic"))
    ).not.toThrow();
    expect(useGitPushConfirmStore.getState().pendingConfirm).toBeNull();
  });

  describe("requestSeq (ErrorBoundary reset signal, #9918)", () => {
    it("strictly increases on each request, including back-to-back supersede", () => {
      const before = useGitPushConfirmStore.getState().requestSeq;

      useGitPushConfirmStore.getState().requestConfirmation("/repo-a");
      const afterFirst = useGitPushConfirmStore.getState().requestSeq;
      expect(afterFirst).toBeGreaterThan(before);

      // Supersede without resolving in between — `pendingConfirm` never returns
      // to null, so a boolean toggle would miss this; the counter must still move.
      useGitPushConfirmStore.getState().requestConfirmation("/repo-b");
      const afterSecond = useGitPushConfirmStore.getState().requestSeq;
      expect(afterSecond).toBeGreaterThan(afterFirst);
    });

    it("does not change when a pending request is resolved", () => {
      useGitPushConfirmStore.getState().requestConfirmation("/repo");
      const afterRequest = useGitPushConfirmStore.getState().requestSeq;

      useGitPushConfirmStore.getState().resolveConfirmation(review("topic"));
      expect(useGitPushConfirmStore.getState().requestSeq).toBe(afterRequest);
    });
  });
});
