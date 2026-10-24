import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  app: {
    getVersion: () => "0.0.0-test",
  },
}));

import { createSessionServer } from "../sessionServer.js";
import type { SessionStore } from "../sessionStore.js";
import { SessionStore as RealSessionStore } from "../sessionStore.js";
import { TIER_NOT_PERMITTED_CODE, SESSION_GONE, TIER_ALLOWLISTS } from "../shared.js";
import {
  OWNED_TWIN_TOOLS,
  RENDERER_OWNED_ORIGIN_ONLY_TOOLS,
} from "../../../../shared/config/helpAssistantTierAllowlists.js";
import {
  fakeSessionStore,
  fakeDeps,
  makeMockTransport,
  callTool,
  listTools,
  seedLiveSession,
  makeManifestEntry,
} from "./helpers/sessionServerFixture.js";

describe("sessionServer tier-mismatch notifier", () => {
  async function callTool(
    server: ReturnType<typeof createSessionServer>,
    params: { name: string; arguments?: Record<string, unknown> }
  ) {
    const handlers = (
      server as unknown as {
        _requestHandlers: Map<string, (req: unknown, extra: unknown) => Promise<unknown>>;
      }
    )._requestHandlers;
    const handler = handlers.get("tools/call");
    if (!handler) throw new Error("tools/call handler not found");
    return handler(
      {
        method: "tools/call",
        params,
        jsonrpc: "2.0",
        id: 1,
      },
      {
        signal: new AbortController().signal,
        _meta: {},
        sendNotification: vi.fn(),
        requestId: 1,
      }
    );
  }

  it("invokes notifyTierMismatch with targetTier when a core session calls a tool above its tier", async () => {
    const notify = vi.fn();
    const dispatchAction = vi.fn();
    const handleProjectRunCheck = vi.fn();
    const deps = fakeDeps({ notifyTierMismatch: notify, dispatchAction, handleProjectRunCheck });
    const server = createSessionServer("session-A", deps);
    await server.connect(makeMockTransport());

    // project.runCheck is in FULL_TIER_ADDONS — denied at core, and the
    // banner's recovery target is the tier that would permit it.
    const result = (await callTool(server, {
      name: "project.runCheck",
      arguments: { projectId: "proj-1", runnerId: "npm-test" },
    })) as { isError?: boolean; content: Array<{ text: string }> };

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("TIER_NOT_PERMITTED");
    expect(dispatchAction).not.toHaveBeenCalled();
    expect(handleProjectRunCheck).not.toHaveBeenCalled();
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith({
      sessionId: "session-A",
      toolId: "project.runCheck",
      tier: "core",
      targetTier: "full",
    });
  });

  it("points the assistant's core session at `full` for worktree resource teardown", async () => {
    // Both deletes are core for the assistant (#13135); resource teardown
    // still needs `full`, and the banner must name the tier that actually
    // covers what was called.
    const notify = vi.fn();
    const deps = fakeDeps({ notifyTierMismatch: notify });
    deps.sessionStore.sessionOriginMap.set("session-A2", "help");
    const server = createSessionServer("session-A2", deps);
    await server.connect(makeMockTransport());

    await callTool(server, { name: "worktree.resource.teardown", arguments: {} });

    expect(notify).toHaveBeenCalledWith(
      expect.objectContaining({
        toolId: "worktree.resource.teardown",
        tier: "core",
        targetTier: "full",
      })
    );
  });

  it("admits the unscoped worktree.delete for the assistant's core session (#13135)", async () => {
    // A worktree an earlier help session made — or this assistant's own from
    // before a restart — has no ownership record here, so the delete has to
    // reach it unscoped. It is refused by nothing but the confirm gate.
    const notify = vi.fn();
    const dispatchAction = vi.fn().mockResolvedValue({ result: { ok: true, result: null } });
    const deps = fakeDeps({ notifyTierMismatch: notify, dispatchAction });
    deps.sessionStore.sessionOriginMap.set("session-A4", "help");
    const server = createSessionServer("session-A4", deps);
    await server.connect(makeMockTransport());

    const result = (await callTool(server, {
      name: "worktree.delete",
      arguments: { worktreeId: "wt-from-an-earlier-session" },
    })) as { isError?: boolean };

    expect(notify).not.toHaveBeenCalled();
    expect(result.isError).not.toBe(true);
    expect(dispatchAction).toHaveBeenCalledWith(
      "worktree.delete",
      expect.objectContaining({ worktreeId: "wt-from-an-earlier-session" }),
      false
    );
  });

  it("offers no recovery tier for an unscoped tool outside the caller's origin surface", async () => {
    // A session that is not the assistant is admitted against the owned
    // projection, where `worktree.delete` never appears at any tier — its
    // `worktree.deleteOwned` twin does. Pointing it at `full` would promise an
    // elevation that still refuses the call.
    const notify = vi.fn();
    const deps = fakeDeps({ notifyTierMismatch: notify });
    const server = createSessionServer("session-A3", deps);
    await server.connect(makeMockTransport());

    await callTool(server, { name: "worktree.delete", arguments: {} });

    expect(notify).toHaveBeenCalledWith(
      expect.objectContaining({
        toolId: "worktree.delete",
        tier: "core",
        targetTier: null,
      })
    );
  });

  it("does not invoke notifyTierMismatch when the call is permitted", async () => {
    const notify = vi.fn();
    const dispatchAction = vi.fn().mockResolvedValue({ result: { ok: true, result: { ok: 1 } } });
    const deps = fakeDeps({ notifyTierMismatch: notify, dispatchAction });
    const server = createSessionServer("session-B", deps);
    await server.connect(makeMockTransport());

    // worktree.list is in CORE_TIER_TOOLS — permitted at core.
    await callTool(server, { name: "worktree.list", arguments: {} });

    expect(notify).not.toHaveBeenCalled();
    expect(dispatchAction).toHaveBeenCalled();
  });

  it("computes targetTier=full for an owned twin only the projected full set carries", async () => {
    // `terminal.injectOwned` is on no list as written; it reaches a session
    // that is not the assistant only as the twin of full's `terminal.inject`.
    // The target has to be read from that projection, not the assistant's.
    const notify = vi.fn();
    const deps = fakeDeps({ notifyTierMismatch: notify });
    const server = createSessionServer("session-C", deps);
    await server.connect(makeMockTransport());

    await callTool(server, {
      name: "terminal.injectOwned",
      arguments: { terminalId: "t-1" },
    });

    expect(notify).toHaveBeenCalledWith(
      expect.objectContaining({
        toolId: "terminal.injectOwned",
        targetTier: "full",
      })
    );
  });

  it("offers no recovery tier for worktree.create, which is on neither tool set", async () => {
    // Explicit-root creation left MCP with the core/full split in favour of
    // `worktree.createWithRecipe`, so no elevation reaches it and a banner
    // offering one would be a promise the next call breaks. A null target is
    // what withholds "Approve once" and "Always allow".
    const notify = vi.fn();
    const deps = fakeDeps({ notifyTierMismatch: notify });
    const server = createSessionServer("session-C2", deps);
    await server.connect(makeMockTransport());

    await callTool(server, { name: "worktree.create", arguments: {} });

    expect(notify).toHaveBeenCalledWith(
      expect.objectContaining({
        toolId: "worktree.create",
        targetTier: null,
      })
    );
  });

  it("survives a notifyTierMismatch throw without crashing the call", async () => {
    const notify = vi.fn(() => {
      throw new Error("boom");
    });
    const deps = fakeDeps({ notifyTierMismatch: notify });
    const server = createSessionServer("session-D", deps);
    await server.connect(makeMockTransport());

    // The denial response should still be returned even if the notifier throws.
    const result = (await callTool(server, {
      name: "worktree.delete",
      arguments: {},
    })) as { isError?: boolean; content: Array<{ text: string }> };

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("TIER_NOT_PERMITTED");
  });
});

