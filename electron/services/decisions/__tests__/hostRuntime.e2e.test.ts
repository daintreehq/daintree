// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import {
  MemoryKeyStore,
  MemoryPendingHostStore,
  acceptHostEnrollment,
  createHostRequest,
  enrollHost,
  type WebSocketLike,
} from "@daintreehq/decisions-client";
import {
  buildSignedAction,
  buildSignedMessage,
  decryptEnvelope,
  encryptEnvelope,
  exportPublicKey,
  generateDeviceKeys,
  issueDeviceCert,
  newId,
  type DeviceKeys,
} from "@daintreehq/decisions-crypto";
import { EventData, MESSAGE_RECORD_TYPE, type DeviceCert } from "@daintreehq/decisions-protocol";

vi.mock("electron", () => ({
  app: {
    getPath: () => "/fake/userData",
    isPackaged: false,
    getAppPath: () => "/fake/appPath",
  },
  net: { isOnline: () => true },
  powerMonitor: { on: vi.fn(), off: vi.fn() },
  safeStorage: {},
}));

import {
  TerminalNotifyService,
  type NotifyStateChange,
  type NotifyTerminalInfo,
  type TerminalNotifyPtyClient,
} from "../../mcp-server/terminalNotify.js";
import type { ListenerRoute } from "../../mcp-server/listenerHold.js";
import { openDb } from "../../persistence/db.js";
import { DecisionsService } from "../DecisionsService.js";
import { DaintreeLocalStore } from "../daintreeLocalStore.js";
import type { DecisionSinkPtyClient } from "../daintreeTerminalSink.js";
import { hostLifetimeSettings } from "../hostRecord.js";
import { DECISIONS_MCP_PATH, openDecisionsMcpRoute } from "../mcpRoute.js";
import type { PaneTerminalInfo, PaneTerminalReader } from "../paneAccess.js";
import { RelayConnection } from "../relayConnection.js";
import { makeOwner } from "../../../remote/decisions/__tests__/ownerFixture.js";

/**
 * The whole loop on an enrolled Remote Host (#16022), with its owner's
 * computer gone: the owner enrolls the Host, then nothing of it runs. An
 * agent on the Host asks through `/mcp/decisions`, the question goes to the
 * relay signed by the Host's own device, a phone answers, and the answer is
 * typed into the Host's terminal that asked: with the socket up, and after
 * the Host was away while the phone answered. Only the relay and the PTY are
 * fakes; the service, connection, route, delivery and crypto are real.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const migrationsFolder = path.resolve(__dirname, "../../persistence/migrations");

type Frame = Record<string, unknown>;

interface LedgerEvent {
  protocol_version: 1;
  seq: number;
  event_id: string;
  event_type: string;
  occurred_at: string;
  question_id: string | null;
  question_revision: number | null;
  origin_device_id: string | null;
  data: Record<string, unknown>;
}

interface FakeDevice {
  device_id: string;
  role: string;
  label: string;
  cert: DeviceCert;
  created_at: string;
  last_seen_at: string | null;
  revoked_at: string | null;
  push_enabled: boolean;
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** The relay's end of one socket: hello, replay from the cursor it is asked for, then live events. */
class FakeSocket implements WebSocketLike {
  readyState = 0;
  onopen: WebSocketLike["onopen"] = null;
  onmessage: WebSocketLike["onmessage"] = null;
  onclose: WebSocketLike["onclose"] = null;
  onerror: WebSocketLike["onerror"] = null;
  live = false;

  constructor(
    readonly url: string,
    private readonly relay: FakeRelay
  ) {
    // The relay accepts as soon as the socket is made, as its Durable Object does.
    queueMicrotask(() => this.accept());
  }

  send(data: string): void {
    if (this.readyState !== 1 || data === "ping") return;
    const frame = JSON.parse(data) as Frame;
    if (frame.t === "sync") {
      const after = Number(frame.after);
      for (const event of this.relay.events.filter((e) => e.seq > after)) this.push(event);
      this.frame({ t: "caught_up", high_water: this.relay.highWater(), has_more: false });
      this.live = true;
    }
  }

