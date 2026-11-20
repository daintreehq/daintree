import fs from "node:fs/promises";
import http from "node:http";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  MemoryKeyStore,
  MemoryLocalStore,
  SERVER_INSTRUCTIONS,
  TOOLS,
  adjustmentText,
  askedInstruction,
  followupInstruction,
  loadIdentity,
  type DecisionsBridge,
  type Identity,
  type StoredIdentity,
  type WebSocketLike,
} from "@daintreehq/decisions-client";
import {
  exportPublicKey,
  generateDeviceKeys,
  generateEpochKeyBytes,
  issueDeviceCert,
  serializeDeviceKeys,
  type DeviceKeys,
} from "@daintreehq/decisions-crypto";
import { bytesToBase64Url, type SignedQuestion } from "@daintreehq/decisions-protocol";

// `/mcp/decisions` as an agent's CLI reaches it (#16011): the real listener,
// its hold, the library's handler and a real store. Raw requests, so Host and
// Origin can be set as a rebinding page would.

const testHomeDir = vi.hoisted(
  () => `${process.cwd()}/.vitest-decisions-route-${Math.random().toString(36).slice(2)}`
);

const storeState = vi.hoisted(() => ({ values: new Map<string, unknown>() }));

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  const mocked = { ...actual, homedir: () => testHomeDir };
  return { ...mocked, default: mocked };
});

vi.mock("electron", () => ({
  ipcMain: {
    on: vi.fn(),
    off: vi.fn(),
    removeListener: vi.fn(),
    removeAllListeners: vi.fn(),
    handle: vi.fn(),
    removeHandler: vi.fn(),
  },
  webContents: { fromId: vi.fn(() => undefined), getAllWebContents: vi.fn(() => []) },
  BrowserWindow: class BrowserWindow {},
  app: { getVersion: () => "0.0.0-test", getPath: () => testHomeDir },
  net: { isOnline: () => true },
  powerMonitor: { on: vi.fn(), off: vi.fn() },
  safeStorage: {},
}));

vi.mock("../../../store.js", () => ({
  store: {
    get: vi.fn((key: string) => storeState.values.get(key)),
    set: vi.fn((key: string, value: unknown) => {
      storeState.values.set(key, value);
    }),
  },
  auditLogsStore: { get: vi.fn(() => []), set: vi.fn() },
}));

vi.mock("../../persistence/auditRingStore.js", () => ({
  auditRingStore: { readAll: () => [], writeAll: vi.fn() },
}));

vi.mock("../../McpPaneConfigService.js", () => ({
  mcpPaneConfigService: { isValidPaneToken: () => false, getTierForToken: () => undefined },
}));

vi.mock("../../SystemSleepService.js", () => ({
  getSystemSleepService: vi.fn(() => ({
    getAwakeTimeSince: vi.fn(() => 0),
    onWake: vi.fn(() => () => {}),
  })),
}));

vi.mock("../../PluginService.js", () => ({
  pluginService: {
    hasPlugin: () => true,
    activatePlugin: vi.fn(async () => {}),
    findAgentMcpServerSource: () => undefined,
  },
}));

import { McpServerService } from "../../McpServerService.js";
import {
  DECISIONS_MCP_PATH,
  DecisionsMcpRoute,
  openDecisionsMcpRoute,
  type DecisionsListenerHold,
  type DecisionsQuestions,
} from "../mcpRoute.js";
import type { ListenerRoute } from "../../mcp-server/listenerHold.js";
import type { PaneBearer, PaneTerminalInfo, PaneTerminalReader } from "../paneAccess.js";
import { RelayConnection, type QuestionSource } from "../relayConnection.js";
import type { RelayFetch } from "../relayCheck.js";
import { DecisionsAttachments, type QuestionAttachments } from "../attachmentSpool.js";
import { DESIGN_REVIEW_FINAL_GATE_ID, createTrustedPolicy } from "../workflowGates.js";
import type { DecisionsRole } from "../DecisionsService.js";
import { defaultDecisionsSettings } from "../decisionsSettings.js";

const API_KEY = "orchestration-api-key";
const HELP_TOKEN = "help-session-token";
const HOST_ID = "host_decisions_test";

const emptyRegistry = {
  all: () => [],
  focusOrder: () => [],
  getPrimary: () => null,
  getByWindowId: () => null,
  getByWebContentsId: () => null,
  size: 0,
};

interface Answer {
  status: number;
  body: string;
}

function request(
  port: number,
  path: string,
  options: { method?: string; headers?: Record<string, string>; body?: string } = {}
): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        path,
        method: options.method ?? "GET",
        headers: { Connection: "close", ...options.headers },
        agent: false,
      },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => {
          body += chunk;
        });
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
      }
    );
    req.setTimeout(5_000, () => req.destroy(new Error(`${path} didn't answer`)));
    req.on("error", reject);
    req.end(options.body);
  });
}

let nextId = 1;

function rpc(
  port: number,
  token: string | null,
  method: string,
  params: Record<string, unknown> = {},
  headers: Record<string, string> = {}
): Promise<Answer> {
  return request(port, DECISIONS_MCP_PATH, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token === null ? {} : { Authorization: `Bearer ${token}` }),
      ...headers,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: nextId++, method, params }),
  });
}

interface ToolResult {
  isError?: boolean;
  content: Array<{ type: string; text: string }>;
  structuredContent: Record<string, unknown>;
}

async function call(
  port: number,
  token: string,
  name: string,
  args: Record<string, unknown>
): Promise<ToolResult> {
  const answer = await rpc(port, token, "tools/call", { name, arguments: args });
  expect(answer.status).toBe(200);
  return (JSON.parse(answer.body) as { result: ToolResult }).result;
}

async function ownerIdentity(): Promise<StoredIdentity> {
  const keys = await generateDeviceKeys(true);
  return {
    v: 1,
    config: {
      relayOrigin: "https://decisions.example.workers.dev",
      installationId: "inst_12345678",
      deviceId: "dev_12345678",
      label: "Test desktop",
    },
    keys: await serializeDeviceKeys(keys),
    epochs: [{ epoch: 1, raw: bytesToBase64Url(generateEpochKeyBytes()) }],
    currentEpoch: 1,
  };
}

interface Pane {
  token: string;
  bearer: PaneBearer;
  generation: number;
  info: PaneTerminalInfo;
}

function pane(id: string, overrides: Partial<PaneTerminalInfo> = {}): Pane {
  return {
    token: `pane-token-${id}`,
    bearer: { paneId: id, principal: `principal-${id}`, workspaceId: "project-1" },
    generation: 3,
    info: {
      projectId: "project-1",
      worktreeId: "wt-main",
      cwd: "/work/repo",
      launchAgentId: "claude",
      detectedAgentId: "claude",
      agentIncarnation: 0,
      agentSessionId: "session-1",
      launchGeneration: 3,
      hasPty: true,
      ...overrides,
    },
  };
}

/** A socket the relay never opens: an attempt has started once its bridge has, and publishes over HTTP. */
class SilentSocket implements WebSocketLike {
  readyState = 0;
  onopen: WebSocketLike["onopen"] = null;
  onmessage: WebSocketLike["onmessage"] = null;
  onclose: WebSocketLike["onclose"] = null;
  onerror: WebSocketLike["onerror"] = null;
  send(): void {
    throw new Error("not open");
  }
  close(): void {
    this.readyState = 3;
  }
}

const RELAY_080_FEATURES = [
  "involvement-v1",
  "owner-desktop-answers-v1",
  "owner-desktop-declines-v1",
  "owner-desktop-messages-v1",
  "pane-snapshots-v1",
  "person-declines-v1",
  "phone-images-v1",
  "presence-v1",
  "thread-messages-v1",
];
/** What the deployed 0.9.0 relay lists in `/info`. */
const RELAY_090_FEATURES = [
  ...RELAY_080_FEATURES,
  "advisory-deadlines-v1",
  "agent-stopped-push-v1",
];

/**
 * A relay for a real connection's attempts: its `/info`, a device directory
 * holding this owner and one phone it certified, socket tickets, and the
 * questions Daintree publishes. `holdInfo` keeps `/info` unanswered until
 * released.
 */
