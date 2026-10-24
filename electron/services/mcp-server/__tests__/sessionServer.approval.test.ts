import { describe, expect, it, vi } from "vitest";
import type { ActionManifestEntry } from "../../../../shared/types/actions.js";

vi.mock("electron", () => ({
  app: {
    getVersion: () => "0.0.0-test",
  },
}));

import { createSessionServer } from "../sessionServer.js";
import type { SessionServerDeps, TerminalCloseContext } from "../sessionServer.js";
import {
  TIER_NOT_PERMITTED_CODE,
  CONFIRMATION_REQUIRED_CODE,
  USER_REJECTED_CODE,
} from "../shared.js";
import { PANE_APPROVAL_CEILING } from "../tierAuth.js";
import { RendererBridgeUnavailableError, NoFrontendAttachedError } from "../rendererBridge.js";
import type { AgentState } from "../../../../shared/types/agent.js";
import { NATIVE_GRANT_USE_POLICY_OVERRIDES } from "../../../../shared/config/nativeGrantUsePolicies.js";
import {
  listBaseTools,
  toolErrorPayload,
  fakeSessionStore,
  fakeDeps,
  makeMockTransport,
  callTool,
  makeManifestEntry,
} from "./helpers/sessionServerFixture.js";

// #12692: an agent pane's project tier is the line below which calls run
// without asking. Above it, up to the pane ceiling, a call asks the user
// instead of being refused. No tier skips a confirm-gated call's dialog.
describe("agent-pane approval (#12692)", () => {
  type Tier = "core" | "full";

  function paneServer(
    tier: Tier,
    overrides: Partial<SessionServerDeps> = {},
    sessionId = "pane-s"
  ) {
    const sessionStore = fakeSessionStore(tier);
    // Live, so a session approval has a session to be minted for.
    sessionStore.sessions.set(sessionId, {} as never);
    const requestApproval = vi
      .fn<NonNullable<SessionServerDeps["requestApproval"]>>()
      .mockResolvedValue({ result: { ok: true, result: null }, confirmationDecision: "approved" });
    const dispatchAction = vi.fn().mockResolvedValue({ result: { ok: true, result: { ok: 1 } } });
    const appendAuditRecord = vi.fn();
    const recordDenial = vi.fn(() => ({ tripped: false }));
    const notifyTierMismatch = vi.fn();
    const deps = fakeDeps({
      sessionStore,
      requestApproval,
      dispatchAction,
      appendAuditRecord,
      recordDenial,
      notifyTierMismatch,
      ...overrides,
    });
    const server = createSessionServer(sessionId, deps);
    return {
      server,
      sessionStore,
      requestApproval: deps.requestApproval as typeof requestApproval,
      dispatchAction: deps.dispatchAction as typeof dispatchAction,
      appendAuditRecord,
      recordDenial,
      notifyTierMismatch,
    };
  }

  function lastAudit(appendAuditRecord: ReturnType<typeof vi.fn>) {
    return appendAuditRecord.mock.calls.at(-1)?.[0] as Record<string, unknown>;
  }

  // The old `system` tier pre-authorized this dialog; `full`, which replaced
  // it, does not, so the pane's widest tool set still leaves the ordinary
  // confirmation to the renderer and audits no authorization of its own.
  it("leaves a confirm-gated tool to the ordinary dialog even at full", async () => {
    const pane = paneServer("full");
    await pane.server.connect(makeMockTransport());

    const result = await callTool(pane.server, {
      name: "worktree.resource.teardown",
      arguments: { worktreeId: "wt-1" },
    });

    expect(result.isError).not.toBe(true);
    expect(pane.requestApproval).not.toHaveBeenCalled();
    expect(pane.dispatchAction).toHaveBeenCalledWith(
      "worktree.resource.teardown",
      expect.any(Object),
      false
    );
    expect(lastAudit(pane.appendAuditRecord).authorization).toBeUndefined();
    pane.sessionStore.grantCache.dispose();
  });

  // #12876: the old `system` tier's auto-confirm lives on as the project's own
  // "Skip confirmations" setting, captured at launch.
  it("runs a confirm-gated tool preconfirmed for a Full pane that skips confirmations", async () => {
    const pane = paneServer("full", { paneSkipConfirmations: true });
    await pane.server.connect(makeMockTransport());

    const result = await callTool(pane.server, {
      name: "worktree.resource.teardown",
      arguments: { worktreeId: "wt-1" },
    });

    expect(result.isError).not.toBe(true);
    expect(pane.requestApproval).not.toHaveBeenCalled();
    expect(pane.dispatchAction).toHaveBeenCalledWith(
      "worktree.resource.teardown",
      expect.any(Object),
      true
    );
    expect(lastAudit(pane.appendAuditRecord).authorization).toBe("project-setting");
    pane.sessionStore.grantCache.dispose();
  });

  it("still asks before an above-tier call when a Core pane skips confirmations", async () => {
    const pane = paneServer("core", { paneSkipConfirmations: true });
    await pane.server.connect(makeMockTransport());

    await callTool(pane.server, {
      name: "worktree.resource.teardown",
      arguments: { worktreeId: "wt-1" },
    });

    expect(pane.requestApproval).toHaveBeenCalledTimes(1);
    expect(lastAudit(pane.appendAuditRecord).authorization).not.toBe("project-setting");
    pane.sessionStore.grantCache.dispose();
  });

  it("ignores skip-confirmations on a session that is not an agent pane", async () => {
    const pane = paneServer("full", { paneSkipConfirmations: true, requestApproval: undefined });
    await pane.server.connect(makeMockTransport());

    await callTool(pane.server, {
      name: "worktree.resource.teardown",
      arguments: { worktreeId: "wt-1" },
    });

    expect(pane.dispatchAction).toHaveBeenCalledWith(
      "worktree.resource.teardown",
      expect.any(Object),
      false
    );
    expect(lastAudit(pane.appendAuditRecord).authorization).toBeUndefined();
    pane.sessionStore.grantCache.dispose();
  });

  it("asks before an above-tier call instead of refusing it, then runs it once", async () => {
    const pane = paneServer("core");
    await pane.server.connect(makeMockTransport());

    const result = await callTool(pane.server, {
      name: "worktree.setActive",
      arguments: { worktreeId: "wt-1" },
    });

    expect(result.isError).not.toBe(true);
    expect(pane.requestApproval).toHaveBeenCalledWith("worktree.setActive", { worktreeId: "wt-1" });
    // The approval is the confirmation — one ask, not two.
    expect(pane.dispatchAction).toHaveBeenCalledWith(
      "worktree.setActive",
      { worktreeId: "wt-1" },
      true
    );
    expect(lastAudit(pane.appendAuditRecord)).toMatchObject({
      confirmationDecision: "approved",
      authorization: "user",
    });
    expect(pane.recordDenial).not.toHaveBeenCalled();
    expect(pane.notifyTierMismatch).not.toHaveBeenCalled();
    // "Once" mints nothing: the next call asks again.
    expect(pane.sessionStore.grantCache.check("pane-s", "worktree.setActive").granted).toBe(false);
    pane.sessionStore.grantCache.dispose();
  });

  it("refuses a declined ask with USER_REJECTED and does not count it as a denial", async () => {
    const pane = paneServer("core", {
      requestApproval: vi.fn().mockResolvedValue({
        result: { ok: false, error: { code: USER_REJECTED_CODE, message: "declined" } },
        confirmationDecision: "rejected",
      }),
    });
    await pane.server.connect(makeMockTransport());

    const result = await callTool(pane.server, { name: "worktree.setActive", arguments: {} });

    expect(result.isError).toBe(true);
    expect(toolErrorPayload(result).code).toBe(USER_REJECTED_CODE);
    expect(toolErrorPayload(result).retriable).toBe(false);
    expect(pane.dispatchAction).not.toHaveBeenCalled();
    expect(pane.recordDenial).not.toHaveBeenCalled();
    expect(pane.notifyTierMismatch).not.toHaveBeenCalled();
    expect(lastAudit(pane.appendAuditRecord)).toMatchObject({ confirmationDecision: "rejected" });
    pane.sessionStore.grantCache.dispose();
  });

  it("fails closed with CONFIRMATION_REQUIRED when no window can show the ask", async () => {
    const pane = paneServer("core", {
      requestApproval: vi.fn().mockRejectedValue(new RendererBridgeUnavailableError()),
    });
    await pane.server.connect(makeMockTransport());

    const result = await callTool(pane.server, { name: "worktree.setActive", arguments: {} });

    expect(toolErrorPayload(result).code).toBe(CONFIRMATION_REQUIRED_CODE);
    expect(pane.dispatchAction).not.toHaveBeenCalled();
    pane.sessionStore.grantCache.dispose();
  });

  it("keeps allowing a tool approved for the session, without asking again", async () => {
    const pane = paneServer("core", {
      requestApproval: vi.fn().mockResolvedValue({
        result: { ok: true, result: null },
        confirmationDecision: "approved",
        approvalScope: "session",
      }),
    });
    await pane.server.connect(makeMockTransport());

    await callTool(pane.server, { name: "worktree.setActive", arguments: { worktreeId: "wt-1" } });
    await callTool(pane.server, { name: "worktree.setActive", arguments: { worktreeId: "wt-2" } });

    expect(pane.requestApproval).toHaveBeenCalledTimes(1);
    expect(pane.dispatchAction).toHaveBeenNthCalledWith(
      2,
      "worktree.setActive",
      { worktreeId: "wt-2" },
      true
    );
    expect(lastAudit(pane.appendAuditRecord)).toMatchObject({ authorization: "session-grant" });
    pane.sessionStore.grantCache.dispose();
  });

  it("mints a session approval from the ordinary dialog of an own-tier tool", async () => {
    const dispatchAction = vi
      .fn()
      .mockResolvedValueOnce({
        result: { ok: true, result: { ok: 1 } },
        confirmationDecision: "approved",
        approvalScope: "session",
      })
      .mockResolvedValue({ result: { ok: true, result: { ok: 1 } } });
    const pane = paneServer("full", { dispatchAction });
    await pane.server.connect(makeMockTransport());

    await callTool(pane.server, {
      name: "worktree.resource.teardown",
      arguments: { worktreeId: "wt-1" },
    });
    await callTool(pane.server, {
      name: "worktree.resource.teardown",
      arguments: { worktreeId: "wt-2" },
    });

    expect(dispatchAction).toHaveBeenNthCalledWith(
      1,
      "worktree.resource.teardown",
      expect.any(Object),
      false
    );
    expect(dispatchAction).toHaveBeenNthCalledWith(
      2,
      "worktree.resource.teardown",
      expect.any(Object),
      true
    );
    pane.sessionStore.grantCache.dispose();
  });

  const teardownConfirmEntry: ActionManifestEntry = {
    ...makeManifestEntry("worktree.resource.teardown"),
    kind: "command",
    danger: "confirm",
  };

  // #14165: only a call that puts a dialog up is a wait on the person. A
  // session approval covers the next call, so that one is confirm-gated
  // without asking anyone, and must not read as waiting on a confirmation.
  it("announces a wait for the call that asks, not the one its session approval covers", async () => {
    const dispatchAction = vi
      .fn()
      .mockResolvedValueOnce({
        result: { ok: true, result: { ok: 1 } },
        confirmationDecision: "approved",
        approvalScope: "session",
      })
      .mockResolvedValue({ result: { ok: true, result: { ok: 1 } } });
    const notifyToolCallStarted = vi.fn();
    const notifyToolCallSettled = vi.fn();
    const pane = paneServer("full", {
      dispatchAction,
      notifyToolCallStarted,
      notifyToolCallSettled,
      getCachedManifest: vi.fn(() => [teardownConfirmEntry]),
    });
    await pane.server.connect(makeMockTransport());

    await callTool(pane.server, {
      name: "worktree.resource.teardown",
      arguments: { worktreeId: "wt-1" },
    });
    await callTool(pane.server, {
      name: "worktree.resource.teardown",
      arguments: { worktreeId: "wt-2" },
    });

    expect(lastAudit(pane.appendAuditRecord)).toMatchObject({ authorization: "session-grant" });
    expect(notifyToolCallStarted.mock.calls.map((c) => c[0])).toEqual([
      expect.objectContaining({ danger: true, asks: true }),
      expect.objectContaining({ danger: true, asks: false }),
    ]);
    expect(notifyToolCallSettled.mock.calls.map((c) => c[0])).toEqual([
      expect.objectContaining({ danger: true, asks: true }),
      expect.objectContaining({ danger: true, asks: false }),
    ]);
    pane.sessionStore.grantCache.dispose();
  });

  it("announces no wait for a call the pane's skip-confirmations setting preconfirms", async () => {
    const notifyToolCallStarted = vi.fn();
    const notifyToolCallSettled = vi.fn();
    const pane = paneServer("full", {
      paneSkipConfirmations: true,
      notifyToolCallStarted,
      notifyToolCallSettled,
      getCachedManifest: vi.fn(() => [teardownConfirmEntry]),
    });
    await pane.server.connect(makeMockTransport());

    await callTool(pane.server, {
      name: "worktree.resource.teardown",
      arguments: { worktreeId: "wt-1" },
    });

    expect(lastAudit(pane.appendAuditRecord).authorization).toBe("project-setting");
    expect(notifyToolCallStarted).toHaveBeenCalledWith(
      expect.objectContaining({ danger: true, asks: false })
    );
    expect(notifyToolCallSettled).toHaveBeenCalledWith(expect.objectContaining({ asks: false }));
    pane.sessionStore.grantCache.dispose();
  });

  it("neither runs nor remembers an approval for a session that ended while the user decided", async () => {
    type Envelope = Awaited<ReturnType<NonNullable<SessionServerDeps["requestApproval"]>>>;
    let approve!: (envelope: Envelope) => void;
    const pane = paneServer("core", {
      requestApproval: vi.fn(
        () =>
          new Promise<Envelope>((resolve) => {
            approve = resolve;
          })
      ),
    });
    await pane.server.connect(makeMockTransport());

    const call = callTool(pane.server, { name: "worktree.setActive", arguments: {} }).catch(
      (err) => err
    );
    await vi.waitFor(() => expect(pane.requestApproval).toHaveBeenCalled());
    // Revoked mid-dialog.
    pane.sessionStore.sessions.clear();
    vi.mocked(pane.sessionStore.getTier).mockReturnValue(null);
    approve({
      result: { ok: true, result: null },
      confirmationDecision: "approved",
      approvalScope: "session",
    });
    await call;

    expect(pane.dispatchAction).not.toHaveBeenCalled();
    expect(pane.sessionStore.grantCache.check("pane-s", "worktree.setActive").granted).toBe(false);
    pane.sessionStore.grantCache.dispose();
  });

  it("asks before a main-executed tool above the tier runs", async () => {
    const handleProjectRunCheck = vi.fn().mockResolvedValue({ exitCode: 0 });
    const requestApproval = vi.fn().mockResolvedValue({
      result: { ok: false, error: { code: USER_REJECTED_CODE, message: "declined" } },
      confirmationDecision: "rejected",
    });
    const pane = paneServer("core", { handleProjectRunCheck, requestApproval });
    await pane.server.connect(makeMockTransport());

    const result = await callTool(pane.server, {
      name: "project.runCheck",
      arguments: { projectId: "proj-1", runnerId: "npm-test" },
    });

    expect(requestApproval).toHaveBeenCalledWith("project.runCheck", expect.any(Object));
    expect(toolErrorPayload(result).code).toBe(USER_REJECTED_CODE);
    expect(handleProjectRunCheck).not.toHaveBeenCalled();
    pane.sessionStore.grantCache.dispose();
  });

  // A target-picking tool's dialog is where the user picks the targets, so an
  // approval could never stand in for it. None is within the pane ceiling any
  // more — `terminal.killBatch` and `terminal.killAll` left MCP, and
  // `terminal.closeAll` is reserved for the assistant — so a pane is refused
  // one outright rather than asked.
  it("refuses a target-picking tool outright rather than asking for it", async () => {
    for (const id of Object.keys(NATIVE_GRANT_USE_POLICY_OVERRIDES)) {
      expect(PANE_APPROVAL_CEILING.has(id)).toBe(false);
    }
    const pane = paneServer("core");
    await pane.server.connect(makeMockTransport());

    const result = await callTool(pane.server, { name: "terminal.closeAll", arguments: {} });

    expect(toolErrorPayload(result).code).toBe(TIER_NOT_PERMITTED_CODE);
    expect(pane.requestApproval).not.toHaveBeenCalled();
    expect(pane.dispatchAction).not.toHaveBeenCalled();
    pane.sessionStore.grantCache.dispose();
  });

  it("leaves a recipe dispatch's own dialog to bind the run after an approval", async () => {
    // `recipe.run` is in the full tool set. Its dialog is what ties the run to
    // the recipe the user read (#12263), so the above-tier approval must not
    // stand in for it.
    const pane = paneServer("core");
    await pane.server.connect(makeMockTransport());

    await callTool(pane.server, { name: "recipe.run", arguments: { recipeId: "r-1" } });

    expect(pane.requestApproval).toHaveBeenCalledTimes(1);
    expect(pane.dispatchAction).toHaveBeenCalledWith("recipe.run", expect.any(Object), false);
    pane.sessionStore.grantCache.dispose();
  });

  it("refuses what is outside the pane ceiling without asking", async () => {
    const pane = paneServer("full");
    await pane.server.connect(makeMockTransport());

    const result = await callTool(pane.server, {
      name: "terminal.sendCommand",
      arguments: { terminalId: "t1", command: "ls" },
    });

    expect(toolErrorPayload(result).code).toBe(TIER_NOT_PERMITTED_CODE);
    expect(pane.requestApproval).not.toHaveBeenCalled();
    expect(pane.dispatchAction).not.toHaveBeenCalled();
    pane.sessionStore.grantCache.dispose();
  });

  it("keeps a non-pane session's tier a hard ceiling", async () => {
    const pane = paneServer("core", { requestApproval: undefined });
    await pane.server.connect(makeMockTransport());

    const result = await callTool(pane.server, { name: "worktree.setActive", arguments: {} });

    expect(toolErrorPayload(result).code).toBe(TIER_NOT_PERMITTED_CODE);
    expect(pane.recordDenial).toHaveBeenCalledWith("pane-s", "tierMismatch");
    expect(pane.dispatchAction).not.toHaveBeenCalled();
    pane.sessionStore.grantCache.dispose();
  });

  it("lists above-tier tools to a pane so it can ask for them", async () => {
    const manifest = ["worktree.list", "worktree.setActive"].map((id) => makeManifestEntry(id));
    const pane = paneServer("core", { requestManifest: vi.fn().mockResolvedValue(manifest) });
    const plain = paneServer("core", {
      requestManifest: vi.fn().mockResolvedValue(manifest),
      requestApproval: undefined,
    });

    const paneNames = (await listBaseTools(pane.server)).map((tool) => tool.name);
    const plainNames = (await listBaseTools(plain.server)).map((tool) => tool.name);

    expect(paneNames).toContain("worktree.setActive");
    expect(plainNames).toContain("worktree.list");
    expect(plainNames).not.toContain("worktree.setActive");
    pane.sessionStore.grantCache.dispose();
    plain.sessionStore.grantCache.dispose();
  });
});

