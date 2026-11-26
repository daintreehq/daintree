// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

const { userData, mockIpcMain, mockWebContents, mockProjectViews } = vi.hoisted(() => {
  class IpcMainMock {
    private listeners = new Map<string, Set<(...args: unknown[]) => void>>();
    on(event: string, listener: (...args: unknown[]) => void): this {
      const set = this.listeners.get(event) ?? new Set();
      set.add(listener);
      this.listeners.set(event, set);
      return this;
    }
    removeListener(event: string, listener: (...args: unknown[]) => void): this {
      this.listeners.get(event)?.delete(listener);
      return this;
    }
    emit(event: string, ...args: unknown[]): boolean {
      const set = this.listeners.get(event);
      if (!set) return false;
      for (const fn of set) fn(...args);
      return set.size > 0;
    }
    removeAllListeners(): this {
      this.listeners.clear();
      return this;
    }
  }
  return {
    userData: { dir: "" },
    mockIpcMain: new IpcMainMock(),
    mockWebContents: new Map<number, unknown>(),
    mockProjectViews: new Map<string, unknown[]>(),
  };
});

vi.mock("electron", () => ({
  app: {
    getVersion: () => "0.0.0-test",
    getPath: (key: string) => {
      if (key === "userData") return userData.dir;
      throw new Error(`unexpected getPath: ${key}`);
    },
  },
  ipcMain: mockIpcMain,
  webContents: { fromId: (id: number) => mockWebContents.get(id) },
}));

vi.mock("../../../window/windowRef.js", () => ({ getProjectViewManager: () => null }));

vi.mock("../../../window/webContentsRegistry.js", () => ({
  getWebContentsForProject: (projectId: string) => mockProjectViews.get(projectId) ?? [],
  getWindowForWebContents: () => null,
  getProjectForWebContents: (id: number) => {
    for (const [projectId, views] of mockProjectViews) {
      if (views.some((view) => (view as { id: number }).id === id)) return projectId;
    }
    return null;
  },
}));

vi.mock("../../../utils/webContentsLifecycle.js", () => ({
  isWebContentsFrozen: () => false,
  unfreezeWebContents: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../../services/viewless/index.js", () => ({
  runViewlessAction: vi.fn(),
  describeViewlessWorkspace: vi.fn().mockResolvedValue(undefined),
  hasViewlessImplementation: () => false,
}));

import { CHANNELS } from "../../../ipc/channels.js";
import type { ActionId, ActionManifestEntry } from "../../../../shared/types/actions.js";
import { GLOBAL_ASSISTANT_ID } from "../../../../shared/config/globalAssistant.js";
import { createRendererBridge } from "../../../services/mcp-server/rendererBridge.js";
import { createSessionServer } from "../../../services/mcp-server/sessionServer.js";
import {
  createSessionServerDeps,
  type SessionServerDepsHost,
  type SessionServerDepsSource,
} from "../../../services/mcp-server/sessionServerDeps.js";
import { SessionStore } from "../../../services/mcp-server/sessionStore.js";
import { relayOwnershipPrincipal } from "../../../services/mcp-server/resourceOwnership.js";
import {
  RELAY_CALL_ID_META_KEY,
  type DispatchEnvelope,
  type McpRelayCaller,
  type PendingRequest,
} from "../../../services/mcp-server/shared.js";
import { setPluginAssistantReachSource } from "../../../services/plugin/pluginAssistantReach.js";
import { makeInstalledProjectInstanceKey } from "../../../../shared/types/plugin/instanceKeys.js";
import type { LinkSession } from "../../link/session.js";
import { makeTempDir, openSessionPair, removeTempDir } from "../../link/__tests__/linkTestUtils.js";
import type { MetricsSessionContext } from "../../metrics/hostMetricsHost.js";
import { HostCallRuntime, type ObservedHost, type OpenRun } from "../HostCallRuntime.js";
import { HostControlLinkClient } from "../HostControlLinkClient.js";
import {
  installHostMcpRelay,
  relayCallerOf,
  type RelayMcpSession,
  type RelayMcpSessionSpec,
} from "../hostMcpRelay.js";
import { installAssistantSenderHostWith } from "../hostSenders.js";
import { SenderSessions } from "../senderSessions.js";

/**
 * Acceptance evidence for #18255: the Shell's global Assistant reaching a
 * plugin action on another machine, across a real link, through the real
 * sender proof, relay, session server and renderer bridge on the host, down
 * to the window there that asks. Only that window is a stand-in: it answers
 * searches from the host's manifest and shows the action's dialog, which each
 * case answers on the host.
 */

