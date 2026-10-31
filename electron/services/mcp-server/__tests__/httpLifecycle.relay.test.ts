import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../store.js", () => ({
  store: {
    get: vi.fn().mockReturnValue({ enabled: true, port: 45454, apiKey: "test-api-key" }),
  },
}));

vi.mock("electron", () => ({
  app: { getVersion: () => "0.0.0-test" },
  webContents: { fromId: () => null },
  ipcMain: { on: () => undefined, removeListener: () => undefined },
}));

import http from "node:http";
import { EventEmitter } from "node:events";
import type { ActionId, ActionManifestEntry } from "../../../../shared/types/actions.js";
import { HttpLifecycle, type HttpLifecycleDeps } from "../httpLifecycle.js";
import { relayOwnershipPrincipal } from "../resourceOwnership.js";
import { SessionStore } from "../sessionStore.js";
import {
  _resetMcpDriveTargetResolverForTesting,
  setMcpDriveTargetResolver,
  type McpDriveTarget,
} from "../driveTarget.js";
import type { ClientEndpoint } from "../../../ipc/endpoint.js";
import { WorkspaceBindingError } from "../rendererBridge.js";
import { MCP_REMOTE_CONFIRM_MARGIN_MS } from "../../../../shared/config/mcpConfirmWindow.js";

function entry(id: string, kind: "query" | "command", readOnlyHint?: boolean): ActionManifestEntry {
  return {
    id: id as ActionId,
    name: id,
    title: id,
    description: `description for ${id}`,
    category: "test",
    kind,
    danger: "safe",
    enabled: true,
    requiresArgs: false,
    inputSchema: { type: "object", properties: {} },
    ...(readOnlyHint !== undefined ? { mcpAnnotations: { readOnlyHint } } : {}),
  };
}

const MANIFEST = [
  entry("terminal.list", "query"),
  entry("agent.launch", "command"),
  // A query that writes: classified by what it advertises, not by its kind.
  entry("copyTree.generate", "query", false),
  entry("terminal.notifyWhenIdle", "command"),
  entry("project.runCheck", "command"),
];

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function listeningServer(): any {
  const s = new EventEmitter() as unknown as Record<string, unknown>;
  Object.assign(s, {
    closeAllConnections: vi.fn(),
    closeIdleConnections: vi.fn(),
    close: vi.fn((cb?: () => void) => {
      cb?.();
      return s;
    }),
    listen: vi.fn((_p: number, _h: string, cb?: () => void) => {
      Object.defineProperty(s, "listening", { value: true, configurable: true });
      cb?.();
      return s;
    }),
    address: vi.fn(() => ({ port: 45454, family: "IPv4", address: "127.0.0.1" })),
  });
  Object.defineProperty(s, "listening", { value: false, configurable: true });
  return s;
}

const stores: SessionStore[] = [];

afterEach(() => {
  for (const store of stores.splice(0)) {
    store.drain();
    store.grantCache.dispose();
  }
  vi.restoreAllMocks();
});

