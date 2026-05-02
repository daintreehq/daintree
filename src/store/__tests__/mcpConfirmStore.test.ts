import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  __resetMcpConfirmStoreForTesting,
  requestMcpConfirmation,
  useMcpConfirmStore,
} from "../mcpConfirmStore";

function pendingFixture(overrides: { requestId?: string; actionId?: string } = {}) {
  return {
    requestId: overrides.requestId ?? "req-1",
    actionId: overrides.actionId ?? "worktree.delete",
    actionTitle: "Delete Worktree",
    actionDescription: "Permanently delete a worktree.",
    argsSummary: '{"worktreeId":"wt-1"}',
  };
}

describe("mcpConfirmStore", () => {
  beforeEach(() => {
    __resetMcpConfirmStoreForTesting();
  });

  afterEach(() => {
    __resetMcpConfirmStoreForTesting();
  });

  it("promotes the first enqueue to current immediately and queues the rest behind it", async () => {
    const first = requestMcpConfirmation(pendingFixture({ requestId: "a" }));
    const second = requestMcpConfirmation(pendingFixture({ requestId: "b" }));

    const state = useMcpConfirmStore.getState();
    expect(state.current?.requestId).toBe("a");
    expect(state.queue).toHaveLength(1);
    expect(state.queue[0]!.requestId).toBe("b");

    state.resolveCurrent("approved");
    expect(await first).toBe("approved");

    const next = useMcpConfirmStore.getState();
    expect(next.current?.requestId).toBe("b");
    expect(next.queue).toHaveLength(0);

    next.resolveCurrent("rejected");
    expect(await second).toBe("rejected");

    expect(useMcpConfirmStore.getState().current).toBeNull();
  });

  it("resolves with the user's decision keyed by requestId, never overwriting a sibling", async () => {
    const first = requestMcpConfirmation(pendingFixture({ requestId: "a" }));
    const second = requestMcpConfirmation(pendingFixture({ requestId: "b" }));

    useMcpConfirmStore.getState().resolveCurrent("approved");
    expect(await first).toBe("approved");

    useMcpConfirmStore.getState().resolveCurrent("timeout");
    expect(await second).toBe("timeout");
  });

  it("ignores resolveCurrent when nothing is showing", () => {
    expect(() => useMcpConfirmStore.getState().resolveCurrent("rejected")).not.toThrow();
    expect(useMcpConfirmStore.getState().current).toBeNull();
  });

  it("drop removes a queued item without resolving and advances the queue when the visible one is dropped", async () => {
    const first = requestMcpConfirmation(pendingFixture({ requestId: "a" }));
    const second = requestMcpConfirmation(pendingFixture({ requestId: "b" }));

    useMcpConfirmStore.getState().drop("b");
    let state = useMcpConfirmStore.getState();
    expect(state.current?.requestId).toBe("a");
    expect(state.queue).toHaveLength(0);

    useMcpConfirmStore.getState().drop("a");
    state = useMcpConfirmStore.getState();
    expect(state.current).toBeNull();

    let firstResolved = false;
    let secondResolved = false;
    void first.then(() => {
      firstResolved = true;
    });
    void second.then(() => {
      secondResolved = true;
    });
    await Promise.resolve();
    expect(firstResolved).toBe(false);
    expect(secondResolved).toBe(false);
  });

  it("rejects a duplicate requestId rather than orphaning the original promise", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const first = requestMcpConfirmation(pendingFixture({ requestId: "dup" }));
    const second = requestMcpConfirmation(pendingFixture({ requestId: "dup" }));

    expect(await second).toBe("rejected");
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("duplicate requestId"));
    expect(useMcpConfirmStore.getState().queue).toHaveLength(0);

    useMcpConfirmStore.getState().resolveCurrent("approved");
    expect(await first).toBe("approved");

    warn.mockRestore();
  });

  it("reset clears state and the resolver map without resolving outstanding promises", async () => {
    const first = requestMcpConfirmation(pendingFixture({ requestId: "a" }));
    void requestMcpConfirmation(pendingFixture({ requestId: "b" }));

    __resetMcpConfirmStoreForTesting();
    const state = useMcpConfirmStore.getState();
    expect(state.current).toBeNull();
    expect(state.queue).toHaveLength(0);

    let firstResolved = false;
    void first.then(() => {
      firstResolved = true;
    });
    await Promise.resolve();
    expect(firstResolved).toBe(false);
  });
});