  close(): void {
    this.readyState = 3;
    this.live = false;
  }

  push(event: LedgerEvent): void {
    this.frame({ t: "event", event });
  }

  /** The relay drops the socket, as a network outage would. */
  drop(): void {
    this.readyState = 3;
    this.live = false;
    this.onclose?.({ code: 1006, reason: "gone" });
  }

  private accept(): void {
    if (this.readyState !== 0) return;
    this.readyState = 1;
    this.onopen?.({});
    this.frame({
      t: "hello",
      protocol_version: 1,
      device_id: this.relay.hostDeviceId,
      role: "desktop-host",
      key_epoch: 1,
      high_water: this.relay.highWater(),
      server_time: new Date().toISOString(),
    });
  }

  private frame(frame: Frame): void {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }
}

/** A relay holding a ledger and the owner's device list, and the requests it was sent. */
class FakeRelay {
  readonly events: LedgerEvent[] = [];
  readonly sockets: FakeSocket[] = [];
  /** Questions as their creator signed them, by id. */
  readonly questions = new Map<string, { target_host_id: string; signer_device_id: string }>();
  /** The device each signed request came from, and where it went. */
  readonly requests: Array<{ path: string; deviceId: string | null; body: unknown }> = [];
  /** Thread messages as their sender signed them, in the order the relay took them. */
  readonly messages: Array<{
    questionId: string;
    deviceId: string | null;
    record: Record<string, unknown>;
    envelope: Record<string, unknown>;
  }> = [];
  /** While true, the socket isn't reachable: tickets fail and nothing connects. */
  down = false;
  hostDeviceId = "";

  constructor(readonly devices: FakeDevice[]) {}

  highWater(): number {
    return this.events.at(-1)?.seq ?? 0;
  }

  /** Appends to the ledger, and sends it to a live socket at once. */
  append(event: Omit<LedgerEvent, "seq" | "protocol_version" | "event_id" | "occurred_at">) {
    const full: LedgerEvent = {
      protocol_version: 1,
      seq: this.highWater() + 1,
      event_id: `evt_${newId()}`,
      occurred_at: new Date().toISOString(),
      ...event,
    };
    this.events.push(full);
    for (const socket of this.sockets) if (socket.live) socket.push(full);
    return full;
  }

  liveSocket(): FakeSocket | null {
    return this.sockets.find((socket) => socket.live) ?? null;
  }

  readonly fetch = async (url: string, init: RequestInit): Promise<Response> => {
    const { pathname } = new URL(url);
    const method = init.method ?? "GET";
    const body = typeof init.body === "string" ? (JSON.parse(init.body) as unknown) : null;
    const auth = new Headers(init.headers).get("authorization");
    this.requests.push({
      path: pathname,
      deviceId: /(?:^|[ ,])d=([^,]+)/.exec(auth ?? "")?.[1] ?? null,
      body,
    });
    if (this.down) throw new TypeError("fetch failed");
    // A 0.4.0 relay advertises threads; nothing is sent to a desktop that doesn't declare them.
    if (method === "GET" && pathname === "/api/v1/info") {
      return json(200, { features: ["thread-messages-v1"] });
    }
    const thread = /^\/api\/v1\/questions\/([^/]+)\/messages$/.exec(pathname);
    if (method === "POST" && thread !== null) {
      const { message } = body as {
        message: { record: Record<string, unknown>; envelope: Record<string, unknown> };
      };
      this.messages.push({
        questionId: thread[1]!,
        deviceId: this.requests.at(-1)!.deviceId,
        record: message.record,
        envelope: message.envelope,
      });
      return json(201, {
        question_id: thread[1],
        message_id: message.record.message_id,
        message_seq: this.messages.filter((m) => m.questionId === thread[1]).length,
        event_seq: this.highWater(),
      });
    }
    if (method === "POST" && pathname === "/api/v1/socket-ticket") {
      return json(200, {
        ticket: `ticket-${this.requests.length}`,
        expires_at: new Date(Date.now() + 30_000).toISOString(),
        ws_path: "/api/v1/socket",
      });
    }
    if (method === "GET" && pathname === "/api/v1/devices") {
      return json(200, {
        key_epoch: 1,
        owner_device_id: this.devices[0]!.device_id,
        devices: this.devices.map((device) => ({ ...device, last_ack_seq: 0 })),
      });
    }
    if (method === "POST" && pathname === "/api/v1/questions") {
      const { question } = body as {
        question: { record: Record<string, unknown>; envelope: unknown };
      };
      const questionId = String(question.record.question_id);
      this.questions.set(questionId, {
        target_host_id: String(question.record.target_host_id),
        signer_device_id: String(question.record.signer_device_id),
      });
      const event = this.append({
        event_type: "decision.created",
        question_id: questionId,
        question_revision: 0,
        origin_device_id: String(question.record.signer_device_id),
        data: {
          record: question.record,
          envelope: question.envelope,
          requirement: question.record.requirement,
          target_host_id: question.record.target_host_id,
          expires_at: question.record.expires_at,
        },
      });
      return json(201, {
        question_id: questionId,
        revision: 0,
        status: "open",
        event_seq: event.seq,
      });
    }
    if (method === "POST" && pathname.startsWith("/api/v1/deliveries/")) {
      return json(200, { ok: true });
    }
    return json(404, { code: "not_found", message: "no route" });
  };