const HOST_ID = "studio";
const PROJECT = "a".repeat(64);
const CREDENTIAL = "C".repeat(43);
const VIEW_ID = 41;
// A project plugin's action id, longer than a link once carried (#18153).
const REACH = `${makeInstalledProjectInstanceKey(PROJECT, "acme-tools.release-stages")}.resume-paused-stage`;

const HOST: ObservedHost = {
  hostId: HOST_ID,
  name: "studio-01",
  connection: {
    status: "connected",
    rttMs: 12,
    handshake: {
      version: "1.0.0",
      commit: "abc1234",
      protocolVersion: 12,
      platform: "linux",
      arch: "x64",
    },
  },
  lastSeenAt: null,
  summary: null,
};

function entry(id: string, kind: "query" | "command", danger: "safe" | "confirm") {
  return {
    id: id as ActionId,
    name: id,
    title: id,
    description: `description for ${id}`,
    category: "test",
    kind,
    danger,
    enabled: true,
    requiresArgs: false,
    inputSchema: { type: "object", properties: {} },
  } satisfies ActionManifestEntry;
}

const MANIFEST: ActionManifestEntry[] = [
  entry("actions.search", "query", "safe"),
  entry("terminal.list", "query", "safe"),
  { ...entry(REACH, "command", "confirm"), pluginId: "acme-tools.release-stages" },
];

/** The window on the host that shows the project: it asks, and each case answers. */
class HostWindow {
  decision: "approved" | "rejected" = "approved";
  readonly dialogs: Array<{ callerOrigin: unknown }> = [];
  readonly ran: Array<{ callerOrigin: unknown }> = [];
  /** Runs right before the person's answer reaches main, as a change made while they read. */
  beforeAnswer: () => void = () => {};

  constructor(private readonly bridge: ReturnType<typeof createRendererBridge>) {}

  readonly webContents = {
    id: VIEW_ID,
    isDestroyed: () => false,
    once: vi.fn(),
    removeListener: vi.fn(),
    send: (channel: string, payload: Record<string, unknown>) => {
      if (channel !== CHANNELS.MCP_SERVER_DISPATCH_ACTION_REQUEST) return;
      queueMicrotask(() => this.answer(payload));
    },
  };

  private respond(response: Record<string, unknown>): void {
    mockIpcMain.emit(
      CHANNELS.MCP_SERVER_DISPATCH_ACTION_RESPONSE,
      { sender: { id: VIEW_ID } },
      response
    );
  }

  private answer(payload: Record<string, unknown>): void {
    const requestId = payload.requestId as string;
    if (payload.actionId === "actions.search") {
      this.respond({
        requestId,
        result: { ok: true, result: { totalMatches: MANIFEST.length, results: MANIFEST } },
      });
      return;
    }
    if (payload.actionId !== REACH) {
      this.respond({ requestId, result: { ok: true, result: null } });
      return;
    }
    this.dialogs.push({ callerOrigin: payload.callerOrigin });
    this.bridge.holdDispatch(VIEW_ID, requestId, "shown");
    this.beforeAnswer();
    if (this.decision === "rejected") {
      this.respond({
        requestId,
        result: { ok: false, error: { code: "USER_REJECTED", message: "Rejected" } },
        confirmationDecision: "rejected",
      });
      return;
    }
    // As the view does: main has the last word on whether an approval may run.
    if (!this.bridge.holdDispatch(VIEW_ID, requestId, "approved").held) return;
    this.ran.push({ callerOrigin: payload.callerOrigin });
    this.respond({
      requestId,
      result: { ok: true, result: { resumed: true } },
      confirmationDecision: "approved",
    });
  }

  show(): void {
    mockWebContents.set(VIEW_ID, this.webContents);
    mockProjectViews.set(PROJECT, [this.webContents]);
  }
}

/** The host: its own MCP session server and bridge, as `hostListener` opens one per relay principal. */
class Host {
  readonly store = new SessionStore(() => {});
  readonly pending = new Map<string, PendingRequest<DispatchEnvelope>>();
  readonly bridge = createRendererBridge(new Map(), this.pending, () => null);
  readonly window = new HostWindow(this.bridge);
  accepts = true;
  private next = 0;

  constructor() {
    this.bridge.setupListeners([]);
  }

