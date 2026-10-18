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
    expect(store.getRelayCaller(id)).toEqual(CALLER);
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
    expect(relayOf("terminal.list")).toEqual({ linkSessionId: "link-1", readOnly: true });
    expect(relayOf("agent.launch")).toEqual({ linkSessionId: "link-1", readOnly: false });
    expect(relayOf("copyTree.generate")).toEqual({ linkSessionId: "link-1", readOnly: false });
    session.close();
  });

  it("gives its notices the relay principal's pane, routed back over its link (#13500)", async () => {
    const whenIdle = vi.fn().mockResolvedValue({ armed: true, terminalId: "t-1" });
    const { lc } = await startedLifecycle({
      terminalNotify: {
        whenIdle,
        prepareSend: vi.fn(),
        prepareLaunch: vi.fn(),
        prepareKeys: vi.fn(),
        forgetTarget: vi.fn(),
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
      linkSessionId: "link-1",
      helpSessionId: "help-1",
      callId: "call-7",
    });
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
});