  readonly webSocket = (url: string): WebSocketLike => {
    if (this.down) throw new Error("unreachable");
    const socket = new FakeSocket(url, this);
    this.sockets.push(socket);
    return socket;
  };
}

/** A phone the owner paired: its keys, and the owner's certificate for it. */
interface Phone {
  deviceId: string;
  keys: DeviceKeys;
  cert: DeviceCert;
}

/** The phone answers `questionId` with `option`, signed and sealed as the phone app does. */
async function phoneAnswers(
  relay: FakeRelay,
  owner: Awaited<ReturnType<typeof makeOwner>>,
  phone: Phone,
  questionId: string,
  option: string
): Promise<void> {
  const envelope = await encryptEnvelope({
    epochKey: owner.identity.epochs.get(1)!,
    installationId: owner.installationId,
    questionId,
    recordId: newId(),
    recordType: "answer",
    revision: 1,
    senderDeviceId: phone.deviceId,
    purpose: "answer-content",
    plaintext: {
      content_version: 1,
      selected_option_ids: [option],
      text: `Go with ${option}.`,
      reviewed_attachment_digests: [],
    },
  });
  const signed = await buildSignedAction({
    installationId: owner.installationId,
    questionId,
    action: "answer",
    signerDeviceId: phone.deviceId,
    signingKey: phone.keys.signing.privateKey,
    expectedRevision: 0,
    envelope,
  });
  relay.append({
    event_type: "decision.answer.committed",
    question_id: questionId,
    question_revision: 1,
    origin_device_id: phone.deviceId,
    data: EventData.action.parse({
      action: "answer",
      record: signed.record,
      envelope: signed.envelope,
      provenance: "human",
      status: "human-answered",
      revision: 1,
      target_host_id: relay.questions.get(questionId)!.target_host_id,
      deliverable: true,
    }) as Record<string, unknown>,
  });
}

/** The phone sends a follow-up on `questionId`, signed and sealed as the 0.4.0 phone app does. */
async function phoneFollowsUp(
  relay: FakeRelay,
  owner: Awaited<ReturnType<typeof makeOwner>>,
  phone: Phone,
  questionId: string,
  text: string
): Promise<LedgerEvent> {
  const messageId = newId();
  const envelope = await encryptEnvelope({
    epochKey: owner.identity.epochs.get(1)!,
    installationId: owner.installationId,
    questionId,
    recordId: messageId,
    recordType: MESSAGE_RECORD_TYPE,
    revision: 0,
    senderDeviceId: phone.deviceId,
    purpose: "message-content",
    plaintext: { content_version: 1, side: "human", text, images: [] },
  });
  const signed = await buildSignedMessage({
    installationId: owner.installationId,
    questionId,
    messageId,
    side: "human",
    signerDeviceId: phone.deviceId,
    signingKey: phone.keys.signing.privateKey,
    envelope,
  });
  return relay.append({
    event_type: "decision.message.posted",
    question_id: questionId,
    question_revision: null,
    origin_device_id: phone.deviceId,
    data: EventData.messagePosted.parse({
      message_seq: 1,
      committed_at: new Date().toISOString(),
      record: signed.record,
      envelope: signed.envelope,
      target_host_id: relay.questions.get(questionId)!.target_host_id,
    }) as Record<string, unknown>,
  });
}