describe("sessionServer grant cache fallback (#8442)", () => {
  /**
   * A session on the assistant's own origin. Grants are only ever issued to
   * one, and it is the only origin whose surface names the unscoped
   * `worktree.delete` — every other session holds `worktree.deleteOwned` in its
   * place at every tier.
   */
  function assistantSessionStore(tier: "core" | "full"): SessionStore {
    const store = fakeSessionStore(tier);
    store.sessionOriginMap.set("s", "help");
    return store;
  }

  async function callTool(
    server: ReturnType<typeof createSessionServer>,
    params: { name: string; arguments?: Record<string, unknown> }
  ) {
    const handlers = (
      server as unknown as {
        _requestHandlers: Map<string, (req: unknown, extra: unknown) => Promise<unknown>>;
      }
    )._requestHandlers;
    const handler = handlers.get("tools/call");
    if (!handler) throw new Error("tools/call handler not found");
    return handler(
      {
        method: "tools/call",
        params,
        jsonrpc: "2.0",
        id: 1,
      },
      {
        signal: new AbortController().signal,
        _meta: {},
        sendNotification: vi.fn(),
        requestId: 1,
      }
    );
  }

  it("floor-permitted tool skips the per-tool grant but still peeks native pre-authorization", async () => {
    const sessionStore = fakeSessionStore("core");
    const checkSpy = vi.spyOn(sessionStore.grantCache, "check");
    const peekSpy = vi.spyOn(sessionStore.grantCache, "peekNativeGrant");
    const dispatchAction = vi.fn().mockResolvedValue({ result: { ok: true, result: { ok: 1 } } });
    const deps = fakeDeps({ sessionStore, dispatchAction });
    const server = createSessionServer("s", deps);
    await server.connect(makeMockTransport());

    // worktree.list is in CORE_TIER_TOOLS → static floor permits.
    await callTool(server, { name: "worktree.list", arguments: {} });

    expect(dispatchAction).toHaveBeenCalled();
    // A per-tool grant only widens the floor, so it has nothing to say once
    // the floor already admits the call.
    expect(checkSpy).not.toHaveBeenCalled();
    // A native grant ALSO pre-authorizes the confirm modal, which is
    // orthogonal to the floor — so it is consulted on this leg too (#11878).
    expect(peekSpy).toHaveBeenCalledWith("s", "worktree.list");
    // No grant exists here, so the dispatch stays unconfirmed.
    expect(dispatchAction).toHaveBeenCalledWith("worktree.list", expect.any(Object), false);
    sessionStore.grantCache.dispose();
  });

  it("native grant pre-authorizes a tier-permitted confirm tool and consumes a use (#11878)", async () => {
    // worktree.delete is `danger: "confirm"` but IS in the full tool set, so
    // the floor admits it and the tier-denied leg never runs. Before #11878
    // that made the grant unreachable and the modal fired on every call despite
    // an explicit Settings pre-authorization.
    const sessionStore = assistantSessionStore("full");
    // Unref'd for the reason `seedLiveSession` documents: a referenced
    // 1,000,000 ms timer holds the Vitest worker open past the suite.
    const idleTimer = setTimeout(() => {}, 1_000_000);
    idleTimer.unref?.();
    sessionStore.sessions.set("s", {
      transport: {} as never,
      server: {} as never,
      idleTimer,
    });
    const resetIdle = sessionStore.resetIdleTimer as ReturnType<typeof vi.fn>;
    resetIdle.mockClear();
    const grant = sessionStore.grantCache.issueNativeGrant({
      sessionId: "s",
      actorId: "help-1",
      actorType: "help-session",
      allowedTools: ["worktree.delete"],
      maxUses: 2,
    });
    const refreshSpy = vi.spyOn(sessionStore.grantCache, "refreshNativeGrant");
    const checkSpy = vi.spyOn(sessionStore.grantCache, "check");
    const dispatchAction = vi.fn().mockResolvedValue({ result: { ok: true, result: { ok: 1 } } });
    const deps = fakeDeps({ sessionStore, dispatchAction });
    const server = createSessionServer("s", deps);
    await server.connect(makeMockTransport());

    const result = (await callTool(server, {
      name: "worktree.delete",
      arguments: { worktreeId: "wt-1" },
    })) as { isError?: boolean };

    expect(result.isError).not.toBe(true);
    // Pins the leg: an untouched per-tool cache proves the floor admitted this
    // call, so the bypass below can only have come from the native grant.
    expect(checkSpy).not.toHaveBeenCalled();
    expect(dispatchAction).toHaveBeenCalledTimes(1);
    expect(dispatchAction).toHaveBeenCalledWith(
      "worktree.delete",
      expect.objectContaining({ worktreeId: "wt-1" }),
      true
    );
    expect(refreshSpy).toHaveBeenCalledWith(grant.id);
    expect(resetIdle).toHaveBeenCalledWith("s");
    expect(sessionStore.grantCache._peekNative(grant.id)?.remainingUses).toBe(1);
    sessionStore.grantCache.dispose();
  });

  it("a spent grant leaves a tier-permitted confirm tool dispatching unconfirmed (#11878)", async () => {
    // The non-mocked proof that the grant only ever bought the modal bypass:
    // once its single use is gone the call must still run — just with the
    // modal back. The tier-denied equivalent fails closed instead, because
    // there the grant was the authorization itself.
    const sessionStore = assistantSessionStore("full");
    sessionStore.grantCache.issueNativeGrant({
      sessionId: "s",
      actorId: "help-1",
      actorType: "help-session",
      allowedTools: ["worktree.delete"],
      maxUses: 1,
    });
    const dispatchAction = vi.fn().mockResolvedValue({ result: { ok: true, result: { ok: 1 } } });
    const deps = fakeDeps({ sessionStore, dispatchAction });
    const server = createSessionServer("s", deps);
    await server.connect(makeMockTransport());

    // Distinct args on the second call: worktree.delete is on the dedup
    // allowlist, so a replay would return the cached result and never reach
    // the gate this test is about.
    const first = (await callTool(server, {
      name: "worktree.delete",
      arguments: { worktreeId: "wt-1" },
    })) as { isError?: boolean };
    const second = (await callTool(server, {
      name: "worktree.delete",
      arguments: { worktreeId: "wt-2" },
    })) as { isError?: boolean };

    expect(first.isError).not.toBe(true);
    expect(second.isError).not.toBe(true);
    expect(dispatchAction).toHaveBeenNthCalledWith(1, "worktree.delete", expect.any(Object), true);
    expect(dispatchAction).toHaveBeenNthCalledWith(2, "worktree.delete", expect.any(Object), false);
    sessionStore.grantCache.dispose();
  });

  it("a per-tool grant does not suppress native confirm pre-authorization (#11878)", async () => {
    // Both grant kinds can be live at once. The per-tool grant is what admits
    // the call past the denying floor, but only the native grant can waive the
    // modal — so holding both must still waive it. The native peek used to sit
    // behind the per-tool check, which made an explicit Settings
    // pre-authorization silently do nothing here, exactly as it did for a
    // tier-permitted tool.
    const sessionStore = assistantSessionStore("core");
    sessionStore.grantCache.issueGrant("s", "worktree.resource.teardown");
    const grant = sessionStore.grantCache.issueNativeGrant({
      sessionId: "s",
      actorId: "help-1",
      actorType: "help-session",
      allowedTools: ["worktree.resource.teardown"],
      maxUses: 2,
    });
    const dispatchAction = vi.fn().mockResolvedValue({ result: { ok: true, result: { ok: 1 } } });
    const deps = fakeDeps({ sessionStore, dispatchAction });
    const server = createSessionServer("s", deps);
    await server.connect(makeMockTransport());

    await callTool(server, { name: "worktree.resource.teardown", arguments: {} });

    expect(dispatchAction).toHaveBeenCalledWith(
      "worktree.resource.teardown",
      expect.any(Object),
      true
    );
    expect(sessionStore.grantCache._peekNative(grant.id)?.remainingUses).toBe(1);
    sessionStore.grantCache.dispose();
  });

  it("a tier-permitted call falls back to the modal when the grant dies between peek and consume (#11878)", async () => {
    // The tier still admits the call, so losing the grant costs only the
    // bypass. Refusing here would report "not permitted for the 'full'
    // tier" for an action that tier plainly permits.
    const sessionStore = assistantSessionStore("full");
    const grant = sessionStore.grantCache.issueNativeGrant({
      sessionId: "s",
      actorId: "help-1",
      actorType: "help-session",
      allowedTools: ["worktree.delete"],
      maxUses: 2,
    });
    const consumeSpy = vi
      .spyOn(sessionStore.grantCache, "consumeNativeGrantUse")
      .mockReturnValue(false);
    const dispatchAction = vi.fn().mockResolvedValue({ result: { ok: true, result: { ok: 1 } } });
    const deps = fakeDeps({ sessionStore, dispatchAction });
    const server = createSessionServer("s", deps);
    await server.connect(makeMockTransport());

    const result = (await callTool(server, {
      name: "worktree.delete",
      arguments: {},
    })) as { isError?: boolean };

    // Without this the test would pass for the wrong reason: never peeking at
    // all also yields an unconfirmed dispatch.
    expect(consumeSpy).toHaveBeenCalledWith(grant.id, "worktree.delete");
    expect(result.isError).not.toBe(true);
    expect(dispatchAction).toHaveBeenCalledWith("worktree.delete", expect.any(Object), false);
    sessionStore.grantCache.dispose();
  });

  it("a tier-denied call still fails closed when the grant dies between peek and consume (#11878)", async () => {
    // Here the grant WAS the authorization, so losing it must fail closed.
    const sessionStore = assistantSessionStore("core");
    const grant = sessionStore.grantCache.issueNativeGrant({
      sessionId: "s",
      actorId: "help-1",
      actorType: "help-session",
      allowedTools: ["worktree.resource.teardown"],
      maxUses: 2,
    });
    const consumeSpy = vi
      .spyOn(sessionStore.grantCache, "consumeNativeGrantUse")
      .mockReturnValue(false);
    const dispatchAction = vi.fn().mockResolvedValue({ result: { ok: true, result: { ok: 1 } } });
    const deps = fakeDeps({ sessionStore, dispatchAction });
    const server = createSessionServer("s", deps);
    await server.connect(makeMockTransport());

    const result = (await callTool(server, {
      name: "worktree.resource.teardown",
      arguments: {},
    })) as { isError?: boolean; content?: Array<{ text?: string }> };

    // Proves the refusal came from the consume-failure guard rather than the
    // ordinary tier denial, which would produce the same error for a
    // different reason.
    expect(consumeSpy).toHaveBeenCalledWith(grant.id, "worktree.resource.teardown");
    expect(result.isError).toBe(true);
    expect(result.content?.[0]?.text ?? "").toContain(TIER_NOT_PERMITTED_CODE);
    expect(dispatchAction).not.toHaveBeenCalled();
    sessionStore.grantCache.dispose();
  });

  it("a per-tool grant keeps a lost native grant from failing the call closed (#11878)", async () => {
    // The floor denies, so only the per-tool grant admits this — which is why
    // the consume-failure guard has to ask "did anything else admit this?"
    // rather than "did the tier permit this?". Under the narrower question
    // this call would be refused as tier-denied even though a live grant
    // admitted it.
    const sessionStore = assistantSessionStore("core");
    sessionStore.grantCache.issueGrant("s", "worktree.resource.teardown");
    const grant = sessionStore.grantCache.issueNativeGrant({
      sessionId: "s",
      actorId: "help-1",
      actorType: "help-session",
      allowedTools: ["worktree.resource.teardown"],
      maxUses: 2,
    });
    const consumeSpy = vi
      .spyOn(sessionStore.grantCache, "consumeNativeGrantUse")
      .mockReturnValue(false);
    const dispatchAction = vi.fn().mockResolvedValue({ result: { ok: true, result: { ok: 1 } } });
    const deps = fakeDeps({ sessionStore, dispatchAction });
    const server = createSessionServer("s", deps);
    await server.connect(makeMockTransport());

    const result = (await callTool(server, {
      name: "worktree.resource.teardown",
      arguments: {},
    })) as { isError?: boolean };

    expect(consumeSpy).toHaveBeenCalledWith(grant.id, "worktree.resource.teardown");
    expect(result.isError).not.toBe(true);
    expect(dispatchAction).toHaveBeenCalledWith(
      "worktree.resource.teardown",
      expect.any(Object),
      false
    );
    sessionStore.grantCache.dispose();
  });

  it("a tier-permitted non-confirm tool in the grant's allowlist still spends a use (#11878)", async () => {
    // Decision lock, not an endorsement: `maxUses` is a budget of matching
    // dispatches, and spending one only where the bypass is actually needed
    // would mean resolving effective danger — async manifest plus
    // args-conditional elevation — before the consume site. Over-charging
    // fails toward more confirmation, so it is the safe direction to accept.
    const sessionStore = fakeSessionStore("core");
    const grant = sessionStore.grantCache.issueNativeGrant({
      sessionId: "s",
      actorId: "help-1",
      actorType: "help-session",
      allowedTools: ["worktree.list"],
      maxUses: 2,
    });
    const checkSpy = vi.spyOn(sessionStore.grantCache, "check");
    const dispatchAction = vi.fn().mockResolvedValue({ result: { ok: true, result: { ok: 1 } } });
    const deps = fakeDeps({ sessionStore, dispatchAction });
    const server = createSessionServer("s", deps);
    await server.connect(makeMockTransport());

    await callTool(server, { name: "worktree.list", arguments: {} });

    // Pins the leg — an untouched per-tool cache means the floor admitted it.
    expect(checkSpy).not.toHaveBeenCalled();
    expect(dispatchAction).toHaveBeenCalledWith("worktree.list", expect.any(Object), true);
    expect(sessionStore.grantCache._peekNative(grant.id)?.remainingUses).toBe(1);
    sessionStore.grantCache.dispose();
  });

  it("terminal.closeAll cannot ride a native grant past the confirm modal (#12121)", async () => {
    // Issuance refuses a scope naming a fan-out tool, so this grant is minted
    // through the cache directly — the stale/hand-rolled state the peek and
    // consume guards exist to catch. The floor already admits terminal.closeAll
    // in the assistant's full tool set, so the call must still run; what it
    // must NOT do is arrive pre-confirmed or spend a use, because `maxUses`
    // cannot express "every terminal in the project".
    const sessionStore = assistantSessionStore("full");
    const grant = sessionStore.grantCache.issueNativeGrant({
      sessionId: "s",
      actorId: "help-1",
      actorType: "help-session",
      allowedTools: ["terminal.closeAll"],
      maxUses: 3,
    });
    const consumeSpy = vi.spyOn(sessionStore.grantCache, "consumeNativeGrantUse");
    const refreshSpy = vi.spyOn(sessionStore.grantCache, "refreshNativeGrant");
    const dispatchAction = vi.fn().mockResolvedValue({ result: { ok: true, result: { ok: 1 } } });
    const deps = fakeDeps({ sessionStore, dispatchAction });
    const server = createSessionServer("s", deps);
    await server.connect(makeMockTransport());

    const result = (await callTool(server, {
      name: "terminal.closeAll",
      arguments: {},
    })) as { isError?: boolean };

    expect(result.isError).not.toBe(true);
    // Dispatched, but unconfirmed — the renderer's modal decides, exactly as it
    // would with no grant at all.
    expect(dispatchAction).toHaveBeenCalledWith("terminal.closeAll", expect.any(Object), false);
    expect(consumeSpy).not.toHaveBeenCalled();
    expect(sessionStore.grantCache._peekNative(grant.id)?.remainingUses).toBe(3);
    // An untouched budget alone would not prove the grant was left alone: the
    // post-dispatch refresh slides `expiresAt`, so a refused tool must not
    // extend the window its eligible siblings are still running on.
    expect(refreshSpy).not.toHaveBeenCalled();
    sessionStore.grantCache.dispose();
  });

  it("a native grant cannot admit terminal.closeAll below the tier floor (#12121)", async () => {
    // The other leg: at core nothing else admits the call, so a grant that
    // covered it would be the authorization itself. It must fail closed rather
    // than fall through to an unauthorized dispatch.
    const sessionStore = assistantSessionStore("core");
    const grant = sessionStore.grantCache.issueNativeGrant({
      sessionId: "s",
      actorId: "help-1",
      actorType: "help-session",
      allowedTools: ["terminal.closeAll"],
      maxUses: 3,
    });
    const dispatchAction = vi.fn().mockResolvedValue({ result: { ok: true, result: { ok: 1 } } });
    const deps = fakeDeps({ sessionStore, dispatchAction });
    const server = createSessionServer("s", deps);
    await server.connect(makeMockTransport());

    const result = (await callTool(server, {
      name: "terminal.closeAll",
      arguments: {},
    })) as { isError?: boolean; content: Array<{ type: string; text: string }> };

    expect(result.isError).toBe(true);
    // The specific code matters: this must read as an authorization denial the
    // caller can act on, not a generic dispatch failure.
    expect(JSON.parse(result.content[0]!.text)).toMatchObject({ code: TIER_NOT_PERMITTED_CODE });
    expect(dispatchAction).not.toHaveBeenCalled();
    expect(sessionStore.grantCache._peekNative(grant.id)?.remainingUses).toBe(3);
    sessionStore.grantCache.dispose();
  });

  it("an already-admitted introspection carrier does not spend a native use (#11878)", async () => {
    // actions.search can never raise a confirm modal, so once the floor has
    // admitted it a grant buys it nothing — peeking would only drain the
    // automation budget on a discovery call and evict entries mid-enumeration.
    // The peek still runs when the carrier is NOT otherwise admitted, because
    // there the grant is what authorizes it.
    const sessionStore = fakeSessionStore("core");
    const grant = sessionStore.grantCache.issueNativeGrant({
      sessionId: "s",
      actorId: "help-1",
      actorType: "help-session",
      allowedTools: ["actions.search"],
      maxUses: 2,
    });
    const peekSpy = vi.spyOn(sessionStore.grantCache, "peekNativeGrant");
    const dispatchAction = vi.fn().mockResolvedValue({ result: { ok: true, result: { ok: 1 } } });
    const deps = fakeDeps({ sessionStore, dispatchAction });
    const server = createSessionServer("s", deps);
    await server.connect(makeMockTransport());

    await callTool(server, { name: "actions.search", arguments: { query: "worktree" } });

    // The dispatch assertion keeps this honest: skipping the peek must be the
    // guard doing its job, not the call bailing out before it gets there.
    expect(dispatchAction).toHaveBeenCalled();
    expect(peekSpy).not.toHaveBeenCalled();
    expect(sessionStore.grantCache._peekNative(grant.id)?.remainingUses).toBe(2);
    sessionStore.grantCache.dispose();
  });

  it("denied tool with an active grant dispatches and refreshes TTL on success", async () => {
    const sessionStore = assistantSessionStore("core");
    sessionStore.sessions.set("s", {
      transport: {} as never,
      server: {} as never,
      idleTimer: setTimeout(() => {}, 1_000_000),
    });
    const resetIdle = sessionStore.resetIdleTimer as ReturnType<typeof vi.fn>;
    resetIdle.mockClear();
    sessionStore.grantCache.issueGrant("s", "worktree.resource.teardown");
    const refreshSpy = vi.spyOn(sessionStore.grantCache, "refresh");
    const dispatchAction = vi.fn().mockResolvedValue({ result: { ok: true, result: { ok: 1 } } });
    const notify = vi.fn();
    const deps = fakeDeps({ sessionStore, dispatchAction, notifyTierMismatch: notify });
    const server = createSessionServer("s", deps);
    await server.connect(makeMockTransport());

    const result = (await callTool(server, {
      name: "worktree.resource.teardown",
      arguments: {},
    })) as { isError?: boolean };

    expect(result.isError).not.toBe(true);
    expect(dispatchAction).toHaveBeenCalledWith(
      "worktree.resource.teardown",
      expect.any(Object),
      false
    );
    expect(notify).not.toHaveBeenCalled();
    expect(refreshSpy).toHaveBeenCalledTimes(1);
    expect(resetIdle).toHaveBeenCalledWith("s");
    sessionStore.grantCache.dispose();
  });

  it("native grant authorizes a denied tool without a modal and refreshes on success (#10648)", async () => {
    const sessionStore = assistantSessionStore("core");
    sessionStore.sessions.set("s", {
      transport: {} as never,
      server: {} as never,
      idleTimer: setTimeout(() => {}, 1_000_000),
    });
    const grant = sessionStore.grantCache.issueNativeGrant({
      sessionId: "s",
      actorId: "help-1",
      actorType: "help-session",
      allowedTools: ["worktree.resource.teardown"],
      maxUses: 2,
    });
    const refreshSpy = vi.spyOn(sessionStore.grantCache, "refreshNativeGrant");
    const dispatchAction = vi.fn().mockResolvedValue({ result: { ok: true, result: { ok: 1 } } });
    const deps = fakeDeps({ sessionStore, dispatchAction });
    const server = createSessionServer("s", deps);
    await server.connect(makeMockTransport());

    const result = (await callTool(server, {
      name: "worktree.resource.teardown",
      arguments: {},
    })) as { isError?: boolean };

    expect(result.isError).not.toBe(true);
    // dispatchConfirmed=true → the native grant bypasses the confirm modal,
    // unlike a per-tool grant which dispatches with `false`.
    expect(dispatchAction).toHaveBeenCalledWith(
      "worktree.resource.teardown",
      expect.any(Object),
      true
    );
    expect(refreshSpy).toHaveBeenCalledWith(grant.id);
    // One use consumed at authorization.
    expect(sessionStore.grantCache._peekNative(grant.id)?.remainingUses).toBe(1);
    sessionStore.grantCache.dispose();
  });

  it("native grant for tool A does not authorize tool B (fails closed on scope) (#10648)", async () => {
    const sessionStore = assistantSessionStore("core");
    sessionStore.grantCache.issueNativeGrant({
      sessionId: "s",
      actorId: "help-1",
      actorType: "help-session",
      allowedTools: ["worktree.delete"],
      maxUses: 5,
    });
    const dispatchAction = vi.fn().mockResolvedValue({ result: { ok: true, result: { ok: 1 } } });
    const deps = fakeDeps({ sessionStore, dispatchAction });
    const server = createSessionServer("s", deps);
    await server.connect(makeMockTransport());

    // recipe.run is denied at the core floor AND is not in the grant's
    // allowlist → fail closed with TIER_NOT_PERMITTED, never dispatched.
    const result = (await callTool(server, {
      name: "recipe.run",
      arguments: {},
    })) as { isError?: boolean; content?: Array<{ text?: string }> };

    expect(result.isError).toBe(true);
    expect(result.content?.[0]?.text ?? "").toContain("TIER_NOT_PERMITTED");
    expect(dispatchAction).not.toHaveBeenCalled();
    sessionStore.grantCache.dispose();
  });

  it("an exhausted native grant fails closed on the next call (#10648)", async () => {
    const sessionStore = assistantSessionStore("core");
    sessionStore.sessions.set("s", {
      transport: {} as never,
      server: {} as never,
      idleTimer: setTimeout(() => {}, 1_000_000),
    });
    sessionStore.grantCache.issueNativeGrant({
      sessionId: "s",
      actorId: "help-1",
      actorType: "help-session",
      allowedTools: ["worktree.resource.teardown"],
      maxUses: 1,
    });
    const dispatchAction = vi.fn().mockResolvedValue({ result: { ok: true, result: { ok: 1 } } });
    const deps = fakeDeps({ sessionStore, dispatchAction });
    const server = createSessionServer("s", deps);
    await server.connect(makeMockTransport());

    const first = (await callTool(server, {
      name: "worktree.resource.teardown",
      arguments: {},
    })) as { isError?: boolean };
    expect(first.isError).not.toBe(true);

    const second = (await callTool(server, {
      name: "worktree.resource.teardown",
      arguments: {},
    })) as { isError?: boolean; content?: Array<{ text?: string }> };
    expect(second.isError).toBe(true);
    expect(second.content?.[0]?.text ?? "").toContain("TIER_NOT_PERMITTED");
    expect(dispatchAction).toHaveBeenCalledTimes(1);
    sessionStore.grantCache.dispose();
  });

  it("grant for tool A does not authorize tool B in the same session", async () => {
    const sessionStore = assistantSessionStore("core");
    sessionStore.grantCache.issueGrant("s", "worktree.delete");
    const dispatchAction = vi.fn();
    const notify = vi.fn();
    const deps = fakeDeps({ sessionStore, dispatchAction, notifyTierMismatch: notify });
    const server = createSessionServer("s", deps);
    await server.connect(makeMockTransport());

    // recipe.run is full-only too, distinct from worktree.delete.
    const result = (await callTool(server, {
      name: "recipe.run",
      arguments: { recipeId: "build" },
    })) as { isError?: boolean };

    expect(result.isError).toBe(true);
    expect(dispatchAction).not.toHaveBeenCalled();
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({ toolId: "recipe.run" }));
    sessionStore.grantCache.dispose();
  });

  it("failed dispatch through a grant does not refresh the TTL", async () => {
    const sessionStore = assistantSessionStore("core");
    sessionStore.grantCache.issueGrant("s", "worktree.resource.teardown");
    const refreshSpy = vi.spyOn(sessionStore.grantCache, "refresh");
    const dispatchAction = vi.fn().mockResolvedValue({
      result: { ok: false, error: { code: "BOOM", message: "boom" } },
    });
    const deps = fakeDeps({ sessionStore, dispatchAction });
    const server = createSessionServer("s", deps);
    await server.connect(makeMockTransport());

    await callTool(server, { name: "worktree.resource.teardown", arguments: {} });

    expect(dispatchAction).toHaveBeenCalled();
    expect(refreshSpy).not.toHaveBeenCalled();
    sessionStore.grantCache.dispose();
  });

  it("denials below the silence threshold fire the banner", async () => {
    const sessionStore = assistantSessionStore("core");
    const notify = vi.fn();
    const audit = vi.fn();
    const deps = fakeDeps({
      sessionStore,
      notifyTierMismatch: notify,
      appendAuditRecord: audit,
    });
    const server = createSessionServer("s", deps);
    await server.connect(makeMockTransport());

    // 1st denial.
    await callTool(server, { name: "worktree.resource.teardown", arguments: {} });
    expect(notify).toHaveBeenCalledTimes(1);

    // 2nd denial: still fires (threshold = 2 means 1st AND 2nd fire).
    await callTool(server, { name: "worktree.resource.teardown", arguments: {} });
    expect(notify).toHaveBeenCalledTimes(2);

    // 3rd denial: suppressed but audited.
    await callTool(server, { name: "worktree.resource.teardown", arguments: {} });
    expect(notify).toHaveBeenCalledTimes(2);

    // Every denial wrote an audit record.
    const unauthorizedRecords = audit.mock.calls.filter(
      (call) => call[0]?.outcome?.kind === "unauthorized"
    );
    expect(unauthorizedRecords).toHaveLength(3);
    // The third record carries bannerSuppressed: true.
    expect(unauthorizedRecords[2][0]).toMatchObject({ bannerSuppressed: true });
    expect(unauthorizedRecords[0][0].bannerSuppressed).toBeUndefined();
    expect(unauthorizedRecords[1][0].bannerSuppressed).toBeUndefined();

    sessionStore.grantCache.dispose();
  });

  it("terminal.waitUntilIdle refreshes the grant TTL and resets idle timer on success", async () => {
    const sessionStore = fakeSessionStore("core");
    sessionStore.sessions.set("s", {
      transport: {} as never,
      server: {} as never,
      idleTimer: setTimeout(() => {}, 1_000_000),
    });
    const resetIdle = sessionStore.resetIdleTimer as ReturnType<typeof vi.fn>;
    resetIdle.mockClear();
    sessionStore.grantCache.issueGrant("s", "terminal.waitUntilIdle");
    const refreshSpy = vi.spyOn(sessionStore.grantCache, "refresh");

    // waitUntilIdle is a main-process short-circuit, NOT a renderer
    // dispatch — it has its own success-path block that must apply the
    // grant-refresh + idle-timer reset.
    const handleWaitUntilIdle = vi.fn().mockResolvedValue({
      idleReason: "idle" as const,
      durationMs: 1000,
      finalState: "idle",
    });
    const dispatchAction = vi.fn();
    const deps = fakeDeps({
      sessionStore,
      handleWaitUntilIdle,
      dispatchAction,
      // The wait is core, so no floor denies it any more. An agent pane still
      // consults its session grant for a tool its tier permits (#12692), which
      // is the path that reaches this block's refresh now.
      requestApproval: vi.fn(),
    });
    const server = createSessionServer("s", deps);
    await server.connect(makeMockTransport());

    const result = (await callTool(server, {
      name: "terminal.waitUntilIdle",
      arguments: { terminalId: "t1", timeoutMs: 1000 },
    })) as { isError?: boolean };

    expect(result.isError).not.toBe(true);
    expect(handleWaitUntilIdle).toHaveBeenCalled();
    expect(dispatchAction).not.toHaveBeenCalled();
    expect(refreshSpy).toHaveBeenCalledTimes(1);
    expect(resetIdle).toHaveBeenCalledWith("s");
    sessionStore.grantCache.dispose();
  });
});