async function fakeRelay(
  owner: Identity,
  options: { relayFeatures: string[]; phoneFeatures: string[]; workerVersion: string }
) {
  const { installationId, deviceId } = owner.config;
  const phone: DeviceKeys = await generateDeviceKeys(false);
  const entry = async (id: string, role: "owner-desktop" | "phone", of: DeviceKeys) => {
    const cert = await issueDeviceCert({
      issuerDeviceId: deviceId,
      issuerSigningKey: owner.keys.signing.privateKey,
      installationId,
      deviceId: id,
      role,
      label: role,
      signingPub: await exportPublicKey(of.signing.publicKey),
      exchangePub: await exportPublicKey(of.exchange.publicKey),
    });
    return {
      device_id: id,
      role,
      label: role,
      created_at: new Date().toISOString(),
      revoked_at: null,
      last_seen_at: null,
      last_ack_seq: 0,
      cert,
      push_enabled: false,
      ...(role === "phone" ? { features: options.phoneFeatures } : {}),
    };
  };
  const devices = {
    key_epoch: 1,
    owner_device_id: deviceId,
    devices: [
      await entry(deviceId, "owner-desktop", owner.keys),
      await entry("dev_phone_1234", "phone", phone),
    ],
  };
  /** Every request Daintree made, as `METHOD /path`. */
  const requests: string[] = [];
  /** The questions Daintree published, in order. */
  const creates: Array<{ idempotency_key: string; question: SignedQuestion }> = [];
  /** The features each socket ticket declared. */
  const tickets: unknown[] = [];
  let infoHeld: Promise<void> = Promise.resolve();
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const fetchImpl: RelayFetch = async (url, init) => {
    const { pathname } = new URL(url);
    const method = init.method ?? "GET";
    requests.push(`${method} ${pathname}`);
    if (pathname === "/api/v1/info") {
      // A stopped connection aborts the read it was holding.
      await new Promise<void>((resolve, reject) => {
        const signal = init.signal;
        if (signal?.aborted) return reject(signal.reason as Error);
        signal?.addEventListener("abort", () => reject(signal.reason as Error), { once: true });
        void infoHeld.then(resolve);
      });
      return json({
        name: "daintree-decisions",
        protocol_min: 1,
        protocol_max: 1,
        worker_version: options.workerVersion,
        claimed: true,
        claim_configured: true,
        voice: { xai: false, anthropic: false, openai: false },
        features: options.relayFeatures,
      });
    }
    if (pathname === "/api/v1/devices") return json(devices);
    if (pathname === "/api/v1/socket-ticket" && method === "POST") {
      tickets.push((JSON.parse(String(init.body)) as { features?: unknown }).features);
      return json({
        ticket: `ticket-${tickets.length}`,
        expires_at: new Date(Date.now() + 30_000).toISOString(),
        ws_path: "/api/v1/socket",
      });
    }
    if (pathname === "/api/v1/questions" && method === "POST") {
      creates.push(JSON.parse(String(init.body)) as (typeof creates)[number]);
      return json({ event_seq: creates.length });
    }
    return json({ code: "not_found", message: "no route" }, 404);
  };
  return {
    fetchImpl,
    requests,
    creates,
    tickets,
    holdInfo(): () => void {
      let release!: () => void;
      infoHeld = new Promise((resolve) => {
        release = resolve;
      });
      return release;
    },
  };
}

/** Once the attempt has read what the relay and the phones support for advice, and it is `expected`. */
async function adviceSupportRead(
  live: DecisionsBridge,
  expected: { relay: boolean; reader: boolean | null }
): Promise<void> {
  // The library keeps the facts on the bridge it reads them for; nothing public says they are in.
  const advisory = (
    live as unknown as {
      advisory: { known(): Promise<{ relay: boolean | null; reader: boolean | null }> };
    }
  ).advisory;
  await vi.waitFor(async () => expect(await advisory.known()).toEqual(expected));
}

const CAPABLE = { relay: true, reader: true };

let identity: StoredIdentity;