describe("assistant close approval (#12881)", () => {
  type Envelope = Awaited<ReturnType<NonNullable<SessionServerDeps["requestCloseApproval"]>>>;
  const approve = (selectedTargetIds: string[]): Envelope => ({
    result: { ok: true, result: { selectedTargetIds } },
    confirmationDecision: "approved",
  });

  function closeDeps(
    origin: string,
    requestCloseApproval: SessionServerDeps["requestCloseApproval"] | undefined,
    agentStates: Record<string, AgentState | TerminalCloseContext> = {}
  ) {
    const sessionStore = fakeSessionStore("core");
    const readTerminalCloseContext = vi.fn(
      async (id: string): Promise<TerminalCloseContext | null> => {
        const entry = agentStates[id];
        if (entry === undefined) return null;
        return typeof entry === "string" ? { agentState: entry } : entry;
      }
    );
    const dispatchAction = vi.fn(async (_id: string, args: unknown) => ({
      result: {
        ok: true as const,
        result: { closedIds: [(args as { terminalId: string }).terminalId] },
      },
    }));
    const deps = fakeDeps({
      sessionStore,
      dispatchAction,
      readTerminalCloseContext,
      ...(requestCloseApproval !== undefined ? { requestCloseApproval } : {}),
    });
    const start = async (sessionId: string, owned: string[] = []) => {
      (sessionStore as unknown as { sessionOriginMap: Map<string, string> }).sessionOriginMap.set(
        sessionId,
        origin
      );
      if (owned.length > 0) {
        sessionStore.resourceOwnership.record(
          sessionId,
          owned.map((id) => ({ kind: "terminal" as const, id }))
        );
      }
      const server = createSessionServer(sessionId, deps);
      await server.connect(makeMockTransport());
      return server;
    };
    return { dispatchAction, readTerminalCloseContext, start };
  }

  it("asks before the assistant closes a panel it did not open, then closes it", async () => {
    const requestCloseApproval = vi.fn().mockResolvedValue(approve(["t-user"]));
    const { dispatchAction, start } = closeDeps("help", requestCloseApproval);
    const server = await start("s-close-unowned");

    const result = await callTool(server, {
      name: "terminal.close",
      arguments: { terminalId: "t-user" },
    });

    expect(requestCloseApproval).toHaveBeenCalledWith("terminal.close", {
      terminalIds: ["t-user"],
    });
    expect(dispatchAction.mock.calls.map((c) => [c[0], c[1]])).toEqual([
      ["terminal.close", { terminalId: "t-user" }],
    ]);
    expect(result.isError).not.toBe(true);
  });

  it("closes nothing when the user declines", async () => {
    const requestCloseApproval = vi.fn().mockResolvedValue({
      result: { ok: false, error: { code: "USER_REJECTED", message: "declined" } },
      confirmationDecision: "rejected",
    });
    const { dispatchAction, start } = closeDeps("help", requestCloseApproval);
    const server = await start("s-close-declined");

    const result = await callTool(server, {
      name: "terminal.close",
      arguments: { terminalId: "t-user" },
    });

    expect(dispatchAction).not.toHaveBeenCalled();
    expect(result.isError).toBe(true);
    expect(toolErrorPayload(result).code).toBe("USER_REJECTED");
  });

  it("closes a panel the session launched, once its agent is idle, without asking", async () => {
    const requestCloseApproval = vi.fn();
    const { dispatchAction, start } = closeDeps("help", requestCloseApproval, { "t-own": "idle" });
    const server = await start("s-close-own-idle", ["t-own"]);

    await callTool(server, { name: "terminal.close", arguments: { terminalId: "t-own" } });

    expect(requestCloseApproval).not.toHaveBeenCalled();
    expect(dispatchAction).toHaveBeenCalledWith("terminal.close", { terminalId: "t-own" }, false);
  });

  it.each(["working", "waiting"] as const)(
    "asks before closing its own panel whose agent is %s",
    async (state) => {
      const requestCloseApproval = vi.fn().mockResolvedValue(approve(["t-own"]));
      const { start } = closeDeps("help", requestCloseApproval, { "t-own": state });
      const server = await start(`s-close-own-${state}`, ["t-own"]);

      await callTool(server, { name: "terminal.close", arguments: { terminalId: "t-own" } });

      expect(requestCloseApproval).toHaveBeenCalledTimes(1);
    }
  );

  describe("once its handback arrives (#13128)", () => {
    const handback = { observedAt: 2_000 };

    it("closes its own waiting panel that handed back, untouched since, without asking", async () => {
      const requestCloseApproval = vi.fn();
      const { dispatchAction, start } = closeDeps("help", requestCloseApproval, {
        "t-own": { agentState: "waiting", lastHandback: handback, lastTypedInputAt: 1_000 },
      });
      const server = await start("s-close-handed-back", ["t-own"]);

      await callTool(server, { name: "terminal.close", arguments: { terminalId: "t-own" } });

      expect(requestCloseApproval).not.toHaveBeenCalled();
      expect(dispatchAction).toHaveBeenCalledWith("terminal.close", { terminalId: "t-own" }, false);
    });

    it("closes one nobody ever typed into without asking", async () => {
      const requestCloseApproval = vi.fn();
      const { dispatchAction, start } = closeDeps("help", requestCloseApproval, {
        "t-own": { agentState: "waiting", lastHandback: handback },
      });
      const server = await start("s-close-handed-back-untyped", ["t-own"]);

      await callTool(server, { name: "terminal.close", arguments: { terminalId: "t-own" } });

      expect(requestCloseApproval).not.toHaveBeenCalled();
      expect(dispatchAction).toHaveBeenCalledTimes(1);
    });

    it.each([
      ["typed into after the handback", { lastTypedInputAt: 3_000 }],
      ["typed into in the same millisecond", { lastTypedInputAt: 2_000 }],
      ["with no handback", { lastHandback: undefined }],
    ])("asks before closing its own waiting panel %s", async (_label, overrides) => {
      const requestCloseApproval = vi.fn().mockResolvedValue(approve(["t-own"]));
      const { start } = closeDeps("help", requestCloseApproval, {
        "t-own": { agentState: "waiting", lastHandback: handback, ...overrides },
      });
      const server = await start("s-close-handed-back-touched", ["t-own"]);

      await callTool(server, { name: "terminal.close", arguments: { terminalId: "t-own" } });

      expect(requestCloseApproval).toHaveBeenCalledTimes(1);
    });

    it("asks before closing its own panel whose agent is working again", async () => {
      const requestCloseApproval = vi.fn().mockResolvedValue(approve(["t-own"]));
      const { start } = closeDeps("help", requestCloseApproval, {
        "t-own": { agentState: "working", lastHandback: handback },
      });
      const server = await start("s-close-handed-back-working", ["t-own"]);

      await callTool(server, { name: "terminal.close", arguments: { terminalId: "t-own" } });

      expect(requestCloseApproval).toHaveBeenCalledTimes(1);
    });

    it("asks before closing a panel it did not open, even one that handed back", async () => {
      const requestCloseApproval = vi.fn().mockResolvedValue(approve(["t-user"]));
      const { start } = closeDeps("help", requestCloseApproval, {
        "t-user": { agentState: "waiting", lastHandback: handback },
      });
      const server = await start("s-close-handed-back-unowned");

      await callTool(server, { name: "terminal.close", arguments: { terminalId: "t-user" } });

      expect(requestCloseApproval).toHaveBeenCalledTimes(1);
    });

    it("closes several handed-back panels it launched in bulk without asking", async () => {
      const requestCloseApproval = vi.fn();
      const { dispatchAction, start } = closeDeps("help", requestCloseApproval, {
        "t-a": { agentState: "waiting", lastHandback: handback },
        "t-b": { agentState: "waiting", lastHandback: handback, lastTypedInputAt: 1_500 },
      });
      const server = await start("s-close-many-handed-back", ["t-a", "t-b"]);

      await callTool(server, {
        name: "terminal.closeMany",
        arguments: { terminalIds: ["t-a", "t-b"] },
      });

      expect(requestCloseApproval).not.toHaveBeenCalled();
      expect(dispatchAction).toHaveBeenCalledTimes(2);
    });

    it("asks once in bulk when one of its panels was typed into after its handback", async () => {
      const requestCloseApproval = vi.fn().mockResolvedValue(approve(["t-a", "t-b"]));
      const { start } = closeDeps("help", requestCloseApproval, {
        "t-a": { agentState: "waiting", lastHandback: handback },
        "t-b": { agentState: "waiting", lastHandback: handback, lastTypedInputAt: 2_500 },
      });
      const server = await start("s-close-many-handed-back-mixed", ["t-a", "t-b"]);

      await callTool(server, {
        name: "terminal.closeMany",
        arguments: { terminalIds: ["t-a", "t-b"] },
      });

      expect(requestCloseApproval).toHaveBeenCalledTimes(1);
    });
  });

  it.each(["directing", "completed", "exited"] as const)(
    "closes its own panel whose agent is %s without asking",
    async (state) => {
      const requestCloseApproval = vi.fn();
      const { dispatchAction, start } = closeDeps("help", requestCloseApproval, {
        "t-own": state,
      });
      const server = await start(`s-close-own-${state}`, ["t-own"]);

      await callTool(server, { name: "terminal.close", arguments: { terminalId: "t-own" } });

      expect(requestCloseApproval).not.toHaveBeenCalled();
      expect(dispatchAction).toHaveBeenCalledTimes(1);
    }
  );

  it("asks when its own panel's agent state cannot be read", async () => {
    const requestCloseApproval = vi.fn().mockResolvedValue(approve(["t-own"]));
    const { readTerminalCloseContext, start } = closeDeps("help", requestCloseApproval);
    readTerminalCloseContext.mockRejectedValue(new Error("pty host gone"));
    const server = await start("s-close-own-unreadable", ["t-own"]);

    await callTool(server, { name: "terminal.close", arguments: { terminalId: "t-own" } });

    expect(requestCloseApproval).toHaveBeenCalledTimes(1);
  });

  it("closes nothing when an approval reports no selection", async () => {
    const requestCloseApproval = vi.fn().mockResolvedValue({
      result: { ok: true, result: null },
      confirmationDecision: "approved",
    });
    const { dispatchAction, start } = closeDeps("help", requestCloseApproval);
    const server = await start("s-close-no-selection");

    const result = await callTool(server, {
      name: "terminal.closeMany",
      arguments: { terminalIds: ["t-user", "t-other"] },
    });

    expect(dispatchAction).not.toHaveBeenCalled();
    expect(result.structuredContent).toMatchObject({
      results: [
        { target: "t-user", ok: false, error: { code: "USER_REJECTED" } },
        { target: "t-other", ok: false, error: { code: "USER_REJECTED" } },
      ],
    });
  });

  it("refuses when the dialog cannot be raised, without closing", async () => {
    const requestCloseApproval = vi.fn().mockRejectedValue(new Error("window gone"));
    const { dispatchAction, start } = closeDeps("help", requestCloseApproval);
    const server = await start("s-close-route-throws");

    const result = await callTool(server, {
      name: "terminal.close",
      arguments: { terminalId: "t-user" },
    });

    expect(dispatchAction).not.toHaveBeenCalled();
    expect(toolErrorPayload(result).code).toBe("CONFIRMATION_REQUIRED");
  });

  it("refuses when there is no way to ask, rather than closing unasked", async () => {
    const { dispatchAction, start } = closeDeps("help", undefined);
    const server = await start("s-close-no-route");

    const result = await callTool(server, {
      name: "terminal.close",
      arguments: { terminalId: "t-user" },
    });

    expect(dispatchAction).not.toHaveBeenCalled();
    expect(toolErrorPayload(result).code).toBe("CONFIRMATION_REQUIRED");
  });

  it("asks once for a whole closeMany and closes only the panels left checked", async () => {
    const requestCloseApproval = vi.fn().mockResolvedValue(approve(["t-own", "t-user"]));
    const { dispatchAction, start } = closeDeps("help", requestCloseApproval);
    const server = await start("s-close-many", ["t-own"]);

    const result = await callTool(server, {
      name: "terminal.closeMany",
      arguments: { terminalIds: ["t-own", "t-user", "t-other", "t-user"] },
    });

    expect(requestCloseApproval).toHaveBeenCalledTimes(1);
    expect(requestCloseApproval).toHaveBeenCalledWith("terminal.closeMany", {
      terminalIds: ["t-own", "t-user", "t-other"],
    });
    expect(dispatchAction.mock.calls.map((c) => c[1])).toEqual([
      { terminalId: "t-own" },
      { terminalId: "t-user" },
    ]);
    expect(result.structuredContent).toMatchObject({
      results: [
        { target: "t-own", ok: true },
        { target: "t-user", ok: true },
        { target: "t-other", ok: false, error: { code: "USER_REJECTED" } },
      ],
    });
  });

  it("closes nothing in a closeMany the user declined, and does not ask per panel", async () => {
    const requestCloseApproval = vi.fn().mockResolvedValue({
      result: { ok: false, error: { code: "CONFIRMATION_TIMEOUT", message: "timed out" } },
      confirmationDecision: "timeout",
    });
    const { dispatchAction, start } = closeDeps("help", requestCloseApproval);
    const server = await start("s-close-many-declined", ["t-own"]);

    const result = await callTool(server, {
      name: "terminal.closeMany",
      arguments: { terminalIds: ["t-own", "t-user"] },
    });

    expect(requestCloseApproval).toHaveBeenCalledTimes(1);
    expect(dispatchAction).not.toHaveBeenCalled();
    expect(toolErrorPayload(result).code).toBe("CONFIRMATION_TIMEOUT");
  });

  it("runs a closeMany of the session's own idle panels without asking", async () => {
    const requestCloseApproval = vi.fn();
    const { dispatchAction, start } = closeDeps("help", requestCloseApproval);
    const server = await start("s-close-many-own", ["t-a", "t-b"]);

    await callTool(server, {
      name: "terminal.closeMany",
      arguments: { terminalIds: ["t-a", "t-b"] },
    });

    expect(requestCloseApproval).not.toHaveBeenCalled();
    expect(dispatchAction).toHaveBeenCalledTimes(2);
  });

  it("leaves an external session's owned closeMany to the ownership gate", async () => {
    const requestCloseApproval = vi.fn();
    const { dispatchAction, start } = closeDeps("external", requestCloseApproval);
    const server = await start("s-close-many-external", ["t-a"]);

    await callTool(server, {
      name: "terminal.closeMany",
      arguments: { terminalIds: ["t-a"] },
    });

    expect(requestCloseApproval).not.toHaveBeenCalled();
    expect(dispatchAction).toHaveBeenCalledWith("terminal.close", { terminalId: "t-a" }, false);
  });
});