async function startedLifecycle(overrides: Partial<HttpLifecycleDeps> = {}) {
  vi.spyOn(http, "createServer").mockImplementation((() =>
    listeningServer()) as unknown as typeof http.createServer);
  const store = new SessionStore(() => {});
  stores.push(store);
  const dispatchActionForWorkspace = vi
    .fn()
    .mockResolvedValue({ result: { ok: true, result: { ran: true } } });
  const appendRecord = vi.fn();
  const deps = {
    sessionStore: store,
    auditService: {
      hydrate: vi.fn(),
      flushNow: vi.fn(),
      appendRecord,
      appendGrantRecord: vi.fn(),
      recordAuth401: vi.fn(),
      getAuditStats: vi.fn(() => ({ auth401Count: 0 })),
    },
    turnOutcomeService: {
      flushNow: vi.fn(),
      getCurrentTurnIdForSession: vi.fn(() => null),
    },
    requestManifest: vi.fn().mockResolvedValue([]),
    dispatchAction: vi.fn(),
    requestManifestForWorkspace: vi.fn().mockResolvedValue(MANIFEST),
    getCachedManifestForWorkspace: vi.fn(() => MANIFEST),
    dispatchActionForWorkspace,
    handleWaitUntilIdle: vi.fn(),
    handleSkillsSearch: vi.fn(() => ({ skills: [] })),
    handleSkillsLoad: vi.fn(),
    handleProjectRunCheck: vi.fn(),
    handleTerminalGetStatusViewless: vi.fn(),
    handleTerminalReadLastMessageOwned: vi.fn(),
    isTerminalIdInUse: vi.fn(() => false),
    getCachedManifest: vi.fn(() => null),
    clearCachedManifest: vi.fn(),
    cleanupListeners: [],
    pendingManifests: new Map(),
    pendingDispatches: new Map(),
    setupIpcListeners: vi.fn(),
    emitStatusChange: vi.fn(),
    emitRuntimeStateChange: vi.fn(),
    setConfig: vi.fn(),
    abusePolicy: {
      recordDenial: vi.fn(() => ({ tripped: false })),
      dropSession: vi.fn(),
      clear: vi.fn(),
      getSnapshot: vi.fn(() => null),
    },
    ...overrides,
  } as unknown as HttpLifecycleDeps;
  const lc = new HttpLifecycle(deps);
  lc.isEnabled = () => true;
  await lc.start({} as never);
  return { lc, store, dispatchActionForWorkspace, appendRecord };
}

const CALLER = {
  linkSessionId: "link-1",
  senderId: "a".repeat(64),
  helpSessionId: "help-1",
  shellName: "greg-mbp",
};

