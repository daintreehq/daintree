import { afterEach, describe, expect, it } from "vitest";
import { useGitPushConfirmStore } from "../gitPushConfirmStore";

afterEach(() => {
  // Resolve any leaked pending request so it can't bleed into the next test.
  if (useGitPushConfirmStore.getState().pendingConfirm) {
    useGitPushConfirmStore.getState().resolveConfirmation(false);
  }
});

describe("gitPushConfirmStore", () => {
  it("resolves the awaited Promise with the value passed to resolveConfirmation", async () => {
    const { requestConfirmation } = useGitPushConfirmStore.getState();
    const pending = requestConfirmation("/repo");

    expect(useGitPushConfirmStore.getState().pendingConfirm?.cwd).toBe("/repo");

    useGitPushConfirmStore.getState().resolveConfirmation(true);
    await expect(pending).resolves.toBe(true);
    expect(useGitPushConfirmStore.getState().pendingConfirm).toBeNull();
  });

  it("resolves with false when declined", async () => {
    const pending = useGitPushConfirmStore.getState().requestConfirmation("/repo");
    useGitPushConfirmStore.getState().resolveConfirmation(false);
    await expect(pending).resolves.toBe(false);
  });

  it("cancels a prior pending request (resolves it false) when a new one arrives", async () => {
    const first = useGitPushConfirmStore.getState().requestConfirmation("/repo-a");
    const second = useGitPushConfirmStore.getState().requestConfirmation("/repo-b");

    await expect(first).resolves.toBe(false);
    expect(useGitPushConfirmStore.getState().pendingConfirm?.cwd).toBe("/repo-b");

    useGitPushConfirmStore.getState().resolveConfirmation(true);
    await expect(second).resolves.toBe(true);
  });

  it("resolveConfirmation is a no-op when nothing is pending", () => {
    expect(() => useGitPushConfirmStore.getState().resolveConfirmation(true)).not.toThrow();
    expect(useGitPushConfirmStore.getState().pendingConfirm).toBeNull();
  });
});
