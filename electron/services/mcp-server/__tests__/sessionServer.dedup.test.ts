import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  app: {
    getVersion: () => "0.0.0-test",
  },
}));

import { createSessionServer, type SessionServerDeps } from "../sessionServer.js";
import { SessionStore as RealSessionStore } from "../sessionStore.js";
import {
  TIER_NOT_PERMITTED_CODE,
  MCP_DEDUP_KEY_COLLISION_CODE,
  MCP_DEDUP_ALLOWLIST,
  minimumPermittingTier,
} from "../shared.js";
import {
  toolErrorPayload,
  fakeSessionStore,
  fakeDeps,
  callTool,
  seedLiveSession,
} from "./helpers/sessionServerFixture.js";

describe("CallTool idempotency dedup", () => {
  it("coalesces same-moment duplicates via singleflight (dispatch invoked once)", async () => {
    // Hold the dispatch with a manually-resolved promise so two callers race
    // through the handler before the first one resolves.
    let resolveDispatch: ((envelope: unknown) => void) | undefined;
    const dispatchAction = vi.fn().mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveDispatch = resolve as (envelope: unknown) => void;
        })
    );
    const appendAuditRecord = vi.fn();
    const deps = fakeDeps({
      sessionStore: fakeSessionStore("full"),
      dispatchAction,
      appendAuditRecord,
    });
    const server = createSessionServer("dedup-1", deps);

    const a = callTool(server, {
      name: "terminal.new",
      arguments: { spawnedBy: { kind: "user" } },
    });
    const b = callTool(server, {
      name: "terminal.new",
      arguments: { spawnedBy: { kind: "user" } },
    });

    // Both handlers are now suspended; A awaits requestManifest then dispatchAction,
    // B detects the in-flight entry A registered synchronously and awaits the same
    // promise. Yield microtasks until A's handler has reached the held dispatch.
    for (let i = 0; i < 50 && !resolveDispatch; i++) {
      await Promise.resolve();
    }
    expect(resolveDispatch).toBeDefined();

    resolveDispatch!({ result: { ok: true, result: { terminalId: "t-1" } } });

    const [resultA, resultB] = await Promise.all([a, b]);

    expect(dispatchAction).toHaveBeenCalledTimes(1);
    expect(resultA).toEqual(resultB);
    expect((resultA as { content: Array<{ text: string }> }).content[0].text).toContain("t-1");

    // The in-flight dedup row is the case `startedAt` exists for (#12122):
    // audit-write order and arrival order genuinely disagree here. B's `dedup`
    // row is written while A is still suspended on the held dispatch, so it
    // lands FIRST even though A arrived first — a reader ordering by write
    // time would invert the two. Their starts restore the truth.
    const calls = appendAuditRecord.mock.calls.map(
      (call) => call[0] as { outcome: { kind: string }; startedAt: number }
    );
    expect(calls.map((c) => c.outcome.kind)).toEqual(["dedup", "result"]);
    const [dedupCall, dispatchCall] = calls;
    expect(typeof dedupCall!.startedAt).toBe("number");
    expect(typeof dispatchCall!.startedAt).toBe("number");
    // A entered the handler no later than B, despite settling after it.
    expect(dispatchCall!.startedAt).toBeLessThanOrEqual(dedupCall!.startedAt);
  });

  it("returns the cached result for a post-completion duplicate within TTL", async () => {
    const dispatchAction = vi
      .fn()
      .mockResolvedValue({ result: { ok: true, result: { terminalId: "t-2" } } });
    const deps = fakeDeps({
      sessionStore: fakeSessionStore("full"),
      dispatchAction,
    });
    const server = createSessionServer("dedup-2", deps);

    const args = { spawnedBy: { kind: "user" } };
    const first = await callTool(server, { name: "terminal.new", arguments: args });
    const second = await callTool(server, { name: "terminal.new", arguments: args });

    expect(dispatchAction).toHaveBeenCalledTimes(1);
    expect(second).toEqual(first);
  });

  it("does not dedup non-allowlisted actions", async () => {
    const dispatchAction = vi
      .fn()
      .mockResolvedValue({ result: { ok: true, result: { ok: true } } });
    const deps = fakeDeps({
      sessionStore: fakeSessionStore("full"),
      dispatchAction,
    });
    const server = createSessionServer("dedup-3", deps);

    await callTool(server, { name: "terminal.list", arguments: {} });
    await callTool(server, { name: "terminal.list", arguments: {} });

    expect(dispatchAction).toHaveBeenCalledTimes(2);
  });

  it("treats different args as distinct keys", async () => {
    const dispatchAction = vi
      .fn()
      .mockResolvedValue({ result: { ok: true, result: { terminalId: "t-x" } } });
    const deps = fakeDeps({
      sessionStore: fakeSessionStore("full"),
      dispatchAction,
    });
    const server = createSessionServer("dedup-4", deps);

    await callTool(server, {
      name: "terminal.new",
      arguments: { spawnedBy: { kind: "user" } },
    });
    await callTool(server, {
      name: "terminal.new",
      arguments: { spawnedBy: { kind: "agent" } },
    });

    expect(dispatchAction).toHaveBeenCalledTimes(2);
  });

  it("returns collision error when same requestKey used with different args (result-cache)", async () => {
    const dispatchAction = vi
      .fn()
      .mockResolvedValue({ result: { ok: true, result: { terminalId: "t-rk" } } });
    const deps = fakeDeps({
      sessionStore: fakeSessionStore("full"),
      dispatchAction,
    });
    const server = createSessionServer("dedup-5", deps);

    await callTool(server, {
      name: "terminal.new",
      arguments: { requestKey: "rk-1", spawnedBy: { kind: "user" } },
    });
    const second = (await callTool(server, {
      name: "terminal.new",
      arguments: { requestKey: "rk-1", spawnedBy: { kind: "agent" } },
    })) as { isError?: boolean; content: Array<{ text: string }> };

    expect(dispatchAction).toHaveBeenCalledTimes(1);
    expect(second.isError).toBe(true);
    expect(second.content[0].text).toContain(MCP_DEDUP_KEY_COLLISION_CODE);
    // requestKey must not reach dispatchAction.
    const dispatchedArgs = dispatchAction.mock.calls[0][1] as Record<string, unknown>;
    expect(dispatchedArgs).not.toHaveProperty("requestKey");
  });

  it("returns collision error when same requestKey used with different args (in-flight)", async () => {
    let resolveDispatch: ((envelope: unknown) => void) | undefined;
    const dispatchAction = vi.fn().mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveDispatch = resolve as (envelope: unknown) => void;
        })
    );
    const deps = fakeDeps({
      sessionStore: fakeSessionStore("full"),
      dispatchAction,
    });
    const server = createSessionServer("dedup-5b", deps);

    // Fire the first call — it will register in-flight and then await dispatch.
    const first = callTool(server, {
      name: "terminal.new",
      arguments: { requestKey: "rk-inflight", spawnedBy: { kind: "user" } },
    });

    // Yield microtasks so the first handler registers its in-flight entry.
    for (let i = 0; i < 50 && !resolveDispatch; i++) {
      await Promise.resolve();
    }
    expect(resolveDispatch).toBeDefined();

    // Second call with same requestKey but different args — must return collision
    // synchronously, not await the in-flight promise.
    const second = (await callTool(server, {
      name: "terminal.new",
      arguments: { requestKey: "rk-inflight", spawnedBy: { kind: "agent" } },
    })) as { isError?: boolean; content: Array<{ text: string }> };

    expect(second.isError).toBe(true);
    expect(second.content[0].text).toContain(MCP_DEDUP_KEY_COLLISION_CODE);

    // Resolve the first call so it doesn't hang.
    resolveDispatch!({ result: { ok: true, result: { terminalId: "t-inflight" } } });
    await first;

    expect(dispatchAction).toHaveBeenCalledTimes(1);
  });

  it("dedup still works with explicit requestKey and same args (result-cache)", async () => {
    const dispatchAction = vi
      .fn()
      .mockResolvedValue({ result: { ok: true, result: { terminalId: "t-rk-ok" } } });
    const deps = fakeDeps({
      sessionStore: fakeSessionStore("full"),
      dispatchAction,
    });
    const server = createSessionServer("dedup-rk-ok", deps);

    const args = { requestKey: "rk-same", spawnedBy: { kind: "user" } };
    const first = await callTool(server, { name: "terminal.new", arguments: args });
    const second = await callTool(server, { name: "terminal.new", arguments: args });

    expect(dispatchAction).toHaveBeenCalledTimes(1);
    expect(second).toEqual(first);
  });

  it("dedup still works with explicit requestKey and same args (in-flight)", async () => {
    let resolveDispatch: ((envelope: unknown) => void) | undefined;
    const dispatchAction = vi.fn().mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveDispatch = resolve as (envelope: unknown) => void;
        })
    );
    const deps = fakeDeps({
      sessionStore: fakeSessionStore("full"),
      dispatchAction,
    });
    const server = createSessionServer("dedup-rk-inflight", deps);

    const a = callTool(server, {
      name: "terminal.new",
      arguments: { requestKey: "rk-same2", spawnedBy: { kind: "user" } },
    });
    const b = callTool(server, {
      name: "terminal.new",
      arguments: { requestKey: "rk-same2", spawnedBy: { kind: "user" } },
    });

    for (let i = 0; i < 50 && !resolveDispatch; i++) {
      await Promise.resolve();
    }
    expect(resolveDispatch).toBeDefined();

    resolveDispatch!({ result: { ok: true, result: { terminalId: "t-rk-if-ok" } } });

    const [resultA, resultB] = await Promise.all([a, b]);
    expect(dispatchAction).toHaveBeenCalledTimes(1);
    expect(resultA).toEqual(resultB);
  });

  it("does not cache failed dispatches; retries re-dispatch", async () => {
    const dispatchAction = vi
      .fn()
      .mockResolvedValueOnce({
        result: { ok: false, error: { code: "BOOM", message: "kaboom" } },
      })
      .mockResolvedValueOnce({ result: { ok: true, result: { terminalId: "t-retry" } } });
    const deps = fakeDeps({
      sessionStore: fakeSessionStore("full"),
      dispatchAction,
    });
    const server = createSessionServer("dedup-6", deps);

    const args = { spawnedBy: { kind: "user" } };
    const first = (await callTool(server, { name: "terminal.new", arguments: args })) as {
      isError?: boolean;
    };
    expect(first.isError).toBe(true);

    const second = await callTool(server, { name: "terminal.new", arguments: args });

    expect(dispatchAction).toHaveBeenCalledTimes(2);
    expect((second as { content: Array<{ text: string }> }).content[0].text).toContain("t-retry");
  });

  it("does not cache thrown dispatches; retries re-dispatch", async () => {
    const dispatchAction = vi
      .fn()
      .mockRejectedValueOnce(new Error("network down"))
      .mockResolvedValueOnce({ result: { ok: true, result: { terminalId: "t-throw" } } });
    const deps = fakeDeps({
      sessionStore: fakeSessionStore("full"),
      dispatchAction,
    });
    const server = createSessionServer("dedup-7", deps);

    const args = { spawnedBy: { kind: "user" } };
    const first = (await callTool(server, { name: "terminal.new", arguments: args })) as {
      isError?: boolean;
    };
    expect(first.isError).toBe(true);

    const second = await callTool(server, { name: "terminal.new", arguments: args });

    expect(dispatchAction).toHaveBeenCalledTimes(2);
    expect((second as { content: Array<{ text: string }> }).content[0].text).toContain("t-throw");
  });

  it("logs a 'dedup' audit record when a duplicate is suppressed", async () => {
    const appendAuditRecord = vi.fn();
    const dispatchAction = vi
      .fn()
      .mockResolvedValue({ result: { ok: true, result: { terminalId: "t-audit" } } });
    const deps = fakeDeps({
      sessionStore: fakeSessionStore("full"),
      dispatchAction,
      appendAuditRecord,
    });
    const server = createSessionServer("dedup-8", deps);

    const args = { spawnedBy: { kind: "user" } };
    await callTool(server, { name: "terminal.new", arguments: args });
    await callTool(server, { name: "terminal.new", arguments: args });

    const calls = appendAuditRecord.mock.calls.map(
      (call) => call[0] as { outcome: { kind: string }; startedAt: number }
    );
    const outcomes = calls.map((c) => c.outcome.kind);
    // The original's settlement row is written in the dispatch `finally`,
    // which runs before the first awaited callTool returns — so the order is
    // fixed, not merely "contains a dedup".
    expect(outcomes).toEqual(["result", "dedup"]);

    // The suppressed duplicate is still a call the backend issued, so its row
    // carries its own start — that is what makes back-to-back vs. overlapping
    // dispatch distinguishable downstream (#12122).
    for (const call of calls) {
      expect(typeof call.startedAt).toBe("number");
    }
    const [dispatchCall, dedupCall] = calls;
    // Two separate CallTool handlers, each taking its own snapshot. They can
    // legitimately land in the same millisecond, so this asserts ordering, not
    // distinctness — the guarantee is that the dedup row never reaches back
    // for a start earlier than the call it duplicated.
    expect(dedupCall!.startedAt).toBeGreaterThanOrEqual(dispatchCall!.startedAt);
  });

  it("treats requestKey:'' as absent (falls through to auto-hash)", async () => {
    const dispatchAction = vi
      .fn()
      .mockResolvedValue({ result: { ok: true, result: { terminalId: "t-empty" } } });
    const deps = fakeDeps({
      sessionStore: fakeSessionStore("full"),
      dispatchAction,
    });
    const server = createSessionServer("dedup-9", deps);

    // Same auto-hash key (same args), so even with empty requestKey both dedupe.
    await callTool(server, {
      name: "terminal.new",
      arguments: { requestKey: "", spawnedBy: { kind: "user" } },
    });
    await callTool(server, {
      name: "terminal.new",
      arguments: { requestKey: "", spawnedBy: { kind: "user" } },
    });

    expect(dispatchAction).toHaveBeenCalledTimes(1);
  });

  it("re-dispatches after drain() clears the cache", async () => {
    const dispatchAction = vi
      .fn()
      .mockResolvedValue({ result: { ok: true, result: { terminalId: "t-drain" } } });
    const sessionStore = fakeSessionStore("full");
    const deps = fakeDeps({ sessionStore, dispatchAction });
    const server = createSessionServer("dedup-10", deps);

    const args = { spawnedBy: { kind: "user" } };
    await callTool(server, { name: "terminal.new", arguments: args });

    // Wipe the cache the way drain() does.
    sessionStore.dedupInFlight.clear();
    sessionStore.dedupResultCache.clear();

    await callTool(server, { name: "terminal.new", arguments: args });

    expect(dispatchAction).toHaveBeenCalledTimes(2);
  });

  it("re-dispatches after the TTL window elapses", async () => {
    vi.useFakeTimers();
    try {
      const dispatchAction = vi
        .fn()
        .mockResolvedValue({ result: { ok: true, result: { terminalId: "t-ttl" } } });
      const deps = fakeDeps({
        sessionStore: fakeSessionStore("full"),
        dispatchAction,
      });
      const server = createSessionServer("dedup-ttl", deps);

      const args = { spawnedBy: { kind: "user" } };
      await callTool(server, { name: "terminal.new", arguments: args });

      // Just before the TTL expires — still cached.
      vi.advanceTimersByTime(119_999);
      await callTool(server, { name: "terminal.new", arguments: args });
      expect(dispatchAction).toHaveBeenCalledTimes(1);

      // After the TTL expires — should redispatch.
      vi.advanceTimersByTime(2);
      await callTool(server, { name: "terminal.new", arguments: args });
      expect(dispatchAction).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("isolates dedup state between sessions (same store, different session ids)", async () => {
    const dispatchAction = vi
      .fn()
      .mockResolvedValue({ result: { ok: true, result: { terminalId: "t-iso" } } });
    const sessionStore = fakeSessionStore("full");
    const deps = fakeDeps({ sessionStore, dispatchAction });
    const serverA = createSessionServer("session-a", deps);
    const serverB = createSessionServer("session-b", deps);

    const args = { requestKey: "shared-key", spawnedBy: { kind: "user" } };
    await callTool(serverA, { name: "terminal.new", arguments: args });
    await callTool(serverB, { name: "terminal.new", arguments: args });

    // Same requestKey, but different sessions — both must dispatch.
    expect(dispatchAction).toHaveBeenCalledTimes(2);
  });

  it("dedups worktree.createWithRecipe with the same arguments", async () => {
    const dispatchAction = vi
      .fn()
      .mockResolvedValue({ result: { ok: true, result: { worktreeId: "wt-1" } } });
    const deps = fakeDeps({
      sessionStore: fakeSessionStore("full"),
      dispatchAction,
    });
    const server = createSessionServer("dedup-wt", deps);

    const args = { branchName: "feature/x" };
    await callTool(server, { name: "worktree.createWithRecipe", arguments: args });
    await callTool(server, { name: "worktree.createWithRecipe", arguments: args });

    expect(dispatchAction).toHaveBeenCalledTimes(1);
  });

  it("dedups recipe.run with the same arguments", async () => {
    const dispatchAction = vi
      .fn()
      .mockResolvedValue({ result: { ok: true, result: { terminalId: "t-recipe" } } });
    const deps = fakeDeps({
      sessionStore: fakeSessionStore("full"),
      dispatchAction,
    });
    const server = createSessionServer("dedup-recipe", deps);

    const args = { recipeId: "build" };
    await callTool(server, { name: "recipe.run", arguments: args });
    await callTool(server, { name: "recipe.run", arguments: args });

    expect(dispatchAction).toHaveBeenCalledTimes(1);
  });

  it("does not resurrect dedup state when drain() runs during an in-flight dispatch", async () => {
    const realStore = new RealSessionStore(() => {});
    // A live transport, not just a tier row: `getTier` gates on transport
    // membership (#11799), so a tier-map-only session is refused before it can
    // reach dispatch at all.
    seedLiveSession(realStore, "dedup-resurrect", "full");

    let resolveDispatch: ((envelope: unknown) => void) | undefined;
    const dispatchAction = vi.fn().mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveDispatch = resolve as (envelope: unknown) => void;
        })
    );
    const deps = fakeDeps({ sessionStore: realStore, dispatchAction });
    const server = createSessionServer("dedup-resurrect", deps);

    const inFlightCall = callTool(server, {
      name: "terminal.new",
      arguments: { spawnedBy: { kind: "user" } },
    });

    for (let i = 0; i < 50 && !resolveDispatch; i++) {
      await Promise.resolve();
    }
    expect(realStore.dedupInFlight.get("dedup-resurrect")?.size).toBe(1);

    // Drain mid-flight — wipes dedup state and the session tier map.
    realStore.drain();
    expect(realStore.dedupInFlight.size).toBe(0);
    expect(realStore.dedupResultCache.size).toBe(0);

    // Resolve the held dispatch. The .then() cache hook must NOT resurrect
    // dedupResultCache for the torn-down session.
    resolveDispatch!({ result: { ok: true, result: { terminalId: "t-resurrect" } } });
    await inFlightCall;
    // Flush microtasks so the .then() cache hook had a chance to misfire.
    for (let i = 0; i < 10; i++) await Promise.resolve();

    expect(realStore.dedupResultCache.size).toBe(0);
    expect(realStore.dedupInFlight.size).toBe(0);
    realStore.grantCache.dispose();
  });

  it("rejects requestKey strings beyond the length cap (falls back to auto-hash)", async () => {
    const dispatchAction = vi
      .fn()
      .mockResolvedValue({ result: { ok: true, result: { terminalId: "t-long" } } });
    const deps = fakeDeps({
      sessionStore: fakeSessionStore("full"),
      dispatchAction,
    });
    const server = createSessionServer("dedup-long", deps);

    const oversized = "x".repeat(257); // MAX_REQUEST_KEY_LENGTH = 256
    // Same args, different oversized requestKeys → still dedups via auto-hash
    // because the oversized requestKey is rejected and ignored.
    await callTool(server, {
      name: "terminal.new",
      arguments: { requestKey: oversized + "a", spawnedBy: { kind: "user" } },
    });
    await callTool(server, {
      name: "terminal.new",
      arguments: { requestKey: oversized + "b", spawnedBy: { kind: "user" } },
    });

    expect(dispatchAction).toHaveBeenCalledTimes(1);
  });
});