  async open(spec: RelayMcpSessionSpec): Promise<RelayMcpSession> {
    const store = this.store;
    const sessionId = `relay-${++this.next}`;
    store.sessionTierMap.set(sessionId, spec.tier);
    store.sessionOriginMap.set(sessionId, "external");
    store.resourceOwnership.bindPrincipal(
      sessionId,
      relayOwnershipPrincipal(spec.senderId, spec.helpSessionId)
    );
    store.sessionWorkspaceMap.set(sessionId, spec.projectId);
    const deadlines = new Map<string, number>();
    const caller: McpRelayCaller = {
      ...relayCallerOf(spec),
      callDeadline: (callId) => deadlines.get(callId),
    };
    store.sessionRelayMap.set(sessionId, caller);
    const source = {
      sessionStore: store,
      auditService: { append: vi.fn() },
      turnOutcomeService: { getCurrentTurnIdForSession: () => undefined },
      abusePolicy: {},
      requestManifest: async () => MANIFEST,
      requestManifestForWorkspace: async () => MANIFEST,
      getCachedManifest: () => MANIFEST,
      getCachedManifestForWorkspace: () => MANIFEST,
      dispatchAction: vi.fn(),
      dispatchActionForWorkspace: this.bridge.dispatchActionForWorkspace,
      isAgentPaneInWorkspace: async () => false,
    } as unknown as SessionServerDepsSource;
    const host: SessionServerDepsHost = {
      registry: () => null,
      assistantControlBinding: () => null,
      helpSessionTerminalResolver: () => null,
      getBearerInfoForSession: () => null,
      assistantControl: {} as SessionServerDepsHost["assistantControl"],
    };
    const server = createSessionServer(
      sessionId,
      createSessionServerDeps(source, host, {
        sessionId,
        role: "relay",
        workspaceBinding: { workspaceId: spec.projectId },
        relay: caller,
      })
    );
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    store.relaySessions.set(sessionId, { transport: serverTransport, server });
    serverTransport.onclose = () => store.revokeSession(sessionId);
    const client = new Client({ name: "daintree-host-call", version: "0.0.0-test" });
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    return {
      isOpen: () => store.relaySessions.has(sessionId),
      callTool: async (tool, args, options) => {
        deadlines.set(options.callId, Date.now() + options.timeoutMs);
        try {
          return (await client.callTool(
            { name: tool, arguments: args, _meta: { [RELAY_CALL_ID_META_KEY]: options.callId } },
            undefined,
            { timeout: options.timeoutMs }
          )) as never;
        } finally {
          deadlines.delete(options.callId);
        }
      },
      close: () => {
        store.revokeSession(sessionId);
        void client.close().catch(() => {});
      },
    };
  }
}

const GLOBAL_RUN: OpenRun = {
  projectId: GLOBAL_ASSISTANT_ID,
  slot: 0,
  sessionId: "help-g",
  terminalId: "t-g",
  launchGeneration: 1,
  conversationOwnershipId: "conv-g",
};
const PROJECT_RUN: OpenRun = {
  projectId: "proj-1",
  slot: 0,
  sessionId: "help-a",
  terminalId: "t-a",
  launchGeneration: 1,
};

let dir: string;
let links: { host: LinkSession; client: LinkSession };
let host: Host;
let asked: string[];
let runtime: HostCallRuntime;
let disposeAll: () => void;
let uninstallReach: () => void;

beforeEach(async () => {
  dir = await makeTempDir();
  userData.dir = dir;
  mockIpcMain.removeAllListeners();
  mockWebContents.clear();
  mockProjectViews.clear();
  links = await openSessionPair(dir);
  host = new Host();
  // The host's own registry: the plugin offers this action to the assistant.
  uninstallReach = setPluginAssistantReachSource({
    has: (id) => id === REACH,
    ids: () => [REACH],
  });

  const senders = new SenderSessions();
  const ctx = {
    session: links.host,
    sessionId: "link-1",
    client: { clientName: "greg-mbp" },
  } as unknown as MetricsSessionContext;
  const source = { sessions: [ctx], onSession: () => () => {}, onSessionExpired: () => () => {} };
  const offSenders = installAssistantSenderHostWith(source, { senders });
  const relay = installHostMcpRelay(source, {
    senders: () => senders,
    acceptsRemoteControl: () => host.accepts,
    hasProject: async (projectId) => projectId === PROJECT,
    openSession: (spec) => host.open(spec),
  });

  asked = [];
  let ids = 0;
  const client = new HostControlLinkClient({
    credential: () => CREDENTIAL,
    session: async () => links.client,
    onSessionOpened: (listener) => {
      listener(HOST_ID, links.client);
      return () => {};
    },
    noticeReceiver: () => runtime,
    approvalReceiver: () => runtime,
    noticeStatusDelayMs: 60_000,
  });
  const runs = new Map([
    [GLOBAL_RUN.sessionId, GLOBAL_RUN],
    [PROJECT_RUN.sessionId, PROJECT_RUN],
  ]);
  runtime = new HostCallRuntime({
    getSessionLane: (id) => {
      const run = runs.get(id);
      return run ? { projectId: run.projectId, slot: run.slot } : null;
    },
    callerRun: (id) => runs.get(id) ?? null,
    client: () => client,
    hosts: () => [HOST],
    inLocalView: () => true,
    controlEnabled: (hostId) => hostId === HOST_ID,
    // The Shell is never the one asked about a plugin action on the host.
    askApproval: async (question) => {
      asked.push(question.actionId);
      return { decision: "approved" };
    },
    newId: () => `00000000-0000-4000-8000-${String(++ids).padStart(12, "0")}`,
  });
  client.start();
  disposeAll = () => {
    runtime.dispose();
    client.dispose();
    relay.dispose();
    offSenders();
  };
});