describe("HttpLifecycle.openRelaySession (#13493)", () => {
  it("opens nothing while the server isn't running", async () => {
    const lc = new HttpLifecycle({ sessionStore: new SessionStore(() => {}) } as never);
    await expect(
      lc.openRelaySession({ tier: "core", workspaceId: "project-1", caller: CALLER })
    ).resolves.toBeNull();
  });

  it("records a global Assistant's caller as global, and an ordinary one as not (#14545)", async () => {
    const { lc, store } = await startedLifecycle();
    const global = await lc.openRelaySession({
      tier: "core",
      workspaceId: "project-1",
      caller: { ...CALLER, global: true },
    });
    const ordinary = await lc.openRelaySession({
      tier: "core",
      workspaceId: "project-1",
      caller: CALLER,
    });

    expect(store.getRelayCaller(global!.sessionId)?.global).toBe(true);
    expect(store.getRelayCaller(ordinary!.sessionId)?.global).toBeUndefined();
    // Classified, and admitted exactly as any other machine's assistant.
    expect(store.getOrigin(global!.sessionId)).toBe("external");
    expect(store.resourceOwnership.ownerOf(global!.sessionId)).toContain(
      relayOwnershipPrincipal(CALLER.senderId, CALLER.helpSessionId)
    );
    global!.close();
    ordinary!.close();
  });

  it("admits an external-origin session bound to the project, under the relay principal", async () => {
    const { lc, store } = await startedLifecycle();
    const session = await lc.openRelaySession({
      tier: "full",
      workspaceId: "project-1",
      caller: CALLER,
    });
    expect(session).not.toBeNull();
    const id = session!.sessionId;

    expect(store.getTier(id)).toBe("full");
    expect(store.getOrigin(id)).toBe("external");
    expect(store.isRendererOwnedOrigin(id)).toBe(false);
    expect(store.sessionWorkspaceMap.get(id)).toBe("project-1");
    expect(store.getRelayCaller(id)).toEqual({ ...CALLER, callDeadline: expect.any(Function) });
    expect(store.sessionHelpIdMap.has(id)).toBe(false);
    expect(store.resourceOwnership.ownerOf(id)).toContain(
      relayOwnershipPrincipal(CALLER.senderId, CALLER.helpSessionId)
    );
    // Nothing an HTTP request can present addresses it.
    expect(store.httpSessions.has(id)).toBe(false);

    session!.close();
    expect(store.getTier(id)).toBeNull();
    expect(store.sessionWorkspaceMap.has(id)).toBe(false);
    expect(store.getRelayCaller(id)).toBeUndefined();
    expect(session!.isOpen()).toBe(false);
  });

  it("dispatches with who asked, a read by what the tool advertises and anything else as a write", async () => {
    const { lc, dispatchActionForWorkspace } = await startedLifecycle();
    const session = (await lc.openRelaySession({
      tier: "full",
      workspaceId: "project-1",
      caller: CALLER,
    }))!;

    await session.callTool("terminal.list", {}, { timeoutMs: 5_000, callId: "c1" });
    await session.callTool(
      "agent.launch",
      { agentId: "claude" },
      { timeoutMs: 5_000, callId: "c2" }
    );
    await session.callTool("copyTree.generate", {}, { timeoutMs: 5_000, callId: "c3" });

    const relayOf = (actionId: string) =>
      dispatchActionForWorkspace.mock.calls.find((call) => call[1] === actionId)?.[5]?.relay;
    // Each names the Shell's own call, for that Shell's view to match (#15698).
    const named = (callId: string) => ({ callId, helpSessionId: CALLER.helpSessionId });
    expect(relayOf("terminal.list")).toEqual({
      linkSessionId: "link-1",
      readOnly: true,
      call: named("c1"),
    });
    expect(relayOf("agent.launch")).toEqual({
      linkSessionId: "link-1",
      readOnly: false,
      call: named("c2"),
    });
    expect(relayOf("copyTree.generate")).toEqual({
      linkSessionId: "link-1",
      readOnly: false,
      call: named("c3"),
    });
    session.close();
  });

  it("classifies by the host's own catalog when no view describes the project", async () => {
    const { lc, dispatchActionForWorkspace } = await startedLifecycle({
      requestManifestForWorkspace: vi
        .fn()
        .mockResolvedValue([
          ...MANIFEST,
          entry("actions.search", "query"),
          entry("worktree.createWithRecipe", "command"),
          entry("recipe.list", "query"),
        ]),
      getCachedManifestForWorkspace: vi.fn(() => null),
    });
    const session = (await lc.openRelaySession({
      tier: "full",
      workspaceId: "project-1",
      caller: CALLER,
    }))!;

    await session.callTool(
      "actions.search",
      { query: "terminal" },
      { timeoutMs: 5_000, callId: "c1" }
    );
    await session.callTool("worktree.createWithRecipe", {}, { timeoutMs: 5_000, callId: "c2" });
    await session.callTool("copyTree.generate", {}, { timeoutMs: 5_000, callId: "c3" });
    await session.callTool("recipe.list", {}, { timeoutMs: 5_000, callId: "c4" });

    const relayOf = (actionId: string) =>
      dispatchActionForWorkspace.mock.calls.find((call) => call[1] === actionId)?.[5]?.relay;
    const named = (callId: string) => ({ callId, helpSessionId: CALLER.helpSessionId });
    expect(relayOf("actions.search")).toEqual({
      linkSessionId: "link-1",
      readOnly: true,
      call: named("c1"),
    });
    // A query the catalog says writes (it reconciles the recipe store) stays a write.
    expect(relayOf("recipe.list")).toEqual({
      linkSessionId: "link-1",
      readOnly: false,
      call: named("c4"),
    });
    expect(relayOf("worktree.createWithRecipe")).toEqual({
      linkSessionId: "link-1",
      readOnly: false,
      call: named("c2"),
    });
    // Not in the host's catalog, so still a write.
    expect(relayOf("copyTree.generate")).toEqual({
      linkSessionId: "link-1",
      readOnly: false,
      call: named("c3"),
    });
    session.close();
  });

  it("gives its notices the relay principal's pane, routed back to its sender (#13500)", async () => {
    const whenIdle = vi.fn().mockResolvedValue({ armed: true, terminalId: "t-1" });
    const { lc } = await startedLifecycle({
      terminalNotify: {
        whenIdle,
        prepareSend: vi.fn(),
        prepareLaunch: vi.fn(),
        prepareKeys: vi.fn(),
        forgetTarget: vi.fn(),
        holdTarget: vi.fn(),
        settleTargetHold: vi.fn(),
        supersede: vi.fn(),
        releaseHold: vi.fn(),
      },
    } as Partial<HttpLifecycleDeps>);
    const deliverNotices = vi.fn();
    const session = (await lc.openRelaySession({
      tier: "core",
      workspaceId: "project-1",
      caller: { ...CALLER, deliverNotices },
    }))!;

    const result = await session.callTool(
      "terminal.notifyWhenIdle",
      { terminalId: "t-1" },
      { timeoutMs: 5_000, callId: "call-7" }
    );
    expect(result.isError).not.toBe(true);
    const [pane] = whenIdle.mock.calls[0]!;
    expect(pane.relay).toMatchObject({
      projectId: "project-1",
      helpSessionId: "help-1",
      callId: "call-7",
    });
    // Not tied to the link it came over, which may expire before it fires (#13930).
    expect(pane.relay).not.toHaveProperty("linkSessionId");
    expect(pane.relay.deliver).toBe(deliverNotices);
    // Held under the principal, not the session, which closes when idle.
    expect(pane.key).toContain(relayOwnershipPrincipal(CALLER.senderId, CALLER.helpSessionId));
    session.close();
  });

  it("audits who asked with the shared callId, and never what anyone wrote or what came back", async () => {
    const { lc, appendRecord } = await startedLifecycle();
    const session = (await lc.openRelaySession({
      tier: "core",
      workspaceId: "project-1",
      caller: CALLER,
    }))!;

    await session.callTool(
      "agent.launch",
      { agentId: "claude", prompt: "short secret" },
      { timeoutMs: 5_000, callId: "call-9" }
    );

    const record = appendRecord.mock.calls
      .map(([input]) => input as Record<string, unknown>)
      .find((input) => input.toolId === "agent.launch")!;
    expect(record.relay).toEqual({
      shellName: "greg-mbp",
      sender: CALLER.senderId.slice(0, 16),
      helpSessionId: "help-1",
      callId: "call-9",
    });
    expect(record.argsSummary).not.toContain("short secret");
    expect(record).not.toHaveProperty("resultSummary");
    session.close();
  });

  it("puts a call's confirmation to its own Shell, naming the call that needs it (#13501)", async () => {
    const requestApproval = vi.fn().mockResolvedValue({ decision: "rejected" });
    const { lc, dispatchActionForWorkspace } = await startedLifecycle();
    dispatchActionForWorkspace.mockImplementation(async (...args: unknown[]) => {
      const options = args[5] as {
        relay?: { requestApproval?: (ask: unknown) => Promise<unknown> };
      };
      await options.relay?.requestApproval?.({
        actionId: "agent.launch",
        args: { agentId: "claude" },
        lines: ["preview"],
      });
      return { result: { ok: true, result: {} } };
    });
    const session = (await lc.openRelaySession({
      tier: "full",
      workspaceId: "project-1",
      caller: { ...CALLER, requestApproval },
    }))!;

    await session.callTool(
      "agent.launch",
      { agentId: "claude" },
      { timeoutMs: 5_000, callId: "c7" }
    );

    expect(requestApproval).toHaveBeenCalledWith({
      actionId: "agent.launch",
      args: { agentId: "claude" },
      lines: ["preview"],
      callId: "c7",
      holdUntil: expect.any(Number),
    });
    session.close();
  });

  describe("inside each call's own deadline (#15699)", () => {
    const NOW = 1_700_000_000_000;

    afterEach(() => {
      vi.useRealTimers();
    });

    it("holds what the call waits on inside it, with room for the answer, and forgets it once settled", async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(NOW);
      const requestApproval = vi.fn().mockResolvedValue({ decision: "rejected" });
      const { lc, store, dispatchActionForWorkspace } = await startedLifecycle();
      let sessionId = "";
      let deadlineDuringCall: number | undefined;
      dispatchActionForWorkspace.mockImplementation(async (...args: unknown[]) => {
        deadlineDuringCall = store.getRelayCaller(sessionId)?.callDeadline?.("c8");
        const options = args[5] as {
          relay?: { requestApproval?: (ask: unknown) => Promise<unknown> };
        };
        await options.relay?.requestApproval?.({
          actionId: "agent.launch",
          args: { agentId: "claude" },
          lines: [],
        });
        return { result: { ok: true, result: {} } };
      });
      const session = (await lc.openRelaySession({
        tier: "full",
        workspaceId: "project-1",
        caller: { ...CALLER, requestApproval },
      }))!;
      sessionId = session.sessionId;

      await session.callTool("agent.launch", { agentId: "claude" }, {
        timeoutMs: 200_000,
        callId: "c8",
      });

      const holdUntil = NOW + 200_000 - MCP_REMOTE_CONFIRM_MARGIN_MS;
      expect(deadlineDuringCall).toBe(NOW + 200_000);
      expect(dispatchActionForWorkspace.mock.calls[0]?.[5]).toMatchObject({ holdUntil });
      expect(requestApproval).toHaveBeenCalledWith(expect.objectContaining({ holdUntil }));
      expect(store.getRelayCaller(sessionId)?.callDeadline?.("c8")).toBeUndefined();
      session.close();
    });

    it("knows no deadline for a call the session isn't running", async () => {
      const { lc, store } = await startedLifecycle();
      const session = (await lc.openRelaySession({
        tier: "full",
        workspaceId: "project-1",
        caller: CALLER,
      }))!;

      expect(store.getRelayCaller(session.sessionId)?.callDeadline?.("nobody")).toBeUndefined();
      session.close();
    });
  });

  describe("a check main runs itself (#13501)", () => {
    afterEach(() => _resetMcpDriveTargetResolverForTesting());

    async function check(target: McpDriveTarget) {
      setMcpDriveTargetResolver(() => target);
      const handleProjectRunCheck = vi.fn().mockResolvedValue({ passed: true });
      const { lc } = await startedLifecycle({ handleProjectRunCheck } as never);
      const session = (await lc.openRelaySession({
        tier: "full",
        workspaceId: "project-1",
        caller: CALLER,
      }))!;
      const result = await session.callTool(
        "project.runCheck",
        { projectId: "project-1", runnerId: "test" },
        { timeoutMs: 5_000, callId: "check-1" }
      );
      session.close();
      return { result, handleProjectRunCheck };
    }

    function shell(linkSessionId: string): ClientEndpoint {
      return {
        endpointId: `remote:${linkSessionId}:view-1`,
        clientId: "client-1",
        projectId: "project-1",
        kind: "remote-view",
        handle: -5,
        linkSessionId,
        send: vi.fn(),
        request: vi.fn(),
        onClose: vi.fn(() => ({ dispose: () => {} })),
        isClosed: () => false,
      };
    }

    it("runs while nobody drives the project, or while the requesting Shell's own view does", async () => {
      expect((await check({ state: "vacant" })).handleProjectRunCheck).toHaveBeenCalledTimes(1);
      expect(
        (await check({ state: "live", endpoint: shell("link-1") })).handleProjectRunCheck
      ).toHaveBeenCalledTimes(1);
    });

    it("refuses where someone else drives, naming them, or while the holder can't be reached", async () => {
      const elsewhere = await check({
        state: "live",
        endpoint: shell("link-2"),
        holderName: "studio-02",
      });
      expect(elsewhere.result.isError).toBe(true);
      expect(JSON.stringify(elsewhere.result.content)).toContain("studio-02 has control");
      expect(elsewhere.handleProjectRunCheck).not.toHaveBeenCalled();

      const unreachable = await check({ state: "unavailable", reason: "reserved" });
      expect(unreachable.result.isError).toBe(true);
      expect(unreachable.handleProjectRunCheck).not.toHaveBeenCalled();
    });
  });
  describe("this machine's own assistant in another of its projects (#14024)", () => {
    afterEach(() => _resetMcpDriveTargetResolverForTesting());

    const LOCAL_CALLER = {
      linkSessionId: "local",
      senderId: "local",
      helpSessionId: "help-1",
      shellName: "greg-mbp",
      local: true as const,
    };
    const noView = () => ({
      requestManifestForWorkspace: vi
        .fn()
        .mockRejectedValue(new WorkspaceBindingError("project-1", "not-found")),
      getCachedManifestForWorkspace: vi.fn(() => null),
    });

    it("dispatches a call in a project no view shows, marked local, from the host's own catalog", async () => {
      const { lc, dispatchActionForWorkspace } = await startedLifecycle(noView());
      const session = (await lc.openRelaySession({
        tier: "core",
        workspaceId: "project-1",
        caller: LOCAL_CALLER,
      }))!;

      const result = await session.callTool(
        "terminal.list",
        {},
        { timeoutMs: 5_000, callId: "c1" }
      );

      expect(result.isError).not.toBe(true);
      expect(dispatchActionForWorkspace).toHaveBeenCalledTimes(1);
      expect(dispatchActionForWorkspace.mock.calls[0]?.[5]?.relay).toMatchObject({
        linkSessionId: "local",
        local: true,
      });
      session.close();
    });

    it("leaves another machine's relay to a project nothing here shows a lost route", async () => {
      const { lc, dispatchActionForWorkspace } = await startedLifecycle(noView());
      const session = (await lc.openRelaySession({
        tier: "core",
        workspaceId: "project-1",
        caller: CALLER,
      }))!;

      const result = await session.callTool(
        "terminal.list",
        {},
        { timeoutMs: 5_000, callId: "c1" }
      );

      expect(result.isError).toBe(true);
      expect(JSON.stringify(result.content)).toContain("SESSION_BINDING_GONE");
      expect(dispatchActionForWorkspace).not.toHaveBeenCalled();
      session.close();
    });

    it("runs a check main runs itself with Host-mode routing off, never while another machine drives", async () => {
      const run = async () => {
        const handleProjectRunCheck = vi.fn().mockResolvedValue({ passed: true });
        const { lc } = await startedLifecycle({ handleProjectRunCheck } as never);
        const session = (await lc.openRelaySession({
          tier: "full",
          workspaceId: "project-1",
          caller: LOCAL_CALLER,
        }))!;
        const result = await session.callTool(
          "project.runCheck",
          { projectId: "project-1", runnerId: "test" },
          { timeoutMs: 5_000, callId: "check-1" }
        );
        session.close();
        return { result, handleProjectRunCheck };
      };

      expect((await run()).handleProjectRunCheck).toHaveBeenCalledTimes(1);

      setMcpDriveTargetResolver(() => ({
        state: "live",
        endpoint: {
          endpointId: "remote:local:view-1",
          clientId: "client-1",
          projectId: "project-1",
          kind: "remote-view",
          handle: -5,
          linkSessionId: "local",
          send: vi.fn(),
          request: vi.fn(),
          onClose: vi.fn(() => ({ dispose: () => {} })),
          isClosed: () => false,
        },
        holderName: "studio-02",
      }));
      const refused = await run();
      expect(refused.result.isError).toBe(true);
      expect(JSON.stringify(refused.result.content)).toContain("studio-02 has control");
      expect(refused.handleProjectRunCheck).not.toHaveBeenCalled();
    });
  });
});