/** The Host's terminals: two agent panes at their prompts, and every line typed into them. */
class HostTerminals implements TerminalNotifyPtyClient, DecisionSinkPtyClient, PaneTerminalReader {
  readonly terminals = new Map<string, NotifyTerminalInfo & PaneTerminalInfo>();
  readonly submitted: Array<{ id: string; text: string; token?: string }> = [];
  private readonly phases = new Map<string, "pty_written">();

  add(id: string): void {
    this.terminals.set(id, {
      projectId: "project-1",
      worktreeId: "wt-1",
      cwd: "/repo/wt-1",
      launchAgentId: "claude",
      detectedAgentId: "claude",
      agentIncarnation: 0,
      agentSessionId: `session-${id}`,
      launchGeneration: 3,
      hasPty: true,
      agentState: "waiting",
      waitingReason: "prompt",
      lastStateChange: Date.now() - 60_000,
    } as NotifyTerminalInfo & PaneTerminalInfo);
  }

  async getTerminalAsync(id: string, submissionToken?: string) {
    const info = this.terminals.get(id);
    if (info === undefined) return null;
    const given =
      submissionToken !== undefined &&
      this.submitted.some((line) => line.id === id && line.token === submissionToken);
    return given
      ? { ...info, submission: { token: submissionToken, phase: "pty_written" as const, at: 0 } }
      : { ...info };
  }

  submit(id: string, text: string, token?: string) {
    this.submitted.push({ id, text, token });
    if (token !== undefined) this.phases.set(token, "pty_written");
  }

  withdrawGuardedSubmission() {}

  async getSerializedStateAsync() {
    return null;
  }

  getLiveGeneration(id: string) {
    return this.terminals.has(id) ? 3 : null;
  }

  isLiveGeneration(id: string, generation: number) {
    return this.terminals.has(id) && generation === 3;
  }

  on() {}
  off() {}
}

/** The loopback listener `/mcp/decisions` is held on, as McpServerService.holdListener gives it. */
async function loopbackListener() {
  let route: ListenerRoute | null = null;
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);
    if (route && url.pathname === route.path) {
      void route.handle(req, res, url, port);
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  return {
    port,
    hold: async (_id: string, held: ListenerRoute) => {
      route = held;
      return {
        port,
        release: async () => {
          route = null;
        },
      };
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

let nextRpc = 1;

/** An agent's tool call, through the Host's `/mcp/decisions` with its pane's bearer. */
async function callTool(
  port: number,
  token: string,
  name: string,
  args: Record<string, unknown>
): Promise<{ isError?: boolean; structuredContent: Record<string, unknown> }> {
  const body = JSON.stringify({
    jsonrpc: "2.0",
    id: nextRpc++,
    method: "tools/call",
    params: { name, arguments: args },
  });
  const answer = await new Promise<{ status: number; body: string }>((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        path: DECISIONS_MCP_PATH,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
          Connection: "close",
        },
        agent: false,
      },
      (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => (text += chunk));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: text }));
      }
    );
    req.setTimeout(10_000, () => req.destroy(new Error("/mcp/decisions didn't answer")));
    req.on("error", reject);
    req.end(body);
  });
  expect(answer.status).toBe(200);
  return (
    JSON.parse(answer.body) as {
      result: { isError?: boolean; structuredContent: Record<string, unknown> };
    }
  ).result;
}

