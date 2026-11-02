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
  encryptEnvelope,
  exportPublicKey,
  generateDeviceKeys,
  issueDeviceCert,
  newId,
  type DeviceKeys,
} from "@daintreehq/decisions-crypto";
import { EventData, type DeviceCert } from "@daintreehq/decisions-protocol";

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

/** An agent's `ask_human`, through the Host's `/mcp/decisions` with its pane's bearer. */
async function askHuman(port: number, token: string, question: string): Promise<string> {
  const body = JSON.stringify({
    jsonrpc: "2.0",
    id: nextRpc++,
    method: "tools/call",
    params: {
      name: "ask_human",
      arguments: {
        question,
        kind: "choice",
        options: [
          { id: "a", label: "Option A" },
          { id: "b", label: "Option B" },
        ],
      },
    },
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
  const result = (
    JSON.parse(answer.body) as { result: { structuredContent: { question_id: string } } }
  ).result;
  return result.structuredContent.question_id;
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

describe("Decisions on an enrolled Remote Host, with its owner's computer gone (#16022)", () => {
  it("asks from the Host's pane, and types the phone's answer into it, live and after being away", async () => {
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
});