describe("/mcp/decisions (#16011)", () => {
  let service: McpServerService;
  let store: MemoryLocalStore;
  let loaded: Identity;
  let panes: Map<string, Pane>;
  /** Bearers revoked while their terminals run on. */
  let revoked: Set<string>;
  let fetches: number;
  let questions: DecisionsQuestions | null;
  /** Relay connections a test started, stopped after it. */
  let connections: RelayConnection[];

  const ptyClient: PaneTerminalReader = {
    getLiveGeneration: (id) => panes.get(id)?.generation ?? null,
    isLiveGeneration: (id, generation) => panes.get(id)?.generation === generation,
    getTerminalAsync: async (id) => panes.get(id)?.info ?? null,
  };

  function boot(enabled: boolean): Promise<void> {
    storeState.values.set("mcpServer", {
      enabled,
      port: 0,
      apiKey: API_KEY,
      auditEnabled: false,
      auditMaxRecords: 500,
    });
    return service.start(emptyRegistry as never);
  }

  /** The route as the Decisions service opens it, over a connection between attempts. */
  function openRoute(
    options: {
      attachments?: QuestionAttachments;
      advisoryDeadlines?: boolean;
      role?: DecisionsRole;
      defaultQuestionExpiryMs?: number | null;
      proxyAllowlisted?: boolean;
    } = {}
  ): Promise<number> {
    return mountRoute({
      identity: () => loaded,
      live: () => null,
      store,
      // The policy a lifetime starts with: the trusted gates, no proxy allowlist.
      policy: createTrustedPolicy(
        {
          ...defaultDecisionsSettings(),
          proxyAllowlisted: options.proxyAllowlisted ?? false,
          ...(options.defaultQuestionExpiryMs !== undefined
            ? { defaultQuestionExpiryMs: options.defaultQuestionExpiryMs }
            : {}),
        },
        options.role ?? "owner"
      ),
      ...(options.attachments ? { attachments: options.attachments } : {}),
      ...(options.advisoryDeadlines ? { advisoryDeadlines: true } : {}),
    });
  }

  /** The route as the Decisions service opens it over `source`. */
  async function mountRoute(source: QuestionSource): Promise<number> {
    let held: number | null = null;
    questions = openDecisionsMcpRoute(source, {
      bearerFor: (token) =>
        revoked.has(token)
          ? null
          : ([...panes.values()].find((candidate) => candidate.token === token)?.bearer ?? null),
      principalFor: (paneId) => {
        const held = panes.get(paneId);
        return held && !revoked.has(held.token) ? held.bearer.principal : null;
      },
      hostId: () => HOST_ID,
      getPtyClient: () => ptyClient,
      holdListener: async (id, route) => {
        const hold = await service.holdListener(id, route);
        held = hold.port;
        return hold;
      },
    });
    await vi.waitFor(() => expect(held).not.toBeNull());
    return held!;
  }

  function add(...added: Pane[]): void {
    for (const p of added) panes.set(p.bearer.paneId, p);
  }

  /**
   * The owner's connection to `relay` as a lifetime that delivers advisory
   * outcomes runs it, with the route mounted on the question source it hands
   * out, once its first attempt has started.
   */
  async function connectOwner(
    relay: Awaited<ReturnType<typeof fakeRelay>>,
    settings: { defaultQuestionExpiryMs?: number | null } = {}
  ): Promise<{ port: number; live: DecisionsBridge }> {
    const keys = new MemoryKeyStore();
    await keys.save(identity);
    let source: QuestionSource | null = null;
    const connection = new RelayConnection({
      relay: {
        relayOrigin: identity.config.relayOrigin,
        installationId: identity.config.installationId,
        deviceId: identity.config.deviceId,
      },
      store,
      keys,
      policy: createTrustedPolicy(
        { ...defaultDecisionsSettings(), proxyAllowlisted: false, ...settings },
        "owner"
      ),
      onStatus: () => {},
      onRevoked: () => {},
      fetchImpl: relay.fetchImpl,
      webSocket: () => new SilentSocket(),
      watchResume: () => () => {},
      watchNetwork: () => () => {},
      pumpIntervalMs: 0,
      helloTimeoutMs: 10 * 60_000,
      delivery: {
        hostId: () => HOST_ID,
        principalFor: () => null,
        getPtyClient: () => ({
          getLiveGeneration: () => null,
          isLiveGeneration: () => false,
          getTerminalAsync: async () => null,
        }),
        holdWakes: () => ({ queueWake: () => {}, cancelQueued: () => {}, release: () => {} }),
        watchPanes: () => () => {},
      },
      advisoryDeadlines: true,
      onQuestionsReady: (ready) => {
        source = ready;
      },
    });
    connections.push(connection);
    connection.start();
    await vi.waitFor(() => expect(source?.live()).toBeTruthy());
    const ready = source as unknown as QuestionSource;
    return { port: await mountRoute(ready), live: ready.live()! };
  }

  beforeEach(async () => {
    identity ??= await ownerIdentity();
    storeState.values.clear();
    await fs.mkdir(testHomeDir, { recursive: true });
    vi.spyOn(console, "log").mockImplementation(() => {});
    service = new McpServerService();
    service.setHelpTokenValidator((token) => (token === HELP_TOKEN ? "full" : false));
    // The rest of an assistant's binding, without which the control surface refuses it.
    service.setHelpSessionWebContentsResolver((token) => (token === HELP_TOKEN ? 1 : null));
    service.setHelpSessionIdResolver((token) => (token === HELP_TOKEN ? "help-1" : null));
    store = new MemoryLocalStore();
    const keys = new MemoryKeyStore();
    await keys.save(identity);
    loaded = await loadIdentity(keys);
    panes = new Map();
    revoked = new Set();
    questions = null;
    connections = [];
    fetches = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      fetches += 1;
      throw new Error("no network in this test");
    });
  });

  afterEach(async () => {
    await questions?.close();
    for (const connection of connections) await connection.stop();
    await service.stop();
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    await fs.rm(testHomeDir, { recursive: true, force: true });
  });

  it("serves the five tools to a pane bearer with the MCP server off, each described in under 400 bytes", async () => {
    await boot(false);
    add(pane("pane-a"));
    const port = await openRoute();

    const init = await rpc(port, "pane-token-pane-a", "initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "claude-code", version: "1.0.0" },
    });
    expect(init.status).toBe(200);
    expect(JSON.parse(init.body).result.serverInfo.name).toBe("daintree-decisions");

    const list = await rpc(port, "pane-token-pane-a", "tools/list");
    const tools = (
      JSON.parse(list.body) as { result: { tools: Array<{ name: string; description: string }> } }
    ).result.tools;
    expect(tools.map((tool) => tool.name).sort()).toEqual([
      "ask_human",
      "cancel_question",
      "get_decision",
      "get_involvement",
      "send_followup",
    ]);
    for (const tool of tools) {
      expect(Buffer.byteLength(tool.description, "utf8"), tool.name).toBeLessThan(400);
    }
  });

  it("answers get_involvement with the library's unavailable result before a relay attempt has read a preference (#17228)", async () => {
    await boot(false);
    add(pane("pane-a"));
    const port = await openRoute();

    const read = await call(port, "pane-token-pane-a", "get_involvement", {});

    expect(read.isError).not.toBe(true);
    expect(read.structuredContent).toMatchObject({
      status: "unavailable",
      reason: "not-synced",
      mode: null,
      revision: null,
      last_synced_at: null,
      stale: true,
    });
    expect(read.content[0].text).toContain("Use your normal configured behaviour.");
    expect(fetches).toBe(0);
  });

  // Daintree takes the relay's thread events (#16231), so `get_decision` returns the library's thread.
  it("tells agents about follow-ups in the library's own words, with get_decision's thread", async () => {
    await boot(false);
    add(pane("pane-a"));
    const port = await openRoute();

    const init = await rpc(port, "pane-token-pane-a", "initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "claude-code", version: "1.0.0" },
    });
    const instructions = (JSON.parse(init.body) as { result: { instructions: string } }).result
      .instructions;
    expect(instructions).toBe(SERVER_INSTRUCTIONS);
    expect(instructions).toContain("send_followup");

    const list = await rpc(port, "pane-token-pane-a", "tools/list");
    const tools = (JSON.parse(list.body) as { result: { tools: Array<Record<string, unknown>> } })
      .result.tools;
    // Every tool exactly as the library has it, get_decision's thread included.
    expect(tools).toEqual(TOOLS);
    const getDecision = tools.find((tool) => tool.name === "get_decision")!;
    expect(
      (getDecision.outputSchema as { properties: Record<string, unknown> }).properties
    ).toHaveProperty("thread");

    const asked = await call(port, "pane-token-pane-a", "ask_human", { question: "Which name?" });
    const [row] = await store.listQuestions();
    // From 0.9.0 the receipt goes on to the deadline that applies and how to find the question again.
    expect(asked.content[0].text.startsWith(`${askedInstruction(row.alias)} `)).toBe(true);
    expect(asked.content[0].text).toContain(
      `It waits for a decision until ${row.expires_at} (UTC); unanswered by then, it expires, and expiry authorises nothing.`
    );
    expect(asked.content[0].text).toContain("Policy: the deadline is the host's default.");
    expect(asked.content[0].text).toContain(`get_decision with question_id ${row.question_id}`);
    expect(asked.structuredContent.instruction).toBe(asked.content[0].text);
    const questionId = asked.structuredContent.question_id as string;

    await call(port, "pane-token-pane-a", "send_followup", {
      question_id: questionId,
      text: "One more thing",
      expects_reply: false,
    });
    const read = await call(port, "pane-token-pane-a", "get_decision", { question_id: questionId });
    expect(read.structuredContent).toMatchObject({ question_id: questionId, status: "queued" });
    // The follow-up joins the thread once the relay commits it; until then the thread is empty.
    expect(read.structuredContent.thread).toEqual([]);
  });

  it("refuses an advisory ask where advisory outcomes aren't delivered, storing nothing, and asks with a relative deadline as a blocking question", async () => {
    await boot(false);
    add(pane("pane-a"));
    const port = await openRoute();

    // The owner's policy allows advice, but this sink doesn't type the advisory notice yet (#17941).
    const advisory = await call(port, "pane-token-pane-a", "ask_human", {
      question: "Which name?",
      expires_in: "15m",
      planned_fallback: "Keep the current name.",
    });
    expect(advisory.isError).toBe(true);
    expect(advisory.content[0].text).toMatch(/host-unsupported/);
    expect(await store.listQuestions()).toEqual([]);

    const before = Date.now();
    const asked = await call(port, "pane-token-pane-a", "ask_human", {
      question: "Which name?",
      expires_in: "15m",
    });
    expect(asked.isError).toBeUndefined();
    const [row] = await store.listQuestions();
    expect(row.alias).toBe(1);
    expect(Date.parse(row.expires_at!) - before).toBeGreaterThanOrEqual(15 * 60_000 - 1_000);
    expect(Date.parse(row.expires_at!) - Date.now()).toBeLessThanOrEqual(15 * 60_000);
    expect(asked.structuredContent).toMatchObject({
      reply_mode: "blocking",
      expires_at: row.expires_at,
    });

    const read = await call(port, "pane-token-pane-a", "get_decision", {
      question_id: row.question_id,
    });
    expect(read.structuredContent).toMatchObject({
      reply_mode: "blocking",
      planned_fallback: null,
      fallback_due: false,
      advisory_timeout: null,
    });
  });

  it("asks a 15-minute advisory question on a capable owner connection, publishes its UTC deadline and plan, and reads them back only to its pane (#17940)", async () => {
    await boot(false);
    add(pane("pane-a"), pane("pane-b"));
    const relay = await fakeRelay(loaded, {
      relayFeatures: RELAY_090_FEATURES,
      phoneFeatures: ["advisory-deadlines-v1"],
      workerVersion: "0.9.0",
    });
    const { port, live } = await connectOwner(relay);
    await adviceSupportRead(live, CAPABLE);

    const before = Date.now();
    const asked = await call(port, "pane-token-pane-a", "ask_human", {
      question: "Which fixture should I use for the parser tests?",
      expires_in: "15m",
      planned_fallback: "Use the in-memory fixture.",
    });
    expect(asked.isError).toBeUndefined();
    const receipt = asked.structuredContent;
    expect(receipt).toMatchObject({
      reply_mode: "advisory",
      enforced_requirement: "human-required",
      planned_fallback: "Use the in-memory fixture.",
      policy_adjustments: [],
      duplicate: false,
    });
    const expiresAt = receipt.expires_at as string;
    expect(receipt.requested_expires_at).toBe(expiresAt);
    expect(expiresAt.endsWith("Z")).toBe(true);
    expect(Date.parse(expiresAt) - before).toBeGreaterThanOrEqual(15 * 60_000);
    expect(Date.parse(expiresAt) - Date.now()).toBeLessThanOrEqual(15 * 60_000);
    expect(asked.content[0].text).toContain(`Asked for advice, due ${expiresAt} (UTC).`);

    // The relay gets it signed as advice, with the deadline the agent was told and no gate.
    await vi.waitFor(() => expect(relay.creates).toHaveLength(1));
    const { question } = relay.creates[0];
    expect(question.record.question_id).toBe(receipt.question_id);
    expect(question.record.expires_at).toBe(expiresAt);
    expect(question.record.workflow_gate_id_hash).toBeNull();
    expect(question.envelope.aad.reply_mode).toBe("advisory");
    // The desktop still declares nothing of it until its sink types the advisory notice (#17941).
    await vi.waitFor(() => expect(relay.tickets.length).toBeGreaterThan(0));
    for (const features of relay.tickets) {
      expect(features).toContain("involvement-v1");
      expect(features).not.toContain("advisory-deadlines-v1");
    }

    const questionId = receipt.question_id as string;
    const read = await call(port, "pane-token-pane-a", "get_decision", { question_id: questionId });
    expect(read.structuredContent).toMatchObject({
      question_id: questionId,
      reply_mode: "advisory",
      planned_fallback: "Use the in-memory fixture.",
      expires_at: expiresAt,
      fallback_due: false,
      advisory_timeout: null,
    });

    // Another pane reads it as an id that names nothing, and learns nothing of the plan.
    const own = await call(port, "pane-token-pane-b", "ask_human", { question: "Which name?" });
    const ownId = own.structuredContent.question_id as string;
    expect(
      (await call(port, "pane-token-pane-b", "get_decision", { question_id: ownId })).isError
    ).toBeUndefined();
    const other = await call(port, "pane-token-pane-b", "get_decision", {
      question_id: questionId,
    });
    const unknownId = `${ownId.slice(0, -4)}zzzz`;
    expect(await store.getQuestion(unknownId)).toBeNull();
    const unknown = await call(port, "pane-token-pane-b", "get_decision", {
      question_id: unknownId,
    });
    for (const result of [other, unknown]) {
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toEqual({ error: "not_found" });
      expect(result.content[0].text).toBe("not_found: unknown question");
    }
    expect(JSON.stringify(other)).not.toContain("in-memory fixture");
  });

  it("shortens an advisory window past what policy allows, and says so in the receipt and the signed deadline (#17940)", async () => {
    await boot(false);
    add(pane("pane-a"));
    const relay = await fakeRelay(loaded, {
      relayFeatures: RELAY_090_FEATURES,
      phoneFeatures: ["advisory-deadlines-v1"],
      workerVersion: "0.9.0",
    });
    const { port, live } = await connectOwner(relay);
    await adviceSupportRead(live, CAPABLE);

    const before = Date.now();
    const asked = await call(port, "pane-token-pane-a", "ask_human", {
      question: "Which fixture should I use for the parser tests?",
      expires_in: "45d",
      planned_fallback: "Use the in-memory fixture.",
    });
    expect(asked.isError).toBeUndefined();
    const receipt = asked.structuredContent;
    const requested = receipt.requested_expires_at as string;
    const effective = receipt.expires_at as string;
    const day = 24 * 60 * 60_000;
    // An agent may ask a question without a gate to wait up to 30 days under the 7-day default.
    expect(Date.parse(requested) - Date.parse(effective)).toBe(15 * day);
    expect(Date.parse(effective) - before).toBeGreaterThanOrEqual(30 * day);
    expect(Date.parse(effective) - Date.now()).toBeLessThanOrEqual(30 * day);
    const adjustment = {
      field: "expires_at",
      requested,
      effective,
      source: "host",
      gate_id: null,
    } as const;
    expect(receipt).toMatchObject({ reply_mode: "advisory", policy_adjustments: [adjustment] });
    expect(asked.content[0].text).toContain(
      `Policy: ${adjustmentText({ ...adjustment, gateId: null })}.`
    );
    expect(asked.content[0].text).toContain(`Asked for advice, due ${effective} (UTC).`);
    await vi.waitFor(() => expect(relay.creates).toHaveLength(1));
    const { question } = relay.creates[0];
    expect(question.record.question_id).toBe(receipt.question_id);
    expect(question.record.expires_at).toBe(effective);
    expect(question.envelope.aad.reply_mode).toBe("advisory");
  });

  it("asks advice given no time with the saved default, which it says, and keeps a plain question's (#17940)", async () => {
    await boot(false);
    add(pane("pane-a"));
    const relay = await fakeRelay(loaded, {
      relayFeatures: RELAY_090_FEATURES,
      phoneFeatures: ["advisory-deadlines-v1"],
      workerVersion: "0.9.0",
    });
    const hour = 60 * 60_000;
    const { port, live } = await connectOwner(relay, { defaultQuestionExpiryMs: hour });
    await adviceSupportRead(live, CAPABLE);

    for (const planned of ["Use the in-memory fixture.", null]) {
      const before = Date.now();
      const asked = await call(port, "pane-token-pane-a", "ask_human", {
        question: "Which fixture should I use for the parser tests?",
        ...(planned ? { planned_fallback: planned } : {}),
      });
      expect(asked.isError, String(planned)).toBeUndefined();
      const expiresAt = asked.structuredContent.expires_at as string;
      expect(asked.structuredContent).toMatchObject({
        reply_mode: planned ? "advisory" : "blocking",
        requested_expires_at: null,
        planned_fallback: planned,
      });
      expect(Date.parse(expiresAt) - before).toBeGreaterThanOrEqual(hour);
      expect(Date.parse(expiresAt) - Date.now()).toBeLessThanOrEqual(hour);
      expect(asked.content[0].text).toContain("Policy: the deadline is the host's default.");
      expect(
        (await store.getQuestion(asked.structuredContent.question_id as string))?.expires_at
      ).toBe(expiresAt);
    }
  });

  it.each([
    [
      "a 0.8.0 relay",
      {
        relayFeatures: RELAY_080_FEATURES,
        phoneFeatures: ["advisory-deadlines-v1"],
        workerVersion: "0.8.0",
      },
      { relay: false, reader: null },
      "not_supported: relay-unsupported: ",
    ],
    [
      "a 0.9.0 relay that doesn't list advice",
      {
        relayFeatures: RELAY_080_FEATURES,
        phoneFeatures: ["advisory-deadlines-v1"],
        workerVersion: "0.9.0",
      },
      { relay: false, reader: null },
      "not_supported: relay-unsupported: ",
    ],
    [
      "no phone that shows advice",
      { relayFeatures: RELAY_090_FEATURES, phoneFeatures: [], workerVersion: "0.9.0" },
      { relay: true, reader: false },
      "not_supported: no-capable-reader: ",
    ],
  ])(
    "refuses advice with %s, storing and publishing nothing, and the same question asked for a decision goes ahead (#17940)",
    async (_label, relayOptions, support, refusal) => {
      await boot(false);
      add(pane("pane-a"));
      const relay = await fakeRelay(loaded, relayOptions);
      const { port, live } = await connectOwner(relay);
      await adviceSupportRead(live, support);

      const refused = await call(port, "pane-token-pane-a", "ask_human", {
        question: "Which fixture should I use for the parser tests?",
        expires_in: "15m",
        planned_fallback: "Use the in-memory fixture.",
      });
      expect(refused.isError).toBe(true);
      expect(refused.content[0].text.startsWith(refusal)).toBe(true);
      expect(refused.content[0].text).toContain(
        "Nothing was asked. To have the person decide instead, ask again without planned_fallback."
      );
      expect(await store.listQuestions()).toEqual([]);
      expect(relay.requests).not.toContain("POST /api/v1/questions");

      const asked = await call(port, "pane-token-pane-a", "ask_human", {
        question: "Which fixture should I use for the parser tests?",
        expires_in: "15m",
      });
      expect(asked.isError).toBeUndefined();
      expect(asked.structuredContent).toMatchObject({
        reply_mode: "blocking",
        planned_fallback: null,
      });
      await vi.waitFor(() => expect(relay.creates).toHaveLength(1));
      expect(relay.creates[0].question.record.question_id).toBe(
        asked.structuredContent.question_id
      );
      expect(relay.creates[0].question.envelope.aad.reply_mode).toBeUndefined();
    }
  );

  it("refuses advice until the relay's support is known, then asks it; a retry returns it as first asked, between attempts too (#17940)", async () => {
    await boot(false);
    add(pane("pane-a"));
    const relay = await fakeRelay(loaded, {
      relayFeatures: RELAY_090_FEATURES,
      phoneFeatures: ["advisory-deadlines-v1"],
      workerVersion: "0.9.0",
    });
    const release = relay.holdInfo();
    try {
      const { port, live } = await connectOwner(relay);
      const ask = {
        question: "Which fixture should I use for the parser tests?",
        expires_in: "15m",
        planned_fallback: "Use the in-memory fixture.",
        correlation_id: "fixture-choice",
      };

      // Asked while the attempt's read of the relay is still out.
      await vi.waitFor(() => expect(relay.requests).toContain("GET /api/v1/info"));
      const cold = await call(port, "pane-token-pane-a", "ask_human", ask);
      expect(cold.isError).toBe(true);
      expect(cold.content[0].text.startsWith("invalid_state: support-unknown: ")).toBe(true);
      expect(cold.content[0].text).toContain("try again in a minute");
      expect(await store.listQuestions()).toEqual([]);

      release();
      await adviceSupportRead(live, CAPABLE);
      const asked = await call(port, "pane-token-pane-a", "ask_human", ask);
      const first = asked.structuredContent;
      expect(first).toMatchObject({ reply_mode: "advisory", duplicate: false });
      const questionId = first.question_id as string;
      await vi.waitFor(async () =>
        expect(
          (await call(port, "pane-token-pane-a", "get_decision", { question_id: questionId }))
            .structuredContent.publication
        ).toBe("accepted")
      );
      // Later by the clock, so a deadline counted again from now would differ.
      await new Promise((resolve) => setTimeout(resolve, 5));
      const asFirstAsked = {
        question_id: questionId,
        duplicate: true,
        reply_mode: "advisory",
        expires_at: first.expires_at,
        requested_expires_at: first.requested_expires_at,
        planned_fallback: "Use the in-memory fixture.",
      };
      const again = await call(port, "pane-token-pane-a", "ask_human", ask);
      expect(again.structuredContent).toMatchObject(asFirstAsked);
      expect(again.content[0].text).toContain(`Already asked as q-`);

      // Between attempts a fresh ask for advice can't be decided, but the retry is the question it asked.
      await questions!.close();
      const between = await openRoute({ advisoryDeadlines: true, defaultQuestionExpiryMs: null });
      const retried = await call(between, "pane-token-pane-a", "ask_human", ask);
      expect(retried.structuredContent).toMatchObject(asFirstAsked);
      const fresh = await call(between, "pane-token-pane-a", "ask_human", {
        ...ask,
        correlation_id: "another-choice",
      });
      expect(fresh.content[0].text.startsWith("invalid_state: support-unknown: ")).toBe(true);
      expect(await store.listQuestions()).toHaveLength(1);
      expect(relay.creates.map((create) => create.question.record.question_id)).toEqual([
        questionId,
      ]);
    } finally {
      release();
    }
  });

  it("refuses advice for the final design review, other gates and approvals, and asks each again as a blocking question (#17940)", async () => {
    const root = await fs.mkdtemp(`${testHomeDir}/advice-`);
    const attachments = new DecisionsAttachments({
      dir: `${root}/spool`,
      referenced: async () => new Set(),
    });
    try {
      const worktree = `${root}/worktree`;
      await fs.mkdir(`${worktree}/shots`, { recursive: true });
      const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
      await fs.writeFile(`${worktree}/shots/final.png`, png);
      await boot(false);
      add(pane("pane-a", { cwd: worktree }));
      const port = await openRoute({ attachments, advisoryDeadlines: true });
      const plan = { planned_fallback: "Ship the current screenshots." };
      const finalReview = {
        question: "Approve the final design?",
        workflow_gate_id: DESIGN_REVIEW_FINAL_GATE_ID,
        // The gate's own choices replace these.
        options: [
          { id: "approve", label: "Approve" },
          { id: "reject", label: "Reject" },
        ],
        attachments: [{ local_resource_id: "shots/final.png", role: "after" }],
        expires_in: "15m",
      };
      const cases: Array<[Record<string, unknown>, string]> = [
        [finalReview, "validation_error: gated: "],
        [
          { question: "Deploy it?", workflow_gate_id: "agent-invented/gate", expires_in: "15m" },
          "validation_error: gated: ",
        ],
        [
          { question: "May I delete the branch?", kind: "approval", expires_in: "15m" },
          "validation_error: approval: ",
        ],
      ];
      for (const [args, refusal] of cases) {
        const refused = await call(port, "pane-token-pane-a", "ask_human", { ...args, ...plan });
        expect(refused.isError, refusal).toBe(true);
        expect(refused.content[0].text.startsWith(refusal), refused.content[0].text).toBe(true);
        expect(refused.content[0].text).toContain("ask again without planned_fallback");
      }
      expect(await store.listQuestions()).toEqual([]);

      // Asked again for a decision, each waits for one, and expiry authorises nothing.
      for (const [args] of cases) {
        const asked = await call(port, "pane-token-pane-a", "ask_human", args);
        expect(asked.isError, String(args.question)).toBeUndefined();
        expect(asked.structuredContent).toMatchObject({
          reply_mode: "blocking",
          enforced_requirement: "human-required",
          planned_fallback: null,
        });
        expect(asked.content[0].text).toContain(
          `It waits for a decision until ${asked.structuredContent.expires_at as string} (UTC)`
        );
      }
      const review = (await store.listQuestions()).find(
        (row) => row.attachment_digests.length > 0
      )!;
      const read = await call(port, "pane-token-pane-a", "get_decision", {
        question_id: review.question_id,
      });
      expect(read.structuredContent).toMatchObject({
        workflow_gate_id: DESIGN_REVIEW_FINAL_GATE_ID,
        reply_mode: "blocking",
      });
      expect(fetches).toBe(0);
    } finally {
      await attachments.close();
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("keeps Never for a question given no time, and refuses advice under it without a stated time (#17940)", async () => {
    await boot(false);
    add(pane("pane-a"));
    const port = await openRoute({ advisoryDeadlines: true, defaultQuestionExpiryMs: null });

    const plain = await call(port, "pane-token-pane-a", "ask_human", { question: "Which name?" });
    expect(plain.structuredContent).toMatchObject({
      reply_mode: "blocking",
      expires_at: null,
      requested_expires_at: null,
      planned_fallback: null,
    });
    const advice = await call(port, "pane-token-pane-a", "ask_human", {
      question: "Which fixture?",
      planned_fallback: "Use the in-memory fixture.",
    });
    expect(advice.isError).toBe(true);
    expect(advice.content[0].text.startsWith("validation_error: no-deadline: ")).toBe(true);
    expect(advice.content[0].text).toContain("give expires_in or expires_at");
    const rows = await store.listQuestions();
    expect(rows).toHaveLength(1);
    expect(rows[0].expires_at).toBeNull();
  });

  it("refuses advice on a Remote Host's policy, proxy answers allowed or not, and asks the question for a decision (#17942)", async () => {
    await boot(false);
    add(pane("pane-a"));
    for (const proxyAllowlisted of [false, true]) {
      const port = await openRoute({ advisoryDeadlines: true, role: "host", proxyAllowlisted });

      const refused = await call(port, "pane-token-pane-a", "ask_human", {
        question: "Which fixture?",
        expires_in: "15m",
        planned_fallback: "Use the in-memory fixture.",
        requested_requirement: "proxy-ok",
      });
      expect(refused.isError).toBe(true);
      expect(refused.content[0].text.startsWith("forbidden: policy-disallowed: ")).toBe(true);
      const asked = await call(port, "pane-token-pane-a", "ask_human", {
        question: "Which fixture?",
        expires_in: "15m",
        requested_requirement: "proxy-ok",
      });
      expect(asked.structuredContent).toMatchObject({
        reply_mode: "blocking",
        enforced_requirement: proxyAllowlisted ? "proxy-ok" : "human-required",
      });
      await questions!.close();
    }
    expect(await store.listQuestions()).toHaveLength(2);
  });

  it("commits a follow-up on the pane's own question at once, alone or in a batch, before any network I/O", async () => {
    await boot(false);
    add(pane("pane-a"));
    const port = await openRoute();
    const asked = await call(port, "pane-token-pane-a", "ask_human", { question: "Which name?" });
    const questionId = asked.structuredContent.question_id as string;
    const alias = (await store.getQuestion(questionId))!.alias;

    const posted = await call(port, "pane-token-pane-a", "send_followup", {
      question_id: questionId,
      text: "Should the old name stay as an alias?",
      expects_reply: true,
    });
    expect(posted.isError).toBeUndefined();
    expect(posted.content[0].text).toBe(followupInstruction(alias, true));
    expect(posted.structuredContent).toEqual({
      question_id: questionId,
      message_id: expect.any(String),
      status: "queued",
      expects_reply: true,
      instruction: posted.content[0].text,
    });

    const batch = await request(port, DECISIONS_MCP_PATH, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer pane-token-pane-a" },
      body: JSON.stringify([
        {
          jsonrpc: "2.0",
          id: "f",
          method: "tools/call",
          params: {
            name: "send_followup",
            arguments: { question_id: questionId, text: "No reply needed.", expects_reply: false },
          },
        },
        {
          jsonrpc: "2.0",
          id: "g",
          method: "tools/call",
          params: { name: "get_decision", arguments: { question_id: questionId } },
        },
        { jsonrpc: "2.0", id: "h", method: "tools/list", params: {} },
      ]),
    });
    const [note, read, listed] = JSON.parse(batch.body) as Array<{
      id: string;
      result: Record<string, unknown> & {
        content?: Array<{ text: string }>;
        structuredContent?: Record<string, unknown>;
        tools?: Array<{ name: string }>;
      };
    }>;
    expect(note).toMatchObject({
      id: "f",
      result: { structuredContent: { status: "queued", expects_reply: false } },
    });
    expect(note!.result.content![0]!.text).toBe(followupInstruction(alias, false));
    expect(note!.result.structuredContent!.instruction).toBe(note!.result.content![0]!.text);
    // A follow-up never answers or moves the question, and a batch is served as the library answers it.
    expect(read).toMatchObject({
      id: "g",
      result: { structuredContent: { status: "queued", provenance: null, choice: null } },
    });
    expect(read!.result.structuredContent).toHaveProperty("thread");
    expect(listed!.id).toBe("h");
    expect(listed!.result.tools).toEqual(TOOLS);

    expect((await store.outboxFor(questionId)).map((item) => item.kind)).toEqual([
      "create",
      "message",
      "message",
    ]);
    const row = (await store.getQuestion(questionId))!;
    expect(row).toMatchObject({ local_status: "queued", messages_json: "[]" });
    expect(fetches).toBe(0);
  });

  it("commits the question with its full origin from the bearer and the pane, before any network I/O", async () => {
    await boot(false);
    add(pane("pane-a"));
    const port = await openRoute();

    const result = await call(port, "pane-token-pane-a", "ask_human", {
      question: "Ship the redesign now or after the review?",
    });
    const alias = (await store.listQuestions())[0].alias;
    expect(result.isError).toBeUndefined();
    // The guidance after the alias is the library's own wording, pinned in its tests.
    expect(result.content[0].text.startsWith(`Asked as q-${alias}. `)).toBe(true);
    expect(result.structuredContent).toMatchObject({
      status: "queued",
      enforced_requirement: "human-required",
    });

    const [row] = await store.listQuestions();
    expect(row.question_id).toBe(result.structuredContent.question_id);
    expect(row.origin).toEqual({
      host_id: HOST_ID,
      pane_id: "pane-a",
      terminal_generation: 3,
      ownership_principal: "principal-pane-a",
      agent_incarnation: "0",
      agent_kind: "claude",
      agent_session_id: "session-1",
      project_id: "project-1",
      worktree_id: "wt-main",
      worktree_root: "/work/repo",
      workflow_gate_id: null,
    });
    expect(row.local_status).toBe("queued");
    expect((await store.outboxFor(row.question_id)).map((item) => item.kind)).toEqual(["create"]);
    expect(fetches).toBe(0);
  });

  it("attaches images from the pane's own launch directory, and tells the agent what was wrong with the rest", async () => {
    const root = await fs.mkdtemp(`${testHomeDir}/attach-`);
    try {
      const worktree = `${root}/worktree`;
      await fs.mkdir(`${worktree}/shots`, { recursive: true });
      const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
      await fs.writeFile(`${worktree}/shots/after.png`, png);
      await fs.writeFile(`${root}/outside.png`, Buffer.concat([png, Buffer.from("SECRET")]));
      await fs.symlink(`${root}/outside.png`, `${worktree}/shots/linked.png`);
      await fs.writeFile(`${worktree}/fake.png`, "SECRET plain text");
      const attachments = new DecisionsAttachments({
        dir: `${root}/spool`,
        referenced: async () =>
          new Set(
            (await store.dueOutbox(Number.MAX_SAFE_INTEGER, 1000)).flatMap((item) =>
              item.kind === "create"
                ? (item.payload as { attachments: { attachment_id: string }[] }).attachments.map(
                    (a) => a.attachment_id
                  )
                : []
            )
          ),
      });
      await boot(false);
      add(pane("pane-a", { cwd: worktree }));
      const port = await openRoute({ attachments });
      const ask = (ids: string[]) =>
        call(port, "pane-token-pane-a", "ask_human", {
          question: "Does the redesign look right?",
          attachments: ids.map((id) => ({ local_resource_id: id, role: "after" })),
        });

      const asked = await ask(["shots/after.png"]);
      expect(asked.isError).toBeUndefined();
      const [row] = await store.listQuestions();
      expect(row.attachment_digests).toHaveLength(1);
      expect(await fs.readdir(`${root}/spool`)).toHaveLength(1);

      for (const [id, problem] of [
        ["../outside.png", "is outside this terminal's worktree"],
        ["shots/linked.png", "is outside this terminal's worktree"],
        ["fake.png", "isn't a PNG, JPEG or WebP image"],
        [`${worktree}/shots/after.png`, "must be a path relative to this terminal's worktree"],
      ] as const) {
        const refused = await ask(["shots/after.png", id]);
        expect(refused.isError).toBe(true);
        const text = refused.content[0].text;
        expect(
          text.startsWith(`attachment_error: attachment ${JSON.stringify(id)} ${problem}`)
        ).toBe(true);
        expect(refused.content[0].text).not.toContain("SECRET");
      }
      const nine = await ask(Array.from({ length: 9 }, () => "shots/after.png"));
      expect(nine.isError).toBe(true);
      expect(nine.content[0].text).toMatch(/^validation_error: attachments/);

      // Only the question that was asked holds anything in the spool.
      expect(await store.listQuestions()).toHaveLength(1);
      expect(await fs.readdir(`${root}/spool`)).toHaveLength(1);
      await attachments.close();
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("refuses missing, API-key, help, foreign and revoked tokens, with the MCP server on as well", async () => {
    await boot(true);
    add(pane("pane-a"));
    const port = await openRoute();

    // The control surface takes the API key and the help token...
    for (const token of [API_KEY, HELP_TOKEN]) {
      const controlSurface = await request(port, "/mcp", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2025-06-18",
            capabilities: {},
            clientInfo: { name: "raw", version: "1.0.0" },
          },
        }),
      });
      expect(controlSurface.status, token).toBe(200);
    }

    // ...and Decisions takes neither.
    for (const token of [null, API_KEY, HELP_TOKEN, "someone-elses-token", "pane-token-pane-b"]) {
      const answer = await rpc(port, token, "tools/list");
      expect(answer.status, String(token)).toBe(401);
    }
    expect((await rpc(port, "pane-token-pane-a", "tools/list")).status).toBe(200);

    // A revoked bearer is refused on its next request: nothing keeps a session for it.
    const askedBefore = await call(port, "pane-token-pane-a", "ask_human", {
      question: "Keep it?",
    });
    // Revoked as `revokePaneConfig` does it: the terminal is still there.
    revoked.add("pane-token-pane-a");
    expect((await rpc(port, "pane-token-pane-a", "tools/list")).status).toBe(401);
    // Its question stays, bound to the run that asked.
    const kept = await store.getQuestion(askedBefore.structuredContent.question_id as string);
    expect(kept?.origin.ownership_principal).toBe("principal-pane-a");
    expect(kept?.local_status).toBe("queued");
  });

  it("refuses a rebinding Host, any Origin and repeated security headers", async () => {
    await boot(false);
    add(pane("pane-a"));
    const port = await openRoute();
    const token = "pane-token-pane-a";

    expect(
      (await rpc(port, token, "tools/list", {}, { Host: `evil.example:${port}` })).status
    ).toBe(403);
    expect(
      (await rpc(port, token, "tools/list", {}, { Host: `127.0.0.1:${port + 1}` })).status
    ).toBe(403);
    expect(
      (await rpc(port, token, "tools/list", {}, { Origin: "https://evil.example" })).status
    ).toBe(403);
    // The listener lets a same-origin page through; Decisions takes no browser at all.
    for (const origin of [`http://127.0.0.1:${port}`, `http://localhost:${port}`, "null"]) {
      const answer = await rpc(port, token, "tools/list", {}, { Origin: origin });
      expect(answer.status, origin).toBe(403);
    }
    const repeated = await new Promise<number>((resolve, reject) => {
      const req = http.request(
        { host: "127.0.0.1", port, path: DECISIONS_MCP_PATH, method: "POST", agent: false },
        (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        }
      );
      req.on("error", reject);
      req.setHeader("Authorization", [`Bearer ${token}`, "Bearer other"]);
      req.end("{}");
    });
    expect(repeated).toBe(400);
    expect((await rpc(port, token, "tools/list", {}, { Host: `localhost:${port}` })).status).toBe(
      200
    );
  });

  it("keeps a question human-required whatever the agent asks for, and takes no origin from it", async () => {
    await boot(false);
    add(pane("pane-a"));
    const port = await openRoute();
    const token = "pane-token-pane-a";

    for (const requested of ["proxy-ok", "proxy-first", "human-required"]) {
      const result = await call(port, token, "ask_human", {
        question: `Downgrade to ${requested}?`,
        requested_requirement: requested,
      });
      expect(result.structuredContent.enforced_requirement, requested).toBe("human-required");
    }
    // A gate the agent names that Daintree never registered is no policy at all.
    const invented = await call(port, token, "ask_human", {
      question: "Approve it?",
      workflow_gate_id: "agent-invented/gate",
      requested_requirement: "proxy-ok",
    });
    expect(invented.structuredContent.enforced_requirement).toBe("human-required");
    // A trusted gate applies between attempts too: the final design review binds to its images.
    const unbound = await call(port, token, "ask_human", {
      question: "Approve the final design?",
      workflow_gate_id: DESIGN_REVIEW_FINAL_GATE_ID,
      options: [
        { id: "approve", label: "Approve" },
        { id: "reject", label: "Reject" },
      ],
    });
    expect(unbound.isError).toBe(true);
    // Origin fields among the arguments are dropped, never recorded.
    const forged = await call(port, token, "ask_human", {
      question: "Whose pane is this?",
      pane_id: "pane-b",
      origin: { pane_id: "pane-b", host_id: "elsewhere", ownership_principal: "principal-pane-b" },
    });
    expect(forged.isError).toBeUndefined();

    const rows = await store.listQuestions();
    expect(rows).toHaveLength(5);
    for (const row of rows) {
      expect(row.requirement).toBe("human-required");
      expect(row.origin.pane_id).toBe("pane-a");
      expect(row.origin.host_id).toBe(HOST_ID);
      expect(row.origin.ownership_principal).toBe("principal-pane-a");
      expect(row.origin.workflow_gate_id).toBeNull();
    }
  });

  it("shows and cancels a question only for the pane that asked it", async () => {
    await boot(false);
    add(pane("pane-a"), pane("pane-b"));
    const port = await openRoute();

    const asked = await call(port, "pane-token-pane-a", "ask_human", { question: "Which name?" });
    const questionId = asked.structuredContent.question_id as string;

    const own = await call(port, "pane-token-pane-a", "get_decision", { question_id: questionId });
    expect(own.isError).toBeUndefined();
    expect(own.structuredContent).toMatchObject({ question_id: questionId, status: "queued" });

    // Another pane's id reads as an unknown one, and its cancel changes nothing.
    const other = await call(port, "pane-token-pane-b", "get_decision", {
      question_id: questionId,
    });
    const unknown = await call(port, "pane-token-pane-b", "get_decision", {
      question_id: "q_doesnotexist",
    });
    expect(other.structuredContent).toEqual({ error: "not_found" });
    expect(other.structuredContent).toEqual(unknown.structuredContent);
    const refused = await call(port, "pane-token-pane-b", "cancel_question", {
      question_id: questionId,
    });
    expect(refused.structuredContent).toEqual({ error: "not_found" });
    // A follow-up is the asking pane's alone, whatever its arguments name.
    const followUp = await call(port, "pane-token-pane-b", "send_followup", {
      question_id: questionId,
      text: "Pick A.",
      expects_reply: false,
      pane_id: "pane-a",
      origin: { pane_id: "pane-a", ownership_principal: "principal-pane-a" },
    });
    const unknownFollowUp = await call(port, "pane-token-pane-b", "send_followup", {
      question_id: "q_doesnotexist",
      text: "Pick A.",
      expects_reply: false,
    });
    expect(followUp.isError).toBe(true);
    expect(followUp.structuredContent).toEqual({ error: "not_found" });
    expect(followUp.content).toEqual(unknownFollowUp.content);
    expect((await store.getQuestion(questionId))?.local_status).toBe("queued");
    expect((await store.outboxFor(questionId)).map((item) => item.kind)).toEqual(["create"]);

    // Its own pane cancels it; never published, it is dropped before it is sent.
    const cancelled = await call(port, "pane-token-pane-a", "cancel_question", {
      question_id: questionId,
    });
    expect(cancelled.isError).toBeUndefined();
    expect((await store.getQuestion(questionId))?.local_status).toBe("cancelled");
    expect(await store.outboxFor(questionId)).toEqual([]);
    // A withdrawn question's thread takes nothing more, from its own pane either.
    const closed = await call(port, "pane-token-pane-a", "send_followup", {
      question_id: questionId,
      text: "Never mind.",
      expects_reply: false,
    });
    expect(closed).toMatchObject({ isError: true, structuredContent: { error: "invalid_state" } });
    expect(await store.outboxFor(questionId)).toEqual([]);
  });

  it.each([
    [
      "a new bearer and principal",
      { token: "pane-token-pane-a-2", principal: "principal-pane-a-2" },
    ],
    ["a new launch generation", { generation: 4 }],
  ] as const)("keeps a question from the same pane relaunched with %s", async (_label, change) => {
    await boot(false);
    add(pane("pane-a"));
    const port = await openRoute();
    const asked = await call(port, "pane-token-pane-a", "ask_human", { question: "Mine?" });
    const questionId = asked.structuredContent.question_id as string;

    const before = pane("pane-a");
    const generation = "generation" in change ? change.generation : before.generation;
    const token = "token" in change ? change.token : before.token;
    panes.set("pane-a", {
      token,
      bearer: {
        ...before.bearer,
        ...("principal" in change ? { principal: change.principal } : {}),
      },
      generation,
      info: { ...before.info, launchGeneration: generation },
    });

    const read = await call(port, token, "get_decision", { question_id: questionId });
    expect(read.structuredContent).toEqual({ error: "not_found" });
    const cancel = await call(port, token, "cancel_question", { question_id: questionId });
    expect(cancel.structuredContent).toEqual({ error: "not_found" });
    const followUp = await call(port, token, "send_followup", {
      question_id: questionId,
      text: "Still mine?",
      expects_reply: false,
    });
    expect(followUp.structuredContent).toEqual({ error: "not_found" });
    expect((await store.getQuestion(questionId))?.local_status).toBe("queued");
    expect((await store.outboxFor(questionId)).map((item) => item.kind)).toEqual(["create"]);
  });

  it("still shows a question to its run once the run's agent session is learned", async () => {
    await boot(false);
    add(pane("pane-a", { agentSessionId: undefined }));
    const port = await openRoute();
    const asked = await call(port, "pane-token-pane-a", "ask_human", { question: "Learned?" });
    const questionId = asked.structuredContent.question_id as string;
    expect((await store.getQuestion(questionId))?.origin.agent_session_id).toBeNull();

    panes.get("pane-a")!.info.agentSessionId = "session-learned";
    const read = await call(port, "pane-token-pane-a", "get_decision", { question_id: questionId });
    expect(read.isError).toBeUndefined();
    expect(read.structuredContent).toMatchObject({ question_id: questionId });
  });

  it("holds a pane to 10 open questions even when it asks them all at once, and the next pane to its own", async () => {
    await boot(false);
    add(pane("pane-a"), pane("pane-b"));
    const port = await openRoute();

    const results = await Promise.all(
      Array.from({ length: 12 }, (_, n) =>
        call(port, "pane-token-pane-a", "ask_human", { question: `Question ${n}?` })
      )
    );
    const refused = results.filter((result) => result.isError === true);
    expect(results.length - refused.length).toBe(10);
    expect(refused.map((result) => result.structuredContent.error)).toEqual([
      "too_many_open_questions",
      "too_many_open_questions",
    ]);
    expect(await store.countOpenForPane(HOST_ID, "pane-a")).toBe(10);

    const b = await call(port, "pane-token-pane-b", "ask_human", { question: "Mine?" });
    expect(b.isError).toBeUndefined();
  });

  it("limits each pane's request rate on its own", async () => {
    await boot(false);
    add(pane("pane-a"), pane("pane-b"));
    const port = await openRoute();

    const statuses: number[] = [];
    for (let n = 0; n < 61; n++) {
      statuses.push((await rpc(port, "pane-token-pane-a", "ping")).status);
    }
    expect(statuses.slice(0, 60).every((status) => status === 200)).toBe(true);
    expect(statuses[60]).toBe(429);
    expect((await rpc(port, "pane-token-pane-b", "ping")).status).toBe(200);
  });

  it("is not there with Decisions off, whatever the credential, and nothing listens with MCP off too", async () => {
    await boot(true);
    add(pane("pane-a"));
    const port = service.currentPort!;
    const advice = {
      name: "ask_human",
      arguments: {
        question: "Which fixture?",
        expires_in: "15m",
        planned_fallback: "Use the in-memory fixture.",
      },
    };
    for (const token of [null, API_KEY, HELP_TOKEN, "pane-token-pane-a"]) {
      expect((await rpc(port, token, "tools/list")).status, String(token)).toBe(404);
      expect((await rpc(port, token, "tools/call", advice)).status, String(token)).toBe(404);
      expect(
        (
          await request(port, `${DECISIONS_MCP_PATH}/anything`, {
            method: "POST",
            headers: token === null ? {} : { Authorization: `Bearer ${token}` },
          })
        ).status
      ).toBe(404);
    }
    expect(service.getAuditStats(false).auth401Count).toBe(0);

    // Turned on and off again: the route goes with it.
    const held = await openRoute();
    expect((await rpc(held, "pane-token-pane-a", "tools/list")).status).toBe(200);
    await questions!.close();
    expect((await rpc(held, "pane-token-pane-a", "tools/list")).status).toBe(404);
    expect((await rpc(held, "pane-token-pane-a", "tools/call", advice)).status).toBe(404);

    await service.stop();
    service = new McpServerService();
    await boot(false);
    await expect(rpc(held, "pane-token-pane-a", "tools/list")).rejects.toThrow();
  });
});