/** An agent's `ask_human`, through the Host's `/mcp/decisions` with its pane's bearer. */
async function askHuman(port: number, token: string, question: string): Promise<string> {
  const result = await callTool(port, token, "ask_human", {
    question,
    kind: "choice",
    options: [
      { id: "a", label: "Option A" },
      { id: "b", label: "Option B" },
    ],
  });
  return result.structuredContent.question_id as string;
}

function typedChoices(text: string): string[] {
  return [...text.matchAll(/^choice: (.+)$/gm)].map((match) => match[1]!);
}

let dir: string;
let sqlite: Database.Database;
const cleanups: Array<() => Promise<void> | void> = [];

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "daintree-decisions-host-e2e-"));
  sqlite = openDb(path.join(dir, "app.db"), migrationsFolder).sqlite;
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.restoreAllMocks();
  if (sqlite.open) sqlite.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

/** The Host enrolled and its owner gone, with Decisions connected to the fake relay. */
async function startHost() {
  // The owner enrolls the Host as its own device, then closes: nothing of the owner runs after this.
  const owner = await makeOwner();
  const pending = new MemoryPendingHostStore();
  const { request } = await createHostRequest({ pending, label: "studio", fresh: true });
  const { response } = await enrollHost(owner.client, request);
  const hostKeys = new MemoryKeyStore();
  const host = await acceptHostEnrollment({
    response,
    pending,
    keyStore: hostKeys,
    verifyWithRelay: false,
  });
  const phoneKeys = await generateDeviceKeys(false);
  const phoneId = newId();
  const phone: Phone = {
    deviceId: phoneId,
    keys: phoneKeys,
    cert: await issueDeviceCert({
      issuerDeviceId: owner.deviceId,
      issuerSigningKey: owner.identity.keys.signing.privateKey,
      installationId: owner.installationId,
      deviceId: phoneId,
      role: "phone",
      label: "Phone",
      signingPub: await exportPublicKey(phoneKeys.signing.publicKey),
      exchangePub: await exportPublicKey(phoneKeys.exchange.publicKey),
    }),
  };
  const relay = new FakeRelay([
    ...owner.devices,
    {
      device_id: phone.deviceId,
      role: "phone",
      label: "Phone",
      cert: phone.cert,
      created_at: new Date().toISOString(),
      last_seen_at: null,
      revoked_at: null,
      push_enabled: true,
    },
  ]);
  relay.hostDeviceId = host.config.deviceId;

  // The Host's own terminals, panes and listener.
  const terminals = new HostTerminals();
  terminals.add("pane-1");
  terminals.add("pane-2");
  const bearers = new Map([
    ["token-pane-1", { paneId: "pane-1", principal: "principal-1", workspaceId: "project-1" }],
    ["token-pane-2", { paneId: "pane-2", principal: "principal-2", workspaceId: "project-1" }],
  ]);
  const principalFor = (paneId: string) =>
    [...bearers.values()].find((bearer) => bearer.paneId === paneId)?.principal ?? null;
  const listener = await loopbackListener();
  cleanups.push(() => listener.close());
  const stateListeners = new Set<(payload: NotifyStateChange) => void>();
  const notify = new TerminalNotifyService({
    getPtyClient: () => terminals,
    onStateChanged: (listen) => {
      stateListeners.add(listen);
      return () => stateListeners.delete(listen);
    },
    onKilled: () => () => {},
    onTrashed: () => () => {},
    isEnabled: () => false,
    publish: () => {},
  });

  const record = {
    relayOrigin: host.config.relayOrigin,
    installationId: host.config.installationId,
    deviceId: host.config.deviceId,
    ownerDeviceId: host.owner.deviceId,
    hostId: "host_studio_0001",
    ownerOffAt: null,
    revokedAt: null,
    credentialsRemovedAt: null,
  };
  const service: DecisionsService = new DecisionsService({
    openStore: async () => new DaintreeLocalStore(sqlite),
    keyFilePath: () => path.join(dir, "keys.bin"),
    openQuestions: (source, previousClosed) =>
      openDecisionsMcpRoute(
        source,
        {
          bearerFor: (token) => bearers.get(token) ?? null,
          principalFor,
          hostId: () => service.getSettings()?.hostId ?? null,
          getPtyClient: () => terminals,
          holdListener: listener.hold,
        },
        previousClosed
      ),
    delivery: {
      principalFor,
      getPtyClient: () => terminals,
      holdWakes: () => {
        const scope = notify.openWakeScope();
        return {
          queueWake: (pane, projectId, wake) => scope.enqueueWake(pane, projectId, wake),
          cancelQueued: () => scope.cancelQueued(),
          release: () => scope.release(),
        };
      },
      watchPanes: () => () => {},
    },
    // The Host's sealed keys stand in for its keychain; the relay is the fake one.
    connect: (options) =>
      new RelayConnection({
        ...options,
        keys: hostKeys,
        rotations: undefined,
        webSocket: relay.webSocket,
        fetchImpl: relay.fetch,
        watchResume: () => () => {},
        watchNetwork: () => () => {},
        rand: () => 0,
        pumpIntervalMs: 0,
      }),
  });
  cleanups.push(() => service.dispose());

  await service.start(hostLifetimeSettings(record), "host");
  await vi.waitFor(() => expect(service.getStatus().state).toBe("connected"), {
    timeout: 15_000,
  });
  return { owner, phone, relay, host, terminals, listener, record, service };
}