describe("MCP_DEDUP_ALLOWLIST exclusion boundary (#8468)", () => {
  // Membership `.has()` spot-checks were dropped in #11534: they restated the
  // allowlist literal, so they stayed green even if sessionServer stopped
  // consulting the set. Both directions are proven by dispatch behaviour
  // instead. (The forge half of the original cohort — `forge.openIssue` /
  // `forge.openPR` — was removed in #11534; see the block below.)
  const twoDistinctDispatches = () =>
    vi
      .fn()
      .mockResolvedValueOnce({ result: { ok: true, result: "first" } })
      .mockResolvedValueOnce({ result: { ok: true, result: "second" } });

  it.each(["terminal.inject", "terminal.sendCommand"])(
    "stays bounded — redispatches unlisted mutation %s",
    async (tool) => {
      const dispatchAction = twoDistinctDispatches();
      const deps = fakeDeps({ sessionStore: fakeSessionStore("full"), dispatchAction });
      // Unscoped terminal input is only reachable from the assistant's own
      // origin (#12407); what this pins is the dedup boundary, not that
      // reservation.
      deps.sessionStore.sessionOriginMap.set(`bounded-8468-${tool}`, "help");
      const server = createSessionServer(`bounded-8468-${tool}`, deps);

      const args = { target: "x" };
      await callTool(server, { name: tool, arguments: args });
      const second = await callTool(server, { name: tool, arguments: args });

      expect(dispatchAction).toHaveBeenCalledTimes(2);
      expect(JSON.stringify(second)).toContain("second");
    }
  );
});