describe("assistant skip preference (#12874)", () => {
  function confirmEntry(id: string): ActionManifestEntry {
    return { ...makeManifestEntry(id), kind: "command", danger: "confirm" };
  }

  function skipServer(options: {
    origin: string;
    skipped: boolean;
    tier?: "core" | "full";
    entries?: ActionManifestEntry[];
    extraDeps?: Partial<SessionServerDeps>;
  }) {
    const sessionStore = fakeSessionStore(options.tier ?? "full");
    sessionStore.sessionOriginMap.set("s", options.origin as never);
    const dispatchAction = vi.fn().mockResolvedValue({ result: { ok: true, result: { ok: 1 } } });
    const appendAuditRecord = vi.fn();
    const notifyToolCallStarted = vi.fn();
    const readAssistantConfirmationsSkipped = vi.fn(() => options.skipped);
    const deps = fakeDeps({
      sessionStore,
      dispatchAction,
      appendAuditRecord,
      notifyToolCallStarted,
      readAssistantConfirmationsSkipped,
      getCachedManifest: vi.fn(
        () =>
          options.entries ?? [confirmEntry("worktree.delete"), makeManifestEntry("worktree.list")]
      ),
      ...options.extraDeps,
    });
    const server = createSessionServer("s", deps);
    return {
      server,
      sessionStore,
      dispatchAction,
      appendAuditRecord,
      notifyToolCallStarted,
      readAssistantConfirmationsSkipped,
    };
  }

  function lastAudit(appendAuditRecord: ReturnType<typeof vi.fn>) {
    return appendAuditRecord.mock.calls.at(-1)?.[0] as Record<string, unknown>;
  }

  it("covers a host-run confirm-gated action when no frontend can describe it (#13495)", async () => {
    // The base surface a frontend-less host falls back to describes only the
    // external tier, which leaves `worktree.delete` out; its danger comes from
    // the host's own catalog instead.
    const help = skipServer({
      origin: "help",
      skipped: true,
      extraDeps: {
        getCachedManifest: vi.fn(() => null),
        requestManifest: vi.fn().mockRejectedValue(new NoFrontendAttachedError("ws-1")),
      },
    });
    await help.server.connect(makeMockTransport());

    await callTool(help.server, { name: "worktree.delete", arguments: { worktreeId: "wt-1" } });

    expect(help.dispatchAction).toHaveBeenCalledWith(
      "worktree.delete",
      expect.objectContaining({ worktreeId: "wt-1" }),
      true,
      "skip-preference"
    );
  });

  it("runs a help session's confirm-gated call pre-confirmed and audits it as the skip preference", async () => {
    const help = skipServer({ origin: "help", skipped: true });
    await help.server.connect(makeMockTransport());

    const result = await callTool(help.server, {
      name: "worktree.delete",
      arguments: { worktreeId: "wt-1", force: true },
    });

    expect(result.isError).not.toBe(true);
    expect(help.dispatchAction).toHaveBeenCalledWith(
      "worktree.delete",
      expect.objectContaining({ worktreeId: "wt-1", force: true }),
      true,
      "skip-preference"
    );
    expect(lastAudit(help.appendAuditRecord)).toMatchObject({ authorization: "skip-preference" });
    // Never going to wait, so the strip must not say it is.
    expect(help.notifyToolCallStarted).toHaveBeenCalledWith(
      expect.objectContaining({ toolId: "worktree.delete", danger: false })
    );
    help.sessionStore.grantCache.dispose();
  });

  // A remote Shell that still raised its dialog (#13368) — a move of its
  // window, or a Shell too old to take the stamp — sends the decision back,
  // and the audit must not claim the call ran without asking.
  it.each([{ decision: "approved" }, { decision: "rejected" }, { decision: "timeout" }])(
    "audits a skip-stamped call the Shell still asked about as asked ($decision)",
    async ({ decision }) => {
      const help = skipServer({ origin: "help", skipped: true });
      help.dispatchAction.mockResolvedValue({
        result:
          decision === "approved"
            ? { ok: true, result: { ok: 1 } }
            : { ok: false, error: { code: "USER_REJECTED", message: "no" } },
        confirmationDecision: decision,
      });
      await help.server.connect(makeMockTransport());

      await callTool(help.server, {
        name: "worktree.delete",
        arguments: { worktreeId: "wt-1" },
      });

      expect(help.dispatchAction.mock.calls.at(-1)?.slice(2)).toEqual([true, "skip-preference"]);
      const audit = lastAudit(help.appendAuditRecord);
      expect(audit.confirmationDecision).toBe(decision);
      expect(audit).not.toHaveProperty("authorization");
      help.sessionStore.grantCache.dispose();
    }
  );

  // The issue's own case (#13135): a core help session deleting a worktree an
  // earlier session made. Skip runs it; ask raises the ordinary modal. Neither
  // is refused, and nothing about it depends on the session having created it.
  it.each([
    { skipped: true, confirmed: true, authorization: "skip-preference" },
    { skipped: false, confirmed: false, authorization: undefined },
  ])(
    "dispatches a core help session's unscoped delete (skipped: $skipped)",
    async ({ skipped, confirmed, authorization }) => {
      const help = skipServer({ origin: "help", skipped, tier: "core" });
      await help.server.connect(makeMockTransport());

      const result = await callTool(help.server, {
        name: "worktree.delete",
        arguments: { worktreeId: "wt-from-an-earlier-session" },
      });

      expect(result.isError).not.toBe(true);
      const call = help.dispatchAction.mock.calls.at(-1)!;
      expect(call[0]).toBe("worktree.delete");
      expect(call[2]).toBe(confirmed);
      expect(call[3]).toBe(authorization);
      help.sessionStore.grantCache.dispose();
    }
  );

  it("keeps the dialog while the preference resolves to ask", async () => {
    const help = skipServer({ origin: "help", skipped: false });
    await help.server.connect(makeMockTransport());

    await callTool(help.server, { name: "worktree.delete", arguments: { worktreeId: "wt-1" } });

    const call = help.dispatchAction.mock.calls.at(-1)!;
    expect(call[2]).toBe(false);
    expect(call[3]).toBeUndefined();
    expect(lastAudit(help.appendAuditRecord).authorization).toBeUndefined();
    expect(help.notifyToolCallStarted).toHaveBeenCalledWith(
      expect.objectContaining({ toolId: "worktree.delete", danger: true, asks: true })
    );
    help.sessionStore.grantCache.dispose();
  });

  it("reads the preference on every call, so switching to always ask applies to the next one", async () => {
    const help = skipServer({ origin: "help", skipped: true });
    await help.server.connect(makeMockTransport());

    await callTool(help.server, { name: "worktree.delete", arguments: { worktreeId: "wt-1" } });
    help.readAssistantConfirmationsSkipped.mockReturnValue(false);
    await callTool(help.server, { name: "worktree.delete", arguments: { worktreeId: "wt-2" } });

    expect(help.dispatchAction.mock.calls[0][2]).toBe(true);
    expect(help.dispatchAction.mock.calls[1][2]).toBe(false);
    help.sessionStore.grantCache.dispose();
  });

  it("never applies to an external session, whatever the preference says", async () => {
    const other = skipServer({ origin: "external", skipped: true, tier: "core" });
    await other.server.connect(makeMockTransport());

    await callTool(other.server, { name: "worktree.list", arguments: {} });
    await callTool(other.server, {
      name: "worktree.deleteOwned",
      arguments: { worktreeId: "wt-1" },
    });

    expect(other.readAssistantConfirmationsSkipped).not.toHaveBeenCalled();
    for (const call of other.dispatchAction.mock.calls) {
      expect(call[3]).not.toBe("skip-preference");
    }
    other.sessionStore.grantCache.dispose();
  });

  it("does not stamp a safe call, which could never have asked", async () => {
    const help = skipServer({ origin: "help", skipped: true });
    await help.server.connect(makeMockTransport());

    await callTool(help.server, { name: "worktree.list", arguments: {} });

    expect(help.dispatchAction.mock.calls.at(-1)?.[2]).toBe(false);
    expect(lastAudit(help.appendAuditRecord).authorization).toBeUndefined();
    help.sessionStore.grantCache.dispose();
  });

  it("wins over a native grant, which would leave the typed-name gate in place", async () => {
    const help = skipServer({ origin: "help", skipped: true });
    help.sessionStore.grantCache.issueNativeGrant({
      sessionId: "s",
      actorId: "help-1",
      actorType: "help-session",
      allowedTools: ["worktree.delete"],
      maxUses: 2,
    });
    await help.server.connect(makeMockTransport());

    await callTool(help.server, {
      name: "worktree.delete",
      arguments: { worktreeId: "wt-1", force: true },
    });

    expect(help.dispatchAction.mock.calls.at(-1)?.slice(2)).toEqual([true, "skip-preference"]);
    expect(lastAudit(help.appendAuditRecord)).toMatchObject({ authorization: "skip-preference" });
    help.sessionStore.grantCache.dispose();
  });

  it("keeps a native grant's awaiting state, since the renderer can still demote it", async () => {
    const help = skipServer({ origin: "help", skipped: false });
    help.sessionStore.grantCache.issueNativeGrant({
      sessionId: "s",
      actorId: "help-1",
      actorType: "help-session",
      allowedTools: ["worktree.delete"],
      maxUses: 2,
    });
    await help.server.connect(makeMockTransport());

    await callTool(help.server, { name: "worktree.delete", arguments: { worktreeId: "wt-1" } });

    expect(help.dispatchAction.mock.calls.at(-1)?.slice(2)).toEqual([true]);
    expect(help.notifyToolCallStarted).toHaveBeenCalledWith(
      expect.objectContaining({ toolId: "worktree.delete", danger: true })
    );
    help.sessionStore.grantCache.dispose();
  });

  // #14165: a granted plain delete never reaches a dialog, so it is no wait on
  // the person; a granted force delete may still be demoted to the typed-name
  // one, which only the renderer can decide, so it announces the wait.
  it.each([
    [{ worktreeId: "wt-1" }, false],
    [{ worktreeId: "wt-1", force: true }, true],
  ])("announces a native-granted delete with %o as asking: %s", async (args, asks) => {
    const help = skipServer({ origin: "help", skipped: false });
    help.sessionStore.grantCache.issueNativeGrant({
      sessionId: "s",
      actorId: "help-1",
      actorType: "help-session",
      allowedTools: ["worktree.delete"],
      maxUses: 2,
    });
    await help.server.connect(makeMockTransport());

    await callTool(help.server, { name: "worktree.delete", arguments: args });

    expect(help.dispatchAction.mock.calls.at(-1)?.[2]).toBe(true);
    expect(help.notifyToolCallStarted).toHaveBeenCalledWith(
      expect.objectContaining({ toolId: "worktree.delete", danger: true, asks })
    );
    help.sessionStore.grantCache.dispose();
  });

  it("covers a safe action its arguments raise to confirm, as the renderer does", async () => {
    const help = skipServer({
      origin: "help",
      skipped: true,
      entries: [{ ...makeManifestEntry("terminal.new"), kind: "command" }],
    });
    await help.server.connect(makeMockTransport());

    await callTool(help.server, { name: "terminal.new", arguments: { command: "npm test" } });
    await callTool(help.server, { name: "terminal.new", arguments: {} });

    expect(help.dispatchAction.mock.calls[0].slice(2)).toEqual([true, "skip-preference"]);
    expect(help.dispatchAction.mock.calls[1].slice(2)).toEqual([false]);
    help.sessionStore.grantCache.dispose();
  });

  it("fails closed to the dialog when the preference cannot be read", async () => {
    const help = skipServer({ origin: "help", skipped: true });
    help.readAssistantConfirmationsSkipped.mockImplementation(() => {
      throw new Error("store unavailable");
    });
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    await help.server.connect(makeMockTransport());

    await callTool(help.server, { name: "worktree.delete", arguments: { worktreeId: "wt-1" } });

    expect(help.dispatchAction.mock.calls.at(-1)?.[2]).toBe(false);
    consoleError.mockRestore();
    help.sessionStore.grantCache.dispose();
  });

  // #12989: the skip covers the protected close (#12881) and the
  // target-picking tools a native grant cannot.
  it("closes a panel the assistant did not open without asking, audited as the skip", async () => {
    const requestCloseApproval = vi.fn();
    const help = skipServer({
      origin: "help",
      skipped: true,
      entries: [makeManifestEntry("terminal.close")],
      extraDeps: {
        requestCloseApproval,
        readTerminalCloseContext: vi.fn(async () => null),
      },
    });
    await help.server.connect(makeMockTransport());

    await callTool(help.server, { name: "terminal.close", arguments: { terminalId: "t-user" } });

    expect(requestCloseApproval).not.toHaveBeenCalled();
    expect(help.dispatchAction.mock.calls.at(-1)?.slice(2)).toEqual([true, "skip-preference"]);
    expect(lastAudit(help.appendAuditRecord)).toMatchObject({ authorization: "skip-preference" });
    expect(help.notifyToolCallStarted).toHaveBeenCalledWith(
      expect.objectContaining({ toolId: "terminal.close", danger: false })
    );
    help.sessionStore.grantCache.dispose();
  });

  it("does not stamp a close of the session's own idle panel, which would never have asked", async () => {
    const help = skipServer({
      origin: "help",
      skipped: true,
      entries: [makeManifestEntry("terminal.close")],
      extraDeps: { readTerminalCloseContext: vi.fn(async () => null) },
    });
    help.sessionStore.resourceOwnership.record("s", [{ kind: "terminal", id: "t-own" }]);
    await help.server.connect(makeMockTransport());

    await callTool(help.server, { name: "terminal.close", arguments: { terminalId: "t-own" } });

    expect(help.dispatchAction.mock.calls.at(-1)?.slice(2)).toEqual([false]);
    expect(lastAudit(help.appendAuditRecord).authorization).toBeUndefined();
    help.sessionStore.grantCache.dispose();
  });

  it("stamps only the items of a mixed closeMany that would have asked", async () => {
    const requestCloseApproval = vi.fn();
    const help = skipServer({
      origin: "help",
      skipped: true,
      entries: [makeManifestEntry("terminal.close"), makeManifestEntry("terminal.closeMany")],
      extraDeps: {
        requestCloseApproval,
        readTerminalCloseContext: vi.fn(async () => null),
      },
    });
    help.sessionStore.resourceOwnership.record("s", [{ kind: "terminal", id: "t-own" }]);
    await help.server.connect(makeMockTransport());

    await callTool(help.server, {
      name: "terminal.closeMany",
      arguments: { terminalIds: ["t-own", "t-user"] },
    });

    expect(requestCloseApproval).not.toHaveBeenCalled();
    expect(help.dispatchAction.mock.calls.map((c) => [c[1], ...c.slice(2)])).toEqual([
      [{ terminalId: "t-own" }, false],
      [{ terminalId: "t-user" }, true, "skip-preference"],
    ]);
    expect(help.notifyToolCallStarted).toHaveBeenCalledWith(
      expect.objectContaining({ toolId: "terminal.closeMany", danger: false })
    );
    for (const call of help.notifyToolCallStarted.mock.calls) {
      expect(call[0]).toMatchObject({ danger: false });
    }
    help.sessionStore.grantCache.dispose();
  });

  it("still asks before a protected close while the preference resolves to ask", async () => {
    const requestCloseApproval = vi.fn().mockResolvedValue({
      result: { ok: false, error: { code: "USER_REJECTED", message: "declined" } },
      confirmationDecision: "rejected",
    });
    const help = skipServer({
      origin: "help",
      skipped: false,
      entries: [makeManifestEntry("terminal.close")],
      extraDeps: {
        requestCloseApproval,
        readTerminalCloseContext: vi.fn(async () => null),
      },
    });
    await help.server.connect(makeMockTransport());

    const result = await callTool(help.server, {
      name: "terminal.close",
      arguments: { terminalId: "t-user" },
    });

    expect(requestCloseApproval).toHaveBeenCalledTimes(1);
    expect(help.dispatchAction).not.toHaveBeenCalled();
    expect(toolErrorPayload(result).code).toBe("USER_REJECTED");
    help.sessionStore.grantCache.dispose();
  });

  it("runs a closeMany of panels it did not open without asking, each item under the skip", async () => {
    const requestCloseApproval = vi.fn();
    const help = skipServer({
      origin: "help",
      skipped: true,
      entries: [makeManifestEntry("terminal.close"), makeManifestEntry("terminal.closeMany")],
      extraDeps: {
        requestCloseApproval,
        readTerminalCloseContext: vi.fn(async () => null),
      },
    });
    await help.server.connect(makeMockTransport());

    const result = await callTool(help.server, {
      name: "terminal.closeMany",
      arguments: { terminalIds: ["t-a", "t-b"] },
    });

    expect(requestCloseApproval).not.toHaveBeenCalled();
    expect(help.dispatchAction.mock.calls.map((c) => [c[1], ...c.slice(2)])).toEqual([
      [{ terminalId: "t-a" }, true, "skip-preference"],
      [{ terminalId: "t-b" }, true, "skip-preference"],
    ]);
    expect(result.structuredContent).toMatchObject({
      results: [
        { target: "t-a", ok: true },
        { target: "t-b", ok: true },
      ],
    });
    // One strip row for the batch, and none of it waits.
    for (const call of help.notifyToolCallStarted.mock.calls) {
      expect(call[0]).toMatchObject({ danger: false });
    }
    expect(
      help.appendAuditRecord.mock.calls.map((c) => (c[0] as Record<string, unknown>).authorization)
    ).toEqual(["skip-preference", "skip-preference", "skip-preference"]);
    help.sessionStore.grantCache.dispose();
  });

  // The target-picking tools a native grant cannot cover. `killAll` and
  // `killBatch` sit in no assistant tier today; the gate is the same for them.
  it("runs an agent's close-all pre-confirmed under the skip", async () => {
    const help = skipServer({
      origin: "help",
      skipped: true,
      entries: [makeManifestEntry("terminal.closeAll")],
    });
    await help.server.connect(makeMockTransport());

    await callTool(help.server, { name: "terminal.closeAll", arguments: {} });

    expect(help.dispatchAction.mock.calls.at(-1)?.slice(2)).toEqual([true, "skip-preference"]);
    expect(lastAudit(help.appendAuditRecord)).toMatchObject({ authorization: "skip-preference" });
    expect(help.notifyToolCallStarted).toHaveBeenCalledWith(
      expect.objectContaining({ toolId: "terminal.closeAll", danger: false })
    );
    help.sessionStore.grantCache.dispose();
  });

  it("leaves an agent's close-all to its dialog while the preference resolves to ask", async () => {
    const help = skipServer({
      origin: "help",
      skipped: false,
      entries: [makeManifestEntry("terminal.closeAll")],
    });
    await help.server.connect(makeMockTransport());

    await callTool(help.server, { name: "terminal.closeAll", arguments: {} });

    expect(help.dispatchAction.mock.calls.at(-1)?.slice(2)).toEqual([false]);
    expect(lastAudit(help.appendAuditRecord).authorization).toBeUndefined();
    expect(help.notifyToolCallStarted).toHaveBeenCalledWith(
      expect.objectContaining({ toolId: "terminal.closeAll", danger: true })
    );
    help.sessionStore.grantCache.dispose();
  });
});