describe("Decisions on an enrolled Remote Host, with its owner's computer gone (#16022)", () => {
  it("asks from the Host's pane, and types the phone's answer into it, live and after being away", async () => {
    const { owner, phone, relay, host, terminals, listener, record, service } = await startHost();

    // An agent on the Host asks; the question is the Host's own, with its host id.
    const first = await askHuman(listener.port, "token-pane-1", "Which way for the parser?");
    await vi.waitFor(() => expect(relay.questions.has(first)).toBe(true), { timeout: 15_000 });
    expect(relay.questions.get(first)!.signer_device_id).toBe(host.config.deviceId);
    const stored = await new DaintreeLocalStore(sqlite).getQuestion(first);
    expect(stored?.origin).toMatchObject({ host_id: record.hostId, pane_id: "pane-1" });

    // Another device's question, answered in the same ledger: kept for sync, never typed here.
    const foreign = newId();
    relay.questions.set(foreign, {
      target_host_id: "host_owner_mac",
      signer_device_id: owner.deviceId,
    });
    relay.append({
      event_type: "decision.created",
      question_id: foreign,
      question_revision: 0,
      origin_device_id: owner.deviceId,
      data: {},
    });
    await phoneAnswers(relay, owner, phone, foreign, "b");
    const foreignEvents = relay.events.filter((event) => event.question_id === foreign).length;

    // The phone answers while the Host is connected: typed into the pane that asked.
    await phoneAnswers(relay, owner, phone, first, "a");
    await vi.waitFor(() => expect(terminals.submitted).toHaveLength(1), { timeout: 15_000 });
    expect(terminals.submitted[0]!.id).toBe("pane-1");
    expect(typedChoices(terminals.submitted[0]!.text)).toEqual(["a"]);
    // The other device's question and answer were stored for sync, and made no row or report here.
    const hostStore = new DaintreeLocalStore(sqlite);
    expect(await hostStore.getQuestion(foreign)).toBeNull();
    expect(
      sqlite
        .prepare("SELECT COUNT(*) AS n FROM decisions_inbound_events WHERE json LIKE ?")
        .get(`%${foreign}%`)
    ).toEqual({ n: foreignEvents });
    await vi.waitFor(
      async () =>
        expect((await new DaintreeLocalStore(sqlite).getQuestion(first))?.delivery_status).toBe(
          "terminal-delivered"
        ),
      { timeout: 15_000 }
    );

    // The Host asks again, then is away while the phone answers: the answer waits in the relay.
    const second = await askHuman(listener.port, "token-pane-2", "Which way for the lexer?");
    await vi.waitFor(() => expect(relay.questions.has(second)).toBe(true), { timeout: 15_000 });
    relay.down = true;
    relay.liveSocket()!.drop();
    await vi.waitFor(() => expect(service.getStatus().state).toBe("reconnecting"), {
      timeout: 15_000,
    });
    await phoneAnswers(relay, owner, phone, second, "b");
    expect(terminals.submitted).toHaveLength(1);

    // Back online: it catches up through sync and types the answer, once.
    relay.down = false;
    await vi.waitFor(() => expect(terminals.submitted).toHaveLength(2), { timeout: 20_000 });
    expect(terminals.submitted[1]!.id).toBe("pane-2");
    expect(typedChoices(terminals.submitted[1]!.text)).toEqual(["b"]);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(terminals.submitted).toHaveLength(2);

    expect(
      relay.requests.some(
        (request) =>
          request.path.startsWith("/api/v1/deliveries/") &&
          JSON.stringify(request.body).includes(foreign)
      )
    ).toBe(false);

    // Everything the relay was asked was signed by the Host's own device: the owner signed nothing.
    const signers = new Set(relay.requests.map((request) => request.deviceId));
    expect(signers).toEqual(new Set([host.config.deviceId]));
  }, 60_000);

  // A 0.4.0 relay sends thread messages only to a desktop that declared them, and Daintree declares
  // nothing until it types follow-ups (#16231). One that arrives anyway is stored and ignored (#16229).
  it("ignores a phone's follow-up from a 0.4.0 relay, declares no 0.4.0 feature, and still types the answer", async () => {
    const { owner, phone, relay, terminals, listener, service } = await startHost();
    const asked = await askHuman(listener.port, "token-pane-1", "Which way for the parser?");
    await vi.waitFor(() => expect(relay.questions.has(asked)).toBe(true), { timeout: 15_000 });
    const store = new DaintreeLocalStore(sqlite);
    const before = (await store.getQuestion(asked))!;

    const followUp = await phoneFollowsUp(relay, owner, phone, asked, "Actually, what about B?");
    await vi.waitFor(
      () =>
        expect(
          sqlite
            .prepare("SELECT processed_at FROM decisions_inbound_events WHERE seq = ?")
            .get(followUp.seq)
        ).toEqual({ processed_at: expect.any(Number) }),
      { timeout: 15_000 }
    );
    // Ignored, not refused: the cursor is past it, and nothing was rejected or failed.
    expect(await store.getCursor()).toBeGreaterThanOrEqual(followUp.seq);
    const refused = (await store.listAudit(1_000)).filter((entry) =>
      ["event.rejected", "event.error"].includes(entry.event)
    );
    expect(refused).toEqual([]);
    const after = (await store.getQuestion(asked))!;
    expect(after).toMatchObject({
      local_status: before.local_status,
      delivery_status: before.delivery_status,
      question_revision: before.question_revision,
      answers_json: before.answers_json,
      delivered_revision: before.delivered_revision,
      messages_json: "[]",
    });
    expect(terminals.submitted).toEqual([]);
    expect(service.getStatus().state).toBe("connected");

    await phoneAnswers(relay, owner, phone, asked, "a");
    await vi.waitFor(() => expect(terminals.submitted).toHaveLength(1), { timeout: 15_000 });
    expect(typedChoices(terminals.submitted[0]!.text)).toEqual(["a"]);
    expect(terminals.submitted[0]!.text).not.toContain("what about B");
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(terminals.submitted).toHaveLength(1);
    expect(relay.requests.some((request) => request.path === "/api/v1/deliveries/messages")).toBe(
      false
    );

    const tickets = relay.requests.filter((request) => request.path === "/api/v1/socket-ticket");
    expect(tickets.length).toBeGreaterThan(0);
    for (const ticket of tickets) expect(ticket.body).not.toHaveProperty("features");
  }, 60_000);
  it("publishes a Host pane's follow-ups on its own questions, signed by the Host, live and after being away", async () => {
    const { owner, relay, host, terminals, listener, service } = await startHost();
    const store = new DaintreeLocalStore(sqlite);
    const followUp = (token: string, questionId: string, text: string, expectsReply: boolean) =>
      callTool(listener.port, token, "send_followup", {
        question_id: questionId,
        text,
        expects_reply: expectsReply,
      });
    /** What the phone reads of a message the relay took: its record, and its words opened with the owner's keys. */
    const posted = async (index: number) => {
      const message = relay.messages[index]!;
      const content = (await decryptEnvelope(message.envelope as never, owner.identity.epochs, {
        questionId: message.questionId,
        recordType: MESSAGE_RECORD_TYPE,
        purpose: "message-content",
      })) as { side: string; text: string };
      return { ...message, content };
    };

    const asked = await askHuman(listener.port, "token-pane-1", "Which way for the parser?");
    await vi.waitFor(() => expect(relay.questions.has(asked)).toBe(true), { timeout: 15_000 });
    const before = (await store.getQuestion(asked))!;

    // Connected: queued at once, then published by the Host's own device.
    const live = await followUp("token-pane-1", asked, "Is B the faster one?", true);
    expect(live.structuredContent).toMatchObject({ question_id: asked, status: "queued" });
    await vi.waitFor(() => expect(relay.messages).toHaveLength(1), { timeout: 15_000 });
    const first = await posted(0);
    expect(first).toMatchObject({
      questionId: asked,
      deviceId: host.config.deviceId,
      record: {
        message_id: live.structuredContent.message_id,
        side: "agent",
        expects_reply: true,
        signer_device_id: host.config.deviceId,
      },
      content: { side: "agent", text: "Is B the faster one?" },
    });

    // The other pane's follow-up on that question is refused as an unknown one, and nothing is sent.
    const refused = await followUp("token-pane-2", asked, "Pick A for them.", false);
    expect(refused).toMatchObject({ isError: true, structuredContent: { error: "not_found" } });

    // Away: a follow-up, and a question with a follow-up of its own, are kept and answered at once.
    relay.down = true;
    relay.liveSocket()!.drop();
    await vi.waitFor(() => expect(service.getStatus().state).toBe("reconnecting"), {
      timeout: 15_000,
    });
    const away = await followUp("token-pane-1", asked, "No reply needed: B is faster.", false);
    expect(away.structuredContent).toMatchObject({ status: "queued", expects_reply: false });
    const later = await askHuman(listener.port, "token-pane-2", "Which way for the lexer?");
    const laterFollowUp = await followUp("token-pane-2", later, "Either works for me.", false);
    expect(laterFollowUp.structuredContent).toMatchObject({ status: "queued" });
    expect(relay.messages).toHaveLength(1);

    // Back: each is published once, a new question before its own follow-up.
    relay.down = false;
    await vi.waitFor(() => expect(relay.messages).toHaveLength(3), { timeout: 20_000 });
    const sent = await Promise.all([1, 2].map((index) => posted(index)));
    expect(sent.map((message) => [message.questionId, message.content.text])).toEqual(
      expect.arrayContaining([
        [asked, "No reply needed: B is faster."],
        [later, "Either works for me."],
      ])
    );
    const created = relay.requests.findIndex(
      (request) =>
        request.path === "/api/v1/questions" && JSON.stringify(request.body).includes(later)
    );
    const laterPosted = relay.requests.findIndex(
      (request) => request.path === `/api/v1/questions/${later}/messages`
    );
    expect(created).toBeGreaterThanOrEqual(0);
    expect(laterPosted).toBeGreaterThan(created);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(relay.messages).toHaveLength(3);

    // A follow-up is never typed anywhere, and never moves its question.
    expect(terminals.submitted).toEqual([]);
    expect((await store.getQuestion(asked))!).toMatchObject({
      local_status: before.local_status,
      delivery_status: before.delivery_status,
      question_revision: before.question_revision,
      answers_json: before.answers_json,
    });
    const signers = new Set(
      relay.requests
        .filter((request) => request.path !== "/api/v1/info")
        .map((request) => request.deviceId)
    );
    expect(signers).toEqual(new Set([host.config.deviceId]));
  }, 60_000);
});