describe("worktree.delete redispatch (#15791)", () => {
  // Worktree ids are paths, and delete -> recreate at the same path is a
  // supported workflow, so a repeated identical delete inside the TTL can name
  // a genuinely different worktree. Replaying the first success there reported
  // a delete that never happened, with no confirmation asked.
  const deleteArgs = { worktreeId: "/repo-wt-feature-x" };

  const serverWith = (sessionId: string, dispatchAction: SessionServerDeps["dispatchAction"]) => {
    const deps = fakeDeps({ sessionStore: fakeSessionStore("full"), dispatchAction });
    // The unscoped delete is on the assistant's surface only.
    deps.sessionStore.sessionOriginMap.set(sessionId, "help");
    return createSessionServer(sessionId, deps);
  };

  it("dispatches a repeated identical delete and returns its own result", async () => {
    const dispatchAction = vi
      .fn()
      .mockResolvedValueOnce({ result: { ok: true, result: "first" } })
      .mockResolvedValueOnce({ result: { ok: true, result: "second" } });
    const server = serverWith("redispatch-15791-seq", dispatchAction);

    const first = await callTool(server, { name: "worktree.delete", arguments: deleteArgs });
    const second = await callTool(server, { name: "worktree.delete", arguments: deleteArgs });

    expect(dispatchAction).toHaveBeenCalledTimes(2);
    // The same answer shape, carrying the second dispatch's payload.
    expect(JSON.stringify(second)).toBe(JSON.stringify(first).replace('"first', '"second'));
  });

  it("answers a repeat against a worktree that is already gone with the delete's own error", async () => {
    const dispatchAction = vi
      .fn()
      .mockResolvedValueOnce({ result: { ok: true, result: null } })
      .mockResolvedValueOnce({
        result: {
          ok: false,
          error: { code: "EXECUTION_ERROR", message: "Worktree not found: /repo-wt-feature-x" },
        },
      });
    const server = serverWith("redispatch-15791-gone", dispatchAction);

    await callTool(server, { name: "worktree.delete", arguments: deleteArgs });
    const second = (await callTool(server, {
      name: "worktree.delete",
      arguments: deleteArgs,
    })) as { isError?: boolean; content: Array<{ text: string }> };

    expect(dispatchAction).toHaveBeenCalledTimes(2);
    expect(second.isError).toBe(true);
    expect(JSON.parse(second.content[0]!.text)).toMatchObject({
      code: "EXECUTION_ERROR",
      message: "Worktree not found: /repo-wt-feature-x",
    });
  });

  it("does not let a repeated requestKey suppress the second delete", async () => {
    const dispatchAction = vi
      .fn()
      .mockResolvedValueOnce({ result: { ok: true, result: "first" } })
      .mockResolvedValueOnce({ result: { ok: true, result: "second" } });
    const server = serverWith("redispatch-15791-rk", dispatchAction);

    const args = { ...deleteArgs, requestKey: "rk-delete" };
    const first = await callTool(server, { name: "worktree.delete", arguments: args });
    const second = await callTool(server, { name: "worktree.delete", arguments: args });

    expect(dispatchAction).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(second)).toBe(JSON.stringify(first).replace('"first', '"second'));
  });

  it("dispatches concurrent identical deletes independently instead of sharing one", async () => {
    // Deliberate: dedup lookup runs before the confirmation, so a shared
    // promise would answer the duplicate with the first call's dialog. Each
    // concurrent delete asks for itself, and both must be in flight before
    // either settles.
    const resolvers: Array<(envelope: unknown) => void> = [];
    const dispatchAction = vi.fn().mockImplementation(
      () =>
        new Promise((resolve) => {
          resolvers.push(resolve as (envelope: unknown) => void);
        })
    );
    const server = serverWith("redispatch-15791-inflight", dispatchAction);

    const a = callTool(server, { name: "worktree.delete", arguments: deleteArgs });
    const b = callTool(server, { name: "worktree.delete", arguments: deleteArgs });
    for (let i = 0; i < 100 && resolvers.length < 2; i++) {
      await Promise.resolve();
    }
    expect(resolvers).toHaveLength(2);

    resolvers[0]!({ result: { ok: true, result: "first" } });
    resolvers[1]!({
      result: { ok: false, error: { code: "EXECUTION_ERROR", message: "already removed" } },
    });
    const [resultA, resultB] = (await Promise.all([a, b])) as Array<{
      isError?: boolean;
      content: Array<{ text: string }>;
    }>;

    expect(dispatchAction).toHaveBeenCalledTimes(2);
    // Neither dispatch borrows an approval: each is handed to the renderer
    // unconfirmed, so each raises its own dialog.
    expect(dispatchAction).toHaveBeenNthCalledWith(1, "worktree.delete", deleteArgs, false);
    expect(dispatchAction).toHaveBeenNthCalledWith(2, "worktree.delete", deleteArgs, false);
    expect(resultA.isError).not.toBe(true);
    expect(resultA.content[0]!.text).toContain("first");
    expect(resultB.isError).toBe(true);
    expect(JSON.parse(resultB.content[0]!.text)).toMatchObject({
      code: "EXECUTION_ERROR",
      message: "already removed",
    });
  });

  // Dropping the delete leaves the creation tools' replay untouched.
  it.each([
    "terminal.new",
    "agent.launch",
    "recipe.run",
    "worktree.createWithRecipe",
    "workflow.startWorkOnIssue",
    "worktree.resource.provision",
  ])("still returns the cached result for a repeated %s", async (tool) => {
    const dispatchAction = vi
      .fn()
      .mockResolvedValueOnce({ result: { ok: true, result: "first" } })
      .mockResolvedValueOnce({ result: { ok: true, result: "second" } });
    const server = serverWith(`creation-15791-${tool}`, dispatchAction);

    const args = { target: "x" };
    const first = await callTool(server, { name: tool, arguments: args });
    const second = await callTool(server, { name: tool, arguments: args });

    expect(dispatchAction).toHaveBeenCalledTimes(1);
    expect(second).toEqual(first);
    expect(JSON.stringify(second)).not.toContain("second");
  });
});

