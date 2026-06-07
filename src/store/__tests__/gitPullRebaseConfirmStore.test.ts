import { afterEach, describe, expect, it } from "vitest";
import { useGitPullRebaseConfirmStore } from "../gitPullRebaseConfirmStore";

afterEach(() => {
  if (useGitPullRebaseConfirmStore.getState().pendingConfirm) {
    useGitPullRebaseConfirmStore.getState().resolveConfirmation(false);
  }
});

describe("gitPullRebaseConfirmStore", () => {
  it("resolves the awaited Promise with the value passed to resolveConfirmation", async () => {
    const pending = useGitPullRebaseConfirmStore.getState().requestConfirmation("/repo");
    expect(useGitPullRebaseConfirmStore.getState().pendingConfirm?.cwd).toBe("/repo");

    useGitPullRebaseConfirmStore.getState().resolveConfirmation(true);
    await expect(pending).resolves.toBe(true);
    expect(useGitPullRebaseConfirmStore.getState().pendingConfirm).toBeNull();
  });

  it("resolves with false when declined", async () => {
    const pending = useGitPullRebaseConfirmStore.getState().requestConfirmation("/repo");
    useGitPullRebaseConfirmStore.getState().resolveConfirmation(false);
    await expect(pending).resolves.toBe(false);
  });

  it("cancels a prior pending request (resolves it false) when a new one arrives", async () => {
    const first = useGitPullRebaseConfirmStore.getState().requestConfirmation("/repo-a");
    const second = useGitPullRebaseConfirmStore.getState().requestConfirmation("/repo-b");

    await expect(first).resolves.toBe(false);
    expect(useGitPullRebaseConfirmStore.getState().pendingConfirm?.cwd).toBe("/repo-b");

    useGitPullRebaseConfirmStore.getState().resolveConfirmation(true);
    await expect(second).resolves.toBe(true);
  });

  it("resolveConfirmation is a no-op when nothing is pending", () => {
    expect(() => useGitPullRebaseConfirmStore.getState().resolveConfirmation(true)).not.toThrow();
    expect(useGitPullRebaseConfirmStore.getState().pendingConfirm).toBeNull();
  });

  describe("requestSeq (ErrorBoundary reset signal, #9918)", () => {
    it("strictly increases on each request, including back-to-back supersede", () => {
      const before = useGitPullRebaseConfirmStore.getState().requestSeq;

      useGitPullRebaseConfirmStore.getState().requestConfirmation("/repo-a");
      const afterFirst = useGitPullRebaseConfirmStore.getState().requestSeq;
      expect(afterFirst).toBeGreaterThan(before);

      useGitPullRebaseConfirmStore.getState().requestConfirmation("/repo-b");
      const afterSecond = useGitPullRebaseConfirmStore.getState().requestSeq;
      expect(afterSecond).toBeGreaterThan(afterFirst);
    });

    it("does not change when a pending request is resolved", () => {
      useGitPullRebaseConfirmStore.getState().requestConfirmation("/repo");
      const afterRequest = useGitPullRebaseConfirmStore.getState().requestSeq;

      useGitPullRebaseConfirmStore.getState().resolveConfirmation(true);
      expect(useGitPullRebaseConfirmStore.getState().requestSeq).toBe(afterRequest);
    });
  });
});