describe("DecisionsMcpRoute", () => {
  const bridge = {} as DecisionsBridge;
  const authenticator = { authenticate: () => null };

  function answerOf(route: ListenerRoute): Promise<number> {
    let status = 0;
    const res = {
      writeHead: (code: number) => {
        status = code;
        return res;
      },
      end: () => res,
    };
    return route
      .handle({} as never, res as never, new URL("http://127.0.0.1/mcp/decisions"), 1)
      .then(() => status);
  }

  it("refuses at once when closed while its hold is being taken, and lets that hold go once it comes", async () => {
    let route: ListenerRoute | null = null;
    let grant!: (hold: DecisionsListenerHold) => void;
    const release = vi.fn(async () => {});
    const decisions = new DecisionsMcpRoute(bridge, authenticator, (_id, held) => {
      route = held;
      return new Promise((resolve) => {
        grant = resolve;
      });
    });

    const opened = decisions.open();
    await vi.waitFor(() => expect(route).not.toBeNull());
    const closing = decisions.close();
    expect(await answerOf(route!)).toBe(404);
    grant({ port: 4100, release });
    await opened;
    await closing;
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("takes its hold only once the route it replaces has let go, and none when closed before then", async () => {
    let letGo!: () => void;
    const previous = new Promise<void>((resolve) => {
      letGo = resolve;
    });
    const holdListener = vi.fn(async () => ({ port: 4100, release: vi.fn(async () => {}) }));
    const next = new DecisionsMcpRoute(bridge, authenticator, holdListener);
    const opened = next.open(previous);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(holdListener).not.toHaveBeenCalled();
    letGo();
    await opened;
    expect(holdListener).toHaveBeenCalledTimes(1);

    let letGoAgain!: () => void;
    const again = new Promise<void>((resolve) => {
      letGoAgain = resolve;
    });
    const unused = vi.fn(async () => ({ port: 4100, release: vi.fn(async () => {}) }));
    const closedFirst = new DecisionsMcpRoute(bridge, authenticator, unused);
    const openedLate = closedFirst.open(again);
    const closing = closedFirst.close();
    letGoAgain();
    await openedLate;
    await closing;
    expect(unused).not.toHaveBeenCalled();
  });

  it("reports where launches reach it: the hold's port, none once closed or when the hold failed", async () => {
    let port: number | null = 4100;
    const route = new DecisionsMcpRoute(bridge, authenticator, async () => ({
      get port() {
        return port;
      },
      release: vi.fn(async () => {}),
    }));
    expect(await new DecisionsMcpRoute(bridge, authenticator, vi.fn()).listenerPort()).toBeNull();
    void route.open();
    await expect(route.listenerPort()).resolves.toBe(4100);
    // The listener moved: the hold's live port, not the one first seen.
    port = 4101;
    await expect(route.listenerPort()).resolves.toBe(4101);
    await route.close();
    await expect(route.listenerPort()).resolves.toBeNull();

    const refused = new DecisionsMcpRoute(bridge, authenticator, async () => {
      throw new Error("no listener");
    });
    await refused.open().catch(() => {});
    await expect(refused.listenerPort()).resolves.toBeNull();

    // Closed while the hold was still being taken: no port, though the hold had one.
    let grant!: (hold: DecisionsListenerHold) => void;
    const racing = new DecisionsMcpRoute(
      bridge,
      authenticator,
      () =>
        new Promise((resolve) => {
          grant = resolve;
        })
    );
    void racing.open();
    const asked = racing.listenerPort();
    await vi.waitFor(() => expect(grant).toBeDefined());
    const closing = racing.close();
    grant({ port: 4100, release: vi.fn(async () => {}) });
    await expect(asked).resolves.toBeNull();
    await closing;
  });
});