describe("MCP_DEDUP_ALLOWLIST criterion correction (#11534)", () => {
  // Creation tools whose replay leaves a durable or immediately visible
  // artifact. Each has a structural twin that was already deduped, which is
  // exactly why the omission was invisible: the same retry was safe through
  // one id and duplicated through the other. The rest of the #11534 cohort —
  // `agent.terminal` and the forge writes — left MCP with the core/full split.
  const NEWLY_DEDUPED = ["workflow.startWorkOnIssue"];

  // Navigation and idempotent state-sets. Caching these suppresses a call the
  // caller legitimately meant to repeat — switching back to a worktree the user
  // navigated away from, or reloading a preview after a change — so they must
  // always redispatch. #11534 dropped `git.commit`/`git.push` for the same
  // reason; the reachability check below keeps them off.
  const MUST_REDISPATCH = ["worktree.setActive", "devPreview.reloadPreview"];

  // Distinct per-call payloads throughout: with a single mockResolvedValue
  // both dispatches return equal results, so `second === first` would hold
  // even with dedup switched off and only the call count would have teeth.
  const twoDistinctDispatches = () =>
    vi
      .fn()
      .mockResolvedValueOnce({ result: { ok: true, result: "first" } })
      .mockResolvedValueOnce({ result: { ok: true, result: "second" } });

  it.each(NEWLY_DEDUPED)("dedups a post-completion duplicate of %s", async (tool) => {
    const dispatchAction = twoDistinctDispatches();
    const deps = fakeDeps({ sessionStore: fakeSessionStore("full"), dispatchAction });
    const server = createSessionServer(`dedup-11534-${tool}`, deps);

    const args = { target: "x" };
    const first = await callTool(server, { name: tool, arguments: args });
    const second = await callTool(server, { name: tool, arguments: args });

    expect(dispatchAction).toHaveBeenCalledTimes(1);
    expect(second).toEqual(first);
    // The replay is the *cached* result, not a fresh dispatch that merely
    // looks alike — the second mock payload must never surface.
    expect(JSON.stringify(second)).not.toContain("second");
  });

  it.each(NEWLY_DEDUPED)(
    "shares one dispatch between concurrent duplicates of %s",
    async (tool) => {
      // The singleflight window, not the result cache: both calls are in flight
      // before either resolves, which is the reconnect-replay shape.
      const dispatchAction = twoDistinctDispatches();
      const deps = fakeDeps({ sessionStore: fakeSessionStore("full"), dispatchAction });
      const server = createSessionServer(`dedup-11534-inflight-${tool}`, deps);

      const args = { target: "x" };
      const [first, second] = await Promise.all([
        callTool(server, { name: tool, arguments: args }),
        callTool(server, { name: tool, arguments: args }),
      ]);

      expect(dispatchAction).toHaveBeenCalledTimes(1);
      expect(second).toEqual(first);
      expect(JSON.stringify(second)).not.toContain("second");
    }
  );

  it("gives agent.launch and terminal.new the same retry outcome", async () => {
    // The issue's core complaint: "the same retry is safe through one id and
    // duplicates through the other." Assert the parity directly, so a future
    // membership edit that reintroduces the asymmetry fails here. With
    // `agent.terminal` gone from MCP, `agent.launch` is the launcher twin left.
    const dispatchCounts = await Promise.all(
      ["terminal.new", "agent.launch"].map(async (tool) => {
        const dispatchAction = twoDistinctDispatches();
        const deps = fakeDeps({ sessionStore: fakeSessionStore("full"), dispatchAction });
        const server = createSessionServer(`parity-11534-${tool}`, deps);

        const args = { spawnedBy: "agent" };
        await callTool(server, { name: tool, arguments: args });
        await callTool(server, { name: tool, arguments: args });
        return dispatchAction.mock.calls.length;
      })
    );

    // Both spawn a terminal the same way, so both must collapse the retry.
    expect(dispatchCounts).toEqual([1, 1]);
  });

  it.each(MUST_REDISPATCH)(
    "redispatches a repeated %s instead of returning a cached result",
    async (tool) => {
      const dispatchAction = twoDistinctDispatches();
      const deps = fakeDeps({ sessionStore: fakeSessionStore("full"), dispatchAction });
      const server = createSessionServer(`nodedup-11534-${tool}`, deps);

      const args = { target: "x" };
      await callTool(server, { name: tool, arguments: args });
      const second = await callTool(server, { name: tool, arguments: args });

      expect(dispatchAction).toHaveBeenCalledTimes(2);
      // The caller sees the *second* dispatch, not a replay of the first.
      expect(JSON.stringify(second)).toContain("second");
    }
  );

  it("keeps every deduped tool reachable from a help-session tier", () => {
    // A dedup entry for a tool no tier exposes is dead weight that reads as
    // coverage. Catches an id that survives the compile-time BuiltInActionId
    // check but has drifted off every tier allowlist. `minimumPermittingTier`
    // spans core/full only, so an external-only entry would need this widened
    // rather than the entry excused.
    expect(MCP_DEDUP_ALLOWLIST.size).toBeGreaterThan(0);
    for (const tool of MCP_DEDUP_ALLOWLIST) {
      expect(minimumPermittingTier(tool)).not.toBeNull();
    }
  });
});

