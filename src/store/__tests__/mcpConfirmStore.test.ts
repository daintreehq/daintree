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
    danger: "confirm" as const,
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
    expect(await first).toEqual({ decision: "approved" });

    const next = useMcpConfirmStore.getState();
    expect(next.current?.requestId).toBe("b");
    expect(next.queue).toHaveLength(0);

    next.resolveCurrent("rejected");
    expect(await second).toEqual({ decision: "rejected" });

    expect(useMcpConfirmStore.getState().current).toBeNull();
  });

  it("resolves with the user's decision keyed by requestId, never overwriting a sibling", async () => {
    const first = requestMcpConfirmation(pendingFixture({ requestId: "a" }));
    const second = requestMcpConfirmation(pendingFixture({ requestId: "b" }));

    useMcpConfirmStore.getState().resolveCurrent("approved");
    expect(await first).toEqual({ decision: "approved" });

    useMcpConfirmStore.getState().resolveCurrent("timeout");
    expect(await second).toEqual({ decision: "timeout" });
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

    expect(await second).toEqual({ decision: "rejected" });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("duplicate requestId"));
    expect(useMcpConfirmStore.getState().queue).toHaveLength(0);

    useMcpConfirmStore.getState().resolveCurrent("approved");
    expect(await first).toEqual({ decision: "approved" });

    warn.mockRestore();
  });

  /**
   * The typed-name gate rides the same patch as the preview (#12115), so the
   * queued branch matters as much as the current one: an item that is promoted
   * having lost its gate is approvable with no attestation, while the bridge
   * still believes one was shown.
   */
  describe("setPreview and the typed-name gate (#12115)", () => {
    it("patches a QUEUED item's gate, not only the visible one", () => {
      void requestMcpConfirmation(pendingFixture({ requestId: "a" }));
      void requestMcpConfirmation(pendingFixture({ requestId: "b" }));
      expect(useMcpConfirmStore.getState().current?.requestId).toBe("a");

      useMcpConfirmStore.getState().setPreview("b", ["  M src/app.ts"], "feature/x");

      const queued = useMcpConfirmStore.getState().queue[0];
      expect(queued?.requestId).toBe("b");
      expect(queued?.typedNameTarget).toBe("feature/x");
      expect(queued?.previewPending).toBe(false);

      // And it survives promotion — the gate has to be there when the human
      // finally sees the dialog, not merely when the fetch landed.
      useMcpConfirmStore.getState().resolveCurrent("rejected");
      expect(useMcpConfirmStore.getState().current?.typedNameTarget).toBe("feature/x");
    });

    it("patches the current item's gate", () => {
      void requestMcpConfirmation(pendingFixture({ requestId: "a" }));
      useMcpConfirmStore.getState().setPreview("a", [], "feature/x");
      expect(useMcpConfirmStore.getState().current?.typedNameTarget).toBe("feature/x");
    });

    it("leaves an ungated item WITHOUT the property, not with an explicit undefined", () => {
      void requestMcpConfirmation(pendingFixture({ requestId: "a" }));
      void requestMcpConfirmation(pendingFixture({ requestId: "b" }));

      useMcpConfirmStore.getState().setPreview("a", ["No uncommitted changes."]);
      useMcpConfirmStore.getState().setPreview("b", ["No uncommitted changes."]);

      expect(useMcpConfirmStore.getState().current).not.toHaveProperty("typedNameTarget");
      expect(useMcpConfirmStore.getState().queue[0]).not.toHaveProperty("typedNameTarget");
    });

    it("does not resurrect a settled request", () => {
      void requestMcpConfirmation(pendingFixture({ requestId: "a" }));
      useMcpConfirmStore.getState().resolveCurrent("approved");
      useMcpConfirmStore.getState().setPreview("a", ["  M src/app.ts"], "feature/x");
      expect(useMcpConfirmStore.getState().current).toBeNull();
    });
  });

  it("carries the approver's selection back with an approval", async () => {
    const pending = requestMcpConfirmation({
      ...pendingFixture(),
      selectableTargets: [
        { id: "t1", name: "one", kindLabel: "Terminal", agentRunning: false },
        { id: "t2", name: "two", kindLabel: "Terminal", agentRunning: true },
      ],
    });

    useMcpConfirmStore.getState().resolveCurrent("approved", ["t1"]);

    expect(await pending).toEqual({ decision: "approved", selectedTargetIds: ["t1"] });
  });

  it("carries an empty selection through as a real answer, not an absent one", async () => {
    const pending = requestMcpConfirmation(pendingFixture());

    useMcpConfirmStore.getState().resolveCurrent("approved", []);

    expect(await pending).toEqual({ decision: "approved", selectedTargetIds: [] });
  });

  it("drops a selection handed to a rejection or timeout", async () => {
    const rejected = requestMcpConfirmation(pendingFixture({ requestId: "a" }));
    const timedOut = requestMcpConfirmation(pendingFixture({ requestId: "b" }));

    useMcpConfirmStore.getState().resolveCurrent("rejected", ["t1"]);
    useMcpConfirmStore.getState().resolveCurrent("timeout", ["t2"]);

    expect(await rejected).toEqual({ decision: "rejected" });
    expect(await timedOut).toEqual({ decision: "timeout" });
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
