import { afterEach, describe, expect, it } from "vitest";
import {
  useWorktreeResourceTeardownConfirmStore,
  type ResourceTeardownConfirmRequest,
} from "../worktreeResourceTeardownConfirmStore";

const request = (worktreeId: string): ResourceTeardownConfirmRequest => ({
  worktreeId,
  label: worktreeId,
  commands: [`devbox rm ${worktreeId}`],
  approved: true,
});

afterEach(() => useWorktreeResourceTeardownConfirmStore.getState().resolveConfirmation(false));

describe("worktreeResourceTeardownConfirmStore", () => {
  it("resolves the awaiting request with the answer and clears it", async () => {
    const store = useWorktreeResourceTeardownConfirmStore.getState();
    const answer = store.requestConfirmation(request("a"));
    expect(
      useWorktreeResourceTeardownConfirmStore.getState().pendingConfirm?.request.worktreeId
    ).toBe("a");
    store.resolveConfirmation(true);
    expect(await answer).toBe(true);
    expect(useWorktreeResourceTeardownConfirmStore.getState().pendingConfirm).toBeNull();
  });

  it("cancels a pending request when a newer one replaces it, and bumps the reset key", async () => {
    const store = useWorktreeResourceTeardownConfirmStore.getState();
    const seq = useWorktreeResourceTeardownConfirmStore.getState().requestSeq;
    const first = store.requestConfirmation(request("a"));
    const second = store.requestConfirmation(request("b"));
    expect(await first).toBe(false);
    expect(useWorktreeResourceTeardownConfirmStore.getState().requestSeq).toBe(seq + 2);
    useWorktreeResourceTeardownConfirmStore.getState().resolveConfirmation(true);
    expect(await second).toBe(true);
  });

  it("ignores a resolve with nothing pending", () => {
    expect(() =>
      useWorktreeResourceTeardownConfirmStore.getState().resolveConfirmation(true)
    ).not.toThrow();
  });
});