describe("worktree.create redispatch (#11880)", () => {
  // The primitive was LLM-callable from the old `system` tier, and dedup had to
  // stay off it: deleting a worktree leaves its branch behind and the host
  // reuses that stale branch on the next create (#6463), so create -> delete ->
  // recreate with identical arguments is a supported workflow, and caching the
  // first id would return a worktree that no longer exists. Explicit-root
  // creation then left MCP with the core/full split in favour of
  // `worktree.createWithRecipe`, so what this pins now is that it cannot come
  // back through either door.
  const createArgs = {
    worktreePath: "/repo",
    options: { baseBranch: "develop", newBranch: "bugfix/issue-6463", path: "/repo-wt-a" },
  };

  it("refuses worktree.create from the assistant's full tool set without dispatching", async () => {
    const dispatchAction = vi.fn();
    const deps = fakeDeps({ sessionStore: fakeSessionStore("full"), dispatchAction });
    deps.sessionStore.sessionOriginMap.set("recreate-11880", "help");
    const server = createSessionServer("recreate-11880", deps);

    const result = await callTool(server, { name: "worktree.create", arguments: createArgs });

    expect(toolErrorPayload(result).code).toBe(TIER_NOT_PERMITTED_CODE);
    expect(dispatchAction).not.toHaveBeenCalled();
  });
});