describe("CallTool rate limiter removal (#10764)", () => {
  it("dispatches a burst of mutation calls without ever rejecting with MCP_RATE_LIMITED", async () => {
    // The mutation tier used to cap mutations such as git.commit at 10/min — a
    // burst past the cap returned MCP_RATE_LIMITED before dispatch. With the
    // limiter gone, every call must reach dispatch.
    const dispatchAction = vi.fn().mockResolvedValue({ result: { ok: true, result: null } });
    const deps = fakeDeps({ sessionStore: fakeSessionStore("full"), dispatchAction });
    const server = createSessionServer("rl-removed", deps);

    const BURST = 15; // comfortably past the old mutation cap of 10
    for (let i = 0; i < BURST; i++) {
      const result = (await callTool(server, {
        name: "worktree.setActive",
        arguments: { worktreeId: `wt-${i}` },
      })) as { isError?: boolean };
      expect(result.isError).not.toBe(true);
    }

    expect(dispatchAction).toHaveBeenCalledTimes(BURST);
  });
});

describe("session-liveness gate (#11799)", () => {
  const liveStores: RealSessionStore[] = [];

  function makeStore(): RealSessionStore {
    const store = new RealSessionStore(() => {});
    liveStores.push(store);
    return store;
  }

  afterEach(() => {
    // Teardown here, not at the end of each test body: a failing assertion
    // throws past an inline dispose and leaks the seeded idle timer plus the
    // grant cache's sweep interval into the rest of the file.
    while (liveStores.length > 0) {
      const store = liveStores.pop()!;
      store.drain();
      store.grantCache.dispose();
    }
  });

  function invoke(
    server: ReturnType<typeof createSessionServer>,
    method: string,
    params: Record<string, unknown> = {}
  ) {
    const handlers = (
      server as unknown as {
        _requestHandlers: Map<string, (req: unknown, extra: unknown) => Promise<unknown>>;
      }
    )._requestHandlers;
    const handler = handlers.get(method);
    if (!handler) throw new Error(`${method} handler not found`);
    return handler(
      { method, params, jsonrpc: "2.0", id: 1 },
      {
        signal: new AbortController().signal,
        _meta: {},
        sendNotification: vi.fn(),
        requestId: 1,
      }
    );
  }

  function parseToolErrorPayload(result: unknown): Record<string, unknown> {
    const block = (result as { content: Array<{ type: string; text: string }> }).content[0];
    if (block.type !== "text") throw new Error("Expected a text block");
    return JSON.parse(block.text) as Record<string, unknown>;
  }

  /**
   * A tool `core` permits and `external` does not — derived, not named, so this
   * cannot drift into restating the allowlist. Its existence IS the issue's
   * premise: if the two tiers were a ladder there would be no such tool, and
   * falling back to core would be a narrowing rather than an escalation.
   */
  const CORE_ONLY_TOOL = [...TIER_ALLOWLISTS.core].find((id) => !TIER_ALLOWLISTS.external.has(id));

  it("has at least one tool core permits and external withholds", () => {
    // Guards the derivation above rather than a literal: were this to come back
    // undefined, every escalation test below would silently lose its teeth.
    expect(CORE_ONLY_TOOL).toBeDefined();
  });

  it.each([["sse"], ["http"]] as const)(
    "refuses a revoked external session's tools/call over %s instead of dispatching it at core",
    async (transport) => {
      // The issue verbatim: an external bearer's session is revoked while its
      // request is in flight, and the tier read that follows used to resolve to
      // the in-app fallback — a peer allowlist that permits this tool.
      const store = makeStore();
      seedLiveSession(store, "revoked-external", "external", transport);
      const dispatchAction = vi.fn().mockResolvedValue({ result: { ok: true, result: null } });
      const appendAuditRecord = vi.fn();
      const notifyTierMismatch = vi.fn();
      const recordDenial = vi.fn(() => ({ tripped: false }));
      const deps = fakeDeps({
        sessionStore: store,
        dispatchAction,
        appendAuditRecord,
        notifyTierMismatch,
        recordDenial,
      });
      const server = createSessionServer("revoked-external", deps);

      store.revokeSession("revoked-external");

      const result = await callTool(server, {
        name: CORE_ONLY_TOOL!,
        arguments: { path: "/etc/passwd" },
      });

      expect((result as { isError?: boolean }).isError).toBe(true);
      expect(parseToolErrorPayload(result)).toEqual({
        code: "SESSION_GONE",
        message: expect.stringContaining("no longer active"),
        retriable: false,
        errorCategory: "business",
      });
      // Refused at the gate, before anything observable: no dispatch, no audit
      // row under a tier the caller never held, no denial bookkeeping.
      expect(dispatchAction).not.toHaveBeenCalled();
      expect(appendAuditRecord).not.toHaveBeenCalled();
      expect(notifyTierMismatch).not.toHaveBeenCalled();
      expect(recordDenial).not.toHaveBeenCalled();
    }
  );

  it("leaves no dedup bookkeeping behind for a session refused at the gate", async () => {
    // The tier row is left behind deliberately while the transport is removed.
    // Revoking would delete both, and the un-gated read would then resolve to
    // `core`, which does not permit `terminal.new` — the call would exit at the
    // tier gate before dedup and this would pass without the fix. An orphan
    // `full` row makes the un-gated path actually dispatch and populate dedup,
    // so the assertion has something to catch.
    const store = makeStore();
    seedLiveSession(store, "gone-dedup", "full");
    const dispatchAction = vi
      .fn()
      .mockResolvedValue({ result: { ok: true, result: { terminalId: "t-1" } } });
    const deps = fakeDeps({ sessionStore: store, dispatchAction });
    const server = createSessionServer("gone-dedup", deps);

    store.sessions.delete("gone-dedup");

    const result = await callTool(server, {
      name: "terminal.new",
      arguments: { spawnedBy: { kind: "user" } },
    });

    expect(parseToolErrorPayload(result).code).toBe("SESSION_GONE");
    expect(dispatchAction).not.toHaveBeenCalled();
    expect(store.dedupInFlight.size).toBe(0);
    expect(store.dedupResultCache.size).toBe(0);
  });

  it("refuses tools/list before it costs a manifest fetch", async () => {
    // Gated ahead of `resolveManifest` on purpose: that fetch can throw
    // SESSION_BINDING_GONE, which would answer "your workspace went away" to a
    // caller whose session is what actually went away.
    const store = makeStore();
    seedLiveSession(store, "gone-list", "external");
    const requestManifest = vi.fn().mockResolvedValue([]);
    const getCachedManifest = vi.fn(() => null);
    const deps = fakeDeps({ sessionStore: store, requestManifest, getCachedManifest });
    const server = createSessionServer("gone-list", deps);

    store.revokeSession("gone-list");

    await expect(listTools(server)).rejects.toMatchObject({
      data: { code: "SESSION_GONE", retriable: false, errorCategory: "business" },
    });
    expect(requestManifest).not.toHaveBeenCalled();
    expect(getCachedManifest).not.toHaveBeenCalled();
  });

  it("throws rather than answering discovery with an empty surface", async () => {
    // `{ tools: [] }` / `{ resources: [] }` are well-formed, cacheable answers
    // that read as "you legitimately have nothing" and carry no hint that
    // reconnecting is the fix.
    const store = makeStore();
    seedLiveSession(store, "gone-empty", "full");
    const deps = fakeDeps({ sessionStore: store });
    const server = createSessionServer("gone-empty", deps);

    store.revokeSession("gone-empty");

    for (const method of [
      "tools/list",
      "resources/list",
      "resources/templates/list",
      "prompts/list",
    ]) {
      await expect(invoke(server, method)).rejects.toMatchObject({
        data: { code: "SESSION_GONE" },
      });
    }
  });

  it("refuses resources/read for a revoked session without dispatching the backing action", async () => {
    const store = makeStore();
    seedLiveSession(store, "gone-read", "full");
    const dispatchAction = vi.fn().mockResolvedValue({ result: { ok: true, result: null } });
    const deps = fakeDeps({ sessionStore: store, dispatchAction });
    const server = createSessionServer("gone-read", deps);

    store.revokeSession("gone-read");

    await expect(
      invoke(server, "resources/read", { uri: "daintree://worktree/wt-1/pulse" })
    ).rejects.toMatchObject({ data: { code: "SESSION_GONE" } });
    expect(dispatchAction).not.toHaveBeenCalled();
  });

  it("refuses resources/subscribe for a revoked session and installs no listener", async () => {
    // Subscribing a dead session would leave an event listener pushing updates
    // at a transport that is already gone.
    const store = makeStore();
    seedLiveSession(store, "gone-sub", "full");
    const deps = fakeDeps({ sessionStore: store });
    const server = createSessionServer("gone-sub", deps);

    store.revokeSession("gone-sub");

    await expect(
      invoke(server, "resources/subscribe", { uri: "daintree://worktree/wt-1/pulse" })
    ).rejects.toMatchObject({ data: { code: "SESSION_GONE" } });
    expect(store.resourceSubscriptions.get("gone-sub")).toBeUndefined();
  });

  it("refuses prompts/get for a revoked session without reading worktree or terminal state", async () => {
    // Prompts render from live IDE state, so `collectPromptContext` dispatches
    // `worktree.getCurrent` and `terminal.getOutput`. Ungated, that is the same
    // leak as the tool path reached through the prompt surface.
    const store = makeStore();
    seedLiveSession(store, "gone-prompt", "external");
    const dispatchAction = vi.fn().mockResolvedValue({ result: { ok: true, result: null } });
    const deps = fakeDeps({ sessionStore: store, dispatchAction });
    const server = createSessionServer("gone-prompt", deps);

    store.revokeSession("gone-prompt");

    await expect(
      invoke(server, "prompts/get", {
        name: "triage_failed_agent",
        arguments: { terminal_id: "t-1" },
      })
    ).rejects.toMatchObject({ data: { code: "SESSION_GONE" } });
    expect(dispatchAction).not.toHaveBeenCalled();
  });

  it("refuses the next call after an abuse trip revokes the session mid-call", async () => {
    // The one revocation source that fires from inside a tools/call. The
    // triggering call still answers from its captured tier — it was admitted —
    // but the session is gone by the time the next request arrives.
    const store = makeStore();
    seedLiveSession(store, "abuse", "external");
    const dispatchAction = vi.fn().mockResolvedValue({ result: { ok: true, result: null } });
    const appendAuditRecord = vi.fn();
    const notifySessionRevoked = vi.fn();
    const deps = fakeDeps({
      sessionStore: store,
      dispatchAction,
      appendAuditRecord,
      recordDenial: vi.fn(() => ({ tripped: true })),
      notifySessionRevoked,
      clearDenialState: vi.fn(),
    });
    const server = createSessionServer("abuse", deps);

    const denied = await callTool(server, {
      name: CORE_ONLY_TOOL!,
      arguments: { path: "/etc/passwd" },
    });

    // Admitted, then denied on its own captured tier — not retroactively
    // rewritten into SESSION_GONE by the revocation it just triggered.
    expect(parseToolErrorPayload(denied)).toMatchObject({ code: TIER_NOT_PERMITTED_CODE });
    expect(parseToolErrorPayload(denied).message).toContain("external");
    expect(notifySessionRevoked).toHaveBeenCalledTimes(1);
    expect(store.getTier("abuse")).toBeNull();

    appendAuditRecord.mockClear();
    const afterRevoke = await callTool(server, {
      name: CORE_ONLY_TOOL!,
      arguments: { path: "/etc/passwd" },
    });

    expect(parseToolErrorPayload(afterRevoke).code).toBe("SESSION_GONE");
    expect(appendAuditRecord).not.toHaveBeenCalled();
    expect(dispatchAction).not.toHaveBeenCalled();
  });

  it("lets an already-admitted call finish on its captured tier when revocation lands mid-dispatch", async () => {
    // The one-lifetime rule: revocation stops the NEXT request, it does not
    // rewrite a call the gate already admitted. The admitted call still must
    // not resurrect dedup state for the torn-down session.
    const store = makeStore();
    seedLiveSession(store, "admitted", "full");
    let resolveDispatch: ((envelope: unknown) => void) | undefined;
    const dispatchAction = vi.fn().mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveDispatch = resolve as (envelope: unknown) => void;
        })
    );
    const deps = fakeDeps({ sessionStore: store, dispatchAction });
    const server = createSessionServer("admitted", deps);

    const inFlight = callTool(server, {
      name: "terminal.new",
      arguments: { spawnedBy: { kind: "user" } },
    });
    for (let i = 0; i < 50 && !resolveDispatch; i++) {
      await Promise.resolve();
    }
    expect(dispatchAction).toHaveBeenCalledTimes(1);
    expect(store.dedupInFlight.get("admitted")?.size).toBe(1);

    store.revokeSession("admitted");

    resolveDispatch!({ result: { ok: true, result: { terminalId: "t-admitted" } } });
    const result = await inFlight;
    for (let i = 0; i < 10; i++) await Promise.resolve();

    // Admitted work completes rather than being retroactively refused...
    expect((result as { isError?: boolean }).isError).toBeUndefined();
    // ...but writes nothing back into the torn-down session.
    expect(store.dedupInFlight.size).toBe(0);
    expect(store.dedupResultCache.size).toBe(0);
  });
});

