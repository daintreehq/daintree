import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  __resetMcpConfirmStoreForTesting,
  requestMcpConfirmation,
  useMcpConfirmStore,
  type McpConfirmHold,
} from "../mcpConfirmStore";
import {
  MCP_CONFIRM_DECISION_MS,
  MCP_CONFIRM_QUEUE_HOLD_MS,
  MCP_DISPATCH_TIMEOUT_MS,
} from "@shared/config/mcpConfirmWindow";

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

async function expectStillPending(promise: Promise<unknown>): Promise<void> {
  let settled = false;
  void promise.then(() => {
    settled = true;
  });
  await Promise.resolve();
  expect(settled).toBe(false);
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

  it("says a timeout went unseen, and only a timeout (#13392)", async () => {
    const unseen = requestMcpConfirmation(pendingFixture({ requestId: "a" }));
    const approved = requestMcpConfirmation(pendingFixture({ requestId: "b" }));

    useMcpConfirmStore.getState().resolveCurrent("timeout", undefined, undefined, true);
    useMcpConfirmStore.getState().resolveCurrent("approved", undefined, undefined, true);

    expect(await unseen).toEqual({ decision: "timeout", unseen: true });
    expect(await approved).toEqual({ decision: "approved" });
  });

  // #12692: "Allow for this session" reaches wider than the call on screen, so
  // it only survives an approval of a dialog that actually offered it.
  it("carries the session scope back only from a dialog that offered it", async () => {
    const offered = requestMcpConfirmation({
      ...pendingFixture({ requestId: "a" }),
      offerSessionApproval: true,
    });
    const notOffered = requestMcpConfirmation(pendingFixture({ requestId: "b" }));

    useMcpConfirmStore.getState().resolveCurrent("approved", undefined, "session");
    useMcpConfirmStore.getState().resolveCurrent("approved", undefined, "session");

    expect(await offered).toEqual({ decision: "approved", scope: "session" });
    expect(await notOffered).toEqual({ decision: "approved" });
  });

  it("drops the session scope handed to a rejection", async () => {
    const pending = requestMcpConfirmation({ ...pendingFixture(), offerSessionApproval: true });

    useMcpConfirmStore.getState().resolveCurrent("rejected", undefined, "session");

    expect(await pending).toEqual({ decision: "rejected" });
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

  describe("main's hold on the dispatch (#14989)", () => {
    /** A hold whose replies the test hands back one at a time, in any order. */
    function controlledHold() {
      const asks: { phase: string; answer: (remainingMs: number | null) => void }[] = [];
      const hold: McpConfirmHold = (phase) =>
        new Promise((resolve) => {
          asks.push({ phase, answer: resolve });
        });
      return { hold, asks };
    }

    afterEach(() => {
      vi.useRealTimers();
    });

    it("asks main to hold a request as soon as it is queued, and again once it is shown", () => {
      const { hold, asks } = controlledHold();
      void requestMcpConfirmation(pendingFixture(), { deadlineAt: Date.now() + 30_000, hold });
      expect(asks.map((ask) => ask.phase)).toEqual(["queued"]);

      useMcpConfirmStore.getState().markShown("req-1");
      useMcpConfirmStore.getState().markShown("req-1");
      expect(asks.map((ask) => ask.phase)).toEqual(["queued", "shown"]);
    });

    it("takes main's deadline from when it asked, so the grant never runs late", async () => {
      vi.useFakeTimers();
      const { hold, asks } = controlledHold();
      const asked = Date.now();
      void requestMcpConfirmation(pendingFixture(), { deadlineAt: asked + 30_000, hold });

      vi.advanceTimersByTime(400);
      asks[0]!.answer(135_000);
      await Promise.resolve();

      expect(useMcpConfirmStore.getState().current?.deadlineAt).toBe(asked + 135_000);
    });

    it("ignores a waiting grant that lands after the shown one", async () => {
      vi.useFakeTimers();
      const { hold, asks } = controlledHold();
      void requestMcpConfirmation(pendingFixture(), { deadlineAt: Date.now() + 30_000, hold });
      useMcpConfirmStore.getState().markShown("req-1");
      const shownAt = Date.now();

      asks[1]!.answer(125_000);
      await Promise.resolve();
      asks[0]!.answer(135_000);
      await Promise.resolve();

      expect(useMcpConfirmStore.getState().current?.deadlineAt).toBe(shownAt + 125_000);
    });

    it("keeps the waiting grant while the on-screen one is still on its way", async () => {
      vi.useFakeTimers();
      const { hold, asks } = controlledHold();
      const asked = Date.now();
      void requestMcpConfirmation(pendingFixture(), { deadlineAt: asked + 30_000, hold });
      useMcpConfirmStore.getState().markShown("req-1");

      asks[0]!.answer(135_000);
      await Promise.resolve();

      expect(useMcpConfirmStore.getState().current?.deadlineAt).toBe(asked + 135_000);
    });

    it("lets a request whose time ran out while hidden go unseen when its view comes back", async () => {
      vi.useFakeTimers();
      const first = requestMcpConfirmation(pendingFixture({ requestId: "a" }), {
        deadlineAt: Date.now() + 30_000,
      });
      void requestMcpConfirmation(pendingFixture({ requestId: "b" }));

      // The clock moves on with no timer run: a sleeping machine waking up.
      vi.setSystemTime(Date.now() + 60_000);
      useMcpConfirmStore.getState().markShown("a");

      expect(await first).toEqual({ decision: "timeout", unseen: true });
      expect(useMcpConfirmStore.getState().current?.requestId).toBe("b");
    });

    it("times a request out as soon as main says it no longer holds it", async () => {
      const { hold, asks } = controlledHold();
      const first = requestMcpConfirmation(pendingFixture({ requestId: "a" }));
      const queued = requestMcpConfirmation(pendingFixture({ requestId: "b" }), {
        deadlineAt: Date.now() + 30_000,
        hold,
      });

      asks[0]!.answer(null);

      expect(await queued).toEqual({ decision: "timeout", unseen: true });
      expect(useMcpConfirmStore.getState().queue).toHaveLength(0);
      expect(useMcpConfirmStore.getState().current?.requestId).toBe("a");
      useMcpConfirmStore.getState().resolveCurrent("rejected");
      expect(await first).toEqual({ decision: "rejected" });
    });

    it("lets a queued request whose time ran out go unseen rather than opening it", async () => {
      vi.useFakeTimers();
      const first = requestMcpConfirmation(pendingFixture({ requestId: "a" }));
      const stale = requestMcpConfirmation(pendingFixture({ requestId: "b" }), {
        deadlineAt: Date.now() + 30_000,
      });
      const live = requestMcpConfirmation(pendingFixture({ requestId: "c" }));

      vi.advanceTimersByTime(30_000);
      useMcpConfirmStore.getState().resolveCurrent("approved");

      expect(await first).toEqual({ decision: "approved" });
      expect(await stale).toEqual({ decision: "timeout", unseen: true });
      expect(useMcpConfirmStore.getState().current?.requestId).toBe("c");
      useMcpConfirmStore.getState().resolveCurrent("rejected");
      expect(await live).toEqual({ decision: "rejected" });
    });

    it("keeps a request that expired on screen with nothing behind it until it is dismissed, and never answers it again", async () => {
      const expiring = requestMcpConfirmation(pendingFixture({ requestId: "a" }));
      useMcpConfirmStore.getState().markShown("a");

      useMcpConfirmStore.getState().expire("a");
      expect(await expiring).toEqual({ decision: "timeout" });
      expect(useMcpConfirmStore.getState().current).toMatchObject({
        requestId: "a",
        expired: true,
      });

      useMcpConfirmStore.getState().resolveCurrent("approved");
      useMcpConfirmStore.getState().expire("a");
      useMcpConfirmStore.getState().dismiss("b");
      expect(useMcpConfirmStore.getState().current?.requestId).toBe("a");
      useMcpConfirmStore.getState().dismiss("a");
      expect(useMcpConfirmStore.getState().current).toBeNull();
    });

    it("keeps an expired request up when everything queued behind it has run out unseen", async () => {
      vi.useFakeTimers();
      const expiring = requestMcpConfirmation(pendingFixture({ requestId: "a" }));
      const stale = requestMcpConfirmation(pendingFixture({ requestId: "b" }), {
        deadlineAt: Date.now() + 30_000,
      });
      useMcpConfirmStore.getState().markShown("a");

      vi.advanceTimersByTime(30_000);
      useMcpConfirmStore.getState().expire("a");

      expect(await expiring).toEqual({ decision: "timeout" });
      expect(await stale).toEqual({ decision: "timeout", unseen: true });
      expect(useMcpConfirmStore.getState().current).toMatchObject({
        requestId: "a",
        expired: true,
      });
      expect(useMcpConfirmStore.getState().queue).toHaveLength(0);
    });

    it("brings up the next request as soon as the one on screen expires, with its queue time intact (#15700)", async () => {
      vi.useFakeTimers();
      const holds = ["a", "b", "c"].map(() => controlledHold());
      const asked = Date.now();
      const request = (requestId: string, index: number) =>
        requestMcpConfirmation(pendingFixture({ requestId }), {
          deadlineAt: asked + MCP_DISPATCH_TIMEOUT_MS,
          hold: holds[index]!.hold,
        });
      const first = request("a", 0);
      const second = request("b", 1);
      const third = request("c", 2);
      for (const { asks } of holds) asks[0]!.answer(MCP_CONFIRM_QUEUE_HOLD_MS);
      await Promise.resolve();

      useMcpConfirmStore.getState().markShown("a");
      vi.advanceTimersByTime(MCP_CONFIRM_DECISION_MS);
      useMcpConfirmStore.getState().expire("a");

      expect(await first).toEqual({ decision: "timeout" });
      const state = useMcpConfirmStore.getState();
      expect(state.current).toMatchObject({
        requestId: "b",
        deadlineAt: asked + MCP_CONFIRM_QUEUE_HOLD_MS,
      });
      expect(state.current?.expired).toBeUndefined();
      expect(state.current?.followsExpired?.requestId).toBe("a");
      expect(state.queue.map((item) => item.requestId)).toEqual(["c"]);
      await expectStillPending(second);

      // Shown now, so its own decision window starts now.
      const shownAt = Date.now();
      useMcpConfirmStore.getState().markShown("b");
      expect(useMcpConfirmStore.getState().current).toMatchObject({
        shownAt,
        decisionEndsAt: shownAt + MCP_CONFIRM_DECISION_MS,
      });
      expect(holds[1]!.asks.map((ask) => ask.phase)).toEqual(["queued", "shown"]);
      useMcpConfirmStore.getState().resolveCurrent("approved");
      expect(await second).toEqual({ decision: "approved" });
      // Brought up by an answer, not an expiry, so it names nothing that expired.
      expect(useMcpConfirmStore.getState().current).toMatchObject({ requestId: "c" });
      expect(useMcpConfirmStore.getState().current?.followsExpired).toBeUndefined();
      useMcpConfirmStore.getState().resolveCurrent("rejected");
      expect(await third).toEqual({ decision: "rejected" });
    });

    it("never holds a request that arrives while an expired one is up behind it (#15700)", async () => {
      const expiring = requestMcpConfirmation({
        ...pendingFixture({ requestId: "a" }),
        subject: "feature/x",
      });
      useMcpConfirmStore.getState().markShown("a");
      useMcpConfirmStore.getState().expire("a");
      expect(await expiring).toEqual({ decision: "timeout" });
      expect(useMcpConfirmStore.getState().current).toMatchObject({
        requestId: "a",
        expired: true,
      });

      const arriving = requestMcpConfirmation(pendingFixture({ requestId: "b" }));
      const state = useMcpConfirmStore.getState();
      expect(state.current).toMatchObject({
        requestId: "b",
        followsExpired: { requestId: "a", actionTitle: "Delete Worktree", subject: "feature/x" },
      });
      expect(state.current?.expired).toBeUndefined();
      expect(state.queue).toHaveLength(0);
      await expectStillPending(arriving);
      useMcpConfirmStore.getState().resolveCurrent("approved");
      expect(await arriving).toEqual({ decision: "approved" });
    });

    it("moves straight on from a request that expired before anyone saw it", async () => {
      const unseen = requestMcpConfirmation(pendingFixture({ requestId: "a" }));
      void requestMcpConfirmation(pendingFixture({ requestId: "b" }));

      useMcpConfirmStore.getState().expire("a");

      expect(await unseen).toEqual({ decision: "timeout", unseen: true });
      expect(useMcpConfirmStore.getState().current?.requestId).toBe("b");
      expect(useMcpConfirmStore.getState().current?.followsExpired).toBeUndefined();
    });

    it("skips what ran out unseen behind an expired request and names it on the next live one (#15700)", async () => {
      vi.useFakeTimers();
      const expiring = requestMcpConfirmation(pendingFixture({ requestId: "a" }));
      const stale = requestMcpConfirmation(pendingFixture({ requestId: "b" }), {
        deadlineAt: Date.now() + 30_000,
      });
      const live = requestMcpConfirmation(pendingFixture({ requestId: "c" }), {
        deadlineAt: Date.now() + 60_000,
      });
      useMcpConfirmStore.getState().markShown("a");

      vi.advanceTimersByTime(30_000);
      useMcpConfirmStore.getState().expire("a");

      expect(await expiring).toEqual({ decision: "timeout" });
      expect(await stale).toEqual({ decision: "timeout", unseen: true });
      const state = useMcpConfirmStore.getState();
      expect(state.current?.requestId).toBe("c");
      expect(state.current?.followsExpired?.requestId).toBe("a");
      expect(state.queue).toHaveLength(0);
      await expectStillPending(live);
    });

    it("names only the latest request that expired on screen (#15700)", () => {
      void requestMcpConfirmation({ ...pendingFixture({ requestId: "a" }), subject: "one" });
      void requestMcpConfirmation({ ...pendingFixture({ requestId: "b" }), subject: "two" });
      void requestMcpConfirmation(pendingFixture({ requestId: "c" }));

      useMcpConfirmStore.getState().markShown("a");
      useMcpConfirmStore.getState().expire("a");
      useMcpConfirmStore.getState().markShown("b");
      useMcpConfirmStore.getState().expire("b");

      const { current } = useMcpConfirmStore.getState();
      expect(current?.requestId).toBe("c");
      expect(current?.followsExpired).toMatchObject({ requestId: "b", subject: "two" });
      expect(current?.followsExpired?.followsExpired).toBeUndefined();
    });

    it("passes an expiry nobody has read about on past a request that goes unseen (#15700)", () => {
      void requestMcpConfirmation({ ...pendingFixture({ requestId: "a" }), subject: "one" });
      void requestMcpConfirmation(pendingFixture({ requestId: "b" }));
      void requestMcpConfirmation(pendingFixture({ requestId: "c" }));
      useMcpConfirmStore.getState().markShown("a");
      useMcpConfirmStore.getState().expire("a");

      // The view went into the background before b could be seen.
      useMcpConfirmStore.getState().expire("b");

      const { current } = useMcpConfirmStore.getState();
      expect(current?.requestId).toBe("c");
      expect(current?.followsExpired).toMatchObject({ requestId: "a", subject: "one" });
    });

    it("brings an expired request back up when everything after it went unseen (#15700)", async () => {
      void requestMcpConfirmation({ ...pendingFixture({ requestId: "a" }), subject: "one" });
      const unseen = requestMcpConfirmation(pendingFixture({ requestId: "b" }));
      useMcpConfirmStore.getState().markShown("a");
      useMcpConfirmStore.getState().expire("a");

      useMcpConfirmStore.getState().expire("b");

      expect(await unseen).toEqual({ decision: "timeout", unseen: true });
      const { current } = useMcpConfirmStore.getState();
      expect(current).toMatchObject({ requestId: "a", subject: "one", expired: true });
      useMcpConfirmStore.getState().resolveCurrent("approved");
      useMcpConfirmStore.getState().dismiss("a");
      expect(useMcpConfirmStore.getState().current).toBeNull();
    });
  });
});