afterEach(async () => {
  disposeAll();
  uninstallReach();
  links.host.close("test");
  links.client.close("test");
  await removeTempDir(dir);
});

function call(tool: string, args: Record<string, unknown>, helpSessionId = GLOBAL_RUN.sessionId) {
  return runtime.call(
    helpSessionId,
    { hostId: HOST_ID, projectId: PROJECT, tool, args },
    { tier: "core" }
  );
}

async function relayed(tool: string, args: Record<string, unknown>, helpSessionId?: string) {
  const settled = await call(tool, args, helpSessionId);
  if (!settled.ok) throw new Error(`refused: ${JSON.stringify(settled)}`);
  return settled.value;
}

function resultText(value: Awaited<ReturnType<typeof relayed>>): string {
  return JSON.stringify(value.result);
}

describe("the global Assistant reaching a plugin action on another machine (#18255)", () => {
  it("finds it through actions.search and runs it once the dialog is answered on the host", async () => {
    host.window.show();

    const search = await relayed("actions.search", { query: "resume" });
    expect(resultText(search)).toContain(REACH);

    const ran = await relayed(REACH, { stageId: "s1" });

    expect(ran.outcome).toBe("ok");
    expect(resultText(ran)).toContain("resumed");
    expect(host.window.dialogs).toEqual([{ callerOrigin: "global-assistant" }]);
    expect(host.window.ran).toEqual([{ callerOrigin: "global-assistant" }]);
    expect(asked).toEqual([]);
  });

  it("runs nothing when the dialog on the host is cancelled", async () => {
    host.window.show();
    host.window.decision = "rejected";

    const answer = await relayed(REACH, { stageId: "s1" });

    expect(resultText(answer)).toContain("USER_REJECTED");
    expect(host.window.dialogs).toHaveLength(1);
    expect(host.window.ran).toEqual([]);
    expect(asked).toEqual([]);
  });

  it("refuses it while the host doesn't let other machines' assistants work there", async () => {
    host.window.show();
    host.accepts = false;

    const answer = await relayed(REACH, { stageId: "s1" });

    // Refused as every call to a host that takes no other machine's work is.
    expect(answer.outcome).toBe("policy_rejected");
    expect(host.window.dialogs).toEqual([]);
    expect(host.window.ran).toEqual([]);
  });

  it("runs nothing when the host stops letting them while its dialog is open", async () => {
    host.window.show();
    host.window.beforeAnswer = () => {
      host.accepts = false;
    };

    const answer = await relayed(REACH, { stageId: "s1" });

    expect(resultText(answer)).toContain("stopped letting other machines' assistants work here");
    expect(host.window.dialogs).toHaveLength(1);
    expect(host.window.ran).toEqual([]);
  });

  it("refuses it with no window on the host showing the project, and never asks the Shell", async () => {
    const answer = await relayed(REACH, { stageId: "s1" });

    expect(resultText(answer)).toContain("NO_FRONTEND_ATTACHED");
    expect(host.window.dialogs).toEqual([]);
    expect(asked).toEqual([]);
  });

  it("keeps it from an ordinary relayed session: a project assistant's", async () => {
    host.window.show();

    const search = await relayed("actions.search", { query: "resume" }, PROJECT_RUN.sessionId);
    const answer = await relayed(REACH, { stageId: "s1" }, PROJECT_RUN.sessionId);

    expect(resultText(search)).not.toContain(REACH);
    expect(resultText(answer)).toContain("NOT_FOUND");
    expect(host.window.dialogs).toEqual([]);
  });

  it("refuses it once the host's plugin stops offering it, whatever the Shell sent it as", async () => {
    host.window.show();
    uninstallReach();

    const answer = await relayed(REACH, { stageId: "s1" });

    expect(resultText(answer)).toContain("isn't a plugin action this host offers");
    expect(host.window.dialogs).toEqual([]);
  });
});