// #12407 — the ladder tiers reach agent panes as well as the assistant. A Claude
// pane's bearer holds the project's tier with an `external` origin, and a tier
// that names unscoped terminal input used to hand it input into any terminal.
// The tier still decides what a session could reach; the origin now decides
// whether the unscoped form or its owned twin is part of it, at both gates.
describe("unscoped terminal input by session origin (#12407)", () => {
  const RESERVED = ["terminal.sendCommand", "terminal.inject", "copyTree.injectToTerminal"];

  function originDeps(origin: "help" | "external", tier: "core" | "full") {
    const manifest = [
      ...RESERVED.map((id) => ({ ...makeManifestEntry(id), kind: "command" as const })),
      { ...makeManifestEntry("terminal.sendCommandOwned"), kind: "command" as const },
      { ...makeManifestEntry("terminal.injectOwned"), kind: "command" as const },
      makeManifestEntry("mcp.surface"),
    ];
    const deps = fakeDeps({
      sessionStore: fakeSessionStore(tier),
      requestManifest: vi.fn().mockResolvedValue(manifest),
      getCachedManifest: vi.fn(() => manifest),
    });
    deps.sessionStore.sessionOriginMap.set("s-origin", origin);
    return deps;
  }

  it.each([
    // `terminal.inject` is full-only, so its owned twin is too.
    ["core", ["mcp.surface", "terminal.sendCommandOwned"]],
    ["full", ["mcp.surface", "terminal.injectOwned", "terminal.sendCommandOwned"]],
  ] as const)(
    "lists only the owned forms to an agent pane's bearer at %s",
    async (tier, expected) => {
      const server = createSessionServer("s-origin", originDeps("external", tier));
      const names = (await listTools(server)).tools.map((t) => t.name).sort();
      expect(names).toEqual(expected);
    }
  );

  // `mcp.surface` builds from its own policy object rather than the listing's,
  // so the origin has to reach it separately — and the two must agree.
  it.each([
    ["external", false],
    ["help", true],
  ] as const)("reports the same surface as tools/list for a %s session", async (origin, full) => {
    const server = createSessionServer("s-origin", originDeps(origin, "full"));
    await server.connect(makeMockTransport());

    const result = (await callTool(server, { name: "mcp.surface" })) as {
      structuredContent: { tools: Array<{ id: string }> };
    };
    const reported = result.structuredContent.tools.map((t) => t.id);
    for (const id of RESERVED) expect(reported.includes(id)).toBe(full);
    // Each origin holds one form of the input, never both.
    expect(reported.includes("terminal.sendCommandOwned")).toBe(!full);
  });

  it("lists unscoped terminal input to the assistant's help session", async () => {
    const server = createSessionServer("s-origin", originDeps("help", "full"));
    const names = (await listTools(server)).tools.map((t) => t.name);
    for (const id of RESERVED) expect(names).toContain(id);
    // The assistant holds the unscoped forms in place of the owned ones.
    expect(names).not.toContain("terminal.sendCommandOwned");
    expect(names).not.toContain("terminal.injectOwned");
  });

  it.each(Object.keys(OWNED_TWIN_TOOLS))(
    "refuses the unscoped %s from a non-renderer-owned session without dispatching",
    async (tool) => {
      const deps = originDeps("external", "full");
      const server = createSessionServer("s-origin", deps);

      const result = await callTool(server, {
        name: tool,
        arguments: { terminalId: "user-shell", worktreeId: "/repo-wt", command: "ls" },
      });

      expect(result.isError).toBe(true);
      const text = JSON.stringify(result.content);
      expect(text).toContain("TIER_NOT_PERMITTED");
      // Points at the call that would have worked rather than blaming a tier
      // the session already holds.
      expect(text).toContain(
        `Use '${(OWNED_TWIN_TOOLS as Readonly<Record<string, string>>)[tool]}'`
      );
      expect(text).not.toContain("not permitted for the 'full' tier");
      expect(deps.dispatchAction).not.toHaveBeenCalled();
    }
  );

  it("names the owned form to another machine's assistant without calling it someone it isn't", async () => {
    const deps = originDeps("external", "full");
    (deps as { relay?: unknown }).relay = {
      shellName: "studio-01",
      refuseWrite: vi.fn(() => null),
    };
    const server = createSessionServer("s-origin", deps);

    const result = await callTool(server, {
      name: "terminal.sendCommand",
      arguments: { terminalId: "user-shell", command: "ls" },
    });

    const text = JSON.stringify(result.content);
    expect(text).toContain("TIER_NOT_PERMITTED");
    expect(text).toContain("'terminal.sendCommandOwned'");
    expect(text).toContain("another machine's assistant");
    expect(text).not.toContain("reserved for Daintree's own assistant");
    expect(deps.dispatchAction).not.toHaveBeenCalled();
  });

  it.each(RENDERER_OWNED_ORIGIN_ONLY_TOOLS)(
    "refuses %s from a non-renderer-owned session without dispatching",
    async (tool) => {
      const deps = originDeps("external", "full");
      const server = createSessionServer("s-origin", deps);

      const result = await callTool(server, {
        name: tool,
        arguments: { terminalId: "user-shell", command: "ls" },
      });

      expect(result.isError).toBe(true);
      const text = JSON.stringify(result.content);
      expect(text).toContain("TIER_NOT_PERMITTED");
      // Names the actual reason: the session holds the tier this tool sits at.
      expect(text).toContain("reserved for Daintree's own assistant");
      expect(deps.dispatchAction).not.toHaveBeenCalled();
    }
  );

  // Only a tool the tier admits is described as reserved; anything above the
  // tier keeps the ordinary tier explanation.
  it("keeps the plain tier refusal when the tier itself does not admit the tool", async () => {
    const deps = fakeDeps({ sessionStore: fakeSessionStore("core") });
    const server = createSessionServer("s-origin", deps);

    const result = await callTool(server, {
      name: "copyTree.injectToTerminal",
      arguments: { terminalId: "user-shell" },
    });

    const text = JSON.stringify(result.content);
    expect(text).toContain("not permitted for the 'core' tier");
    expect(text).not.toContain("reserved");
    expect(deps.dispatchAction).not.toHaveBeenCalled();
  });

  it("dispatches unscoped submission for the assistant's help session", async () => {
    const deps = originDeps("help", "full");
    const server = createSessionServer("s-origin", deps);

    const result = await callTool(server, {
      name: "terminal.sendCommand",
      arguments: { terminalId: "user-agent", command: "run the tests" },
    });

    expect(result.isError).toBeUndefined();
    expect(deps.dispatchAction).toHaveBeenCalledWith(
      "terminal.sendCommand",
      { terminalId: "user-agent", command: "run the tests" },
      expect.anything()
    );
  });

  // A caller-chosen id that is already live does not create a terminal — the
  // spawn is refused and the original keeps running — so recording it would
  // hand the session a panel it never opened.
  it("refuses a launch under the id of a terminal that already exists, for any origin", async () => {
    for (const origin of ["external", "help"] as const) {
      const deps = originDeps(origin, "full");
      deps.isTerminalIdInUse = vi.fn((id: string) => id === "user-shell");
      const server = createSessionServer("s-origin", deps);

      const result = await callTool(server, {
        name: "agent.launch",
        arguments: { agentId: "claude", requestedId: "user-shell" },
      });

      expect(result.isError).toBe(true);
      expect(JSON.stringify(result.content)).toContain("VALIDATION_ERROR");
      expect(deps.dispatchAction).not.toHaveBeenCalled();
      expect(deps.sessionStore.resourceOwnership.owns("s-origin", "terminal", "user-shell")).toBe(
        false
      );
    }
  });

  it("launches under a requested id no terminal is using", async () => {
    const deps = originDeps("external", "full");
    const server = createSessionServer("s-origin", deps);

    const result = await callTool(server, {
      name: "agent.launch",
      arguments: { agentId: "claude", requestedId: "fresh-id" },
    });

    expect(result.isError).toBeUndefined();
    expect(deps.isTerminalIdInUse).toHaveBeenCalledWith("fresh-id");
    expect(deps.dispatchAction).toHaveBeenCalledTimes(1);
  });

  it("lets a non-renderer-owned session start an agent", async () => {
    const deps = originDeps("external", "full");
    const server = createSessionServer("s-origin", deps);

    const result = await callTool(server, {
      name: "agent.launch",
      arguments: { agentId: "claude" },
    });

    expect(result.isError).toBeUndefined();
    expect(deps.dispatchAction).toHaveBeenCalledTimes(1);
  });

  // A session whose origin was never recorded — or was already torn down — is
  // the least-privileged classification, so it gets the narrower surface.
  it("treats an unrecorded origin as not renderer-owned", async () => {
    const deps = originDeps("help", "full");
    deps.sessionStore.sessionOriginMap.delete("s-origin");
    const server = createSessionServer("s-origin", deps);

    const names = (await listTools(server)).tools.map((t) => t.name);
    for (const id of RESERVED) expect(names).not.toContain(id);
  });
});
