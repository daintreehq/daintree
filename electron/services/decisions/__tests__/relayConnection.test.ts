import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  DecisionsBridge,
  INVOLVEMENT_META,
  MemoryKeyStore,
  MemoryLocalStore,
  STORE_FORMAT,
  STORE_FORMAT_KEY,
  hostRef,
  loadIdentity,
  type KeyStore,
  type ProxyEngine,
  type StoredIdentity,
  type WebSocketLike,
} from "@daintreehq/decisions-client";
import {
  buildSignedAction,
  buildSignedInvolvement,
  exportPublicKey,
  generateDeviceKeys,
  generateEpochKeyBytes,
  issueDeviceCert,
  serializeDeviceKeys,
  signObject,
  verifyObject,
  type DeviceKeys,
} from "@daintreehq/decisions-crypto";
import { pendingRotationOf } from "../keyRotation.js";
import { PRESENCE_TICK_MS, type PresenceWatchers } from "../desktopPresence.js";
import {
  AGENT_STOPPED_BATCH_MS,
  AGENT_STOPPED_COOLDOWN_MS,
  type AgentTransition,
} from "../agentStoppedPushes.js";
import type { UserPresence } from "../../userPresence.js";
import {
  EventData,
  bytesToBase64Url,
  type DeviceCert,
  type InvolvementRecord,
} from "@daintreehq/decisions-protocol";
import {
  LEGACY_PHONE_INVOLVEMENT_START,
  legacyPhoneInvolvementRead,
} from "@daintreehq/decisions-protocol/fixtures";

vi.mock("electron", () => ({
  app: {
    getPath: () => "/fake/userData",
    isPackaged: false,
    getAppPath: () => "/fake/appPath",
  },
  safeStorage: {},
  net: { isOnline: () => true },
  powerMonitor: { on: vi.fn(), off: vi.fn() },
}));

const logWarn = vi.hoisted(() => vi.fn());
/** How many of the next requests for a way to reach the relay fail, as one that can't be made. */
const relayRequestFailures = vi.hoisted(() => ({ left: 0 }));

vi.mock("../relayIdentity.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../relayIdentity.js")>();
  return {
    ...actual,
    relayRequests: (...args: Parameters<typeof actual.relayRequests>) => {
      if (relayRequestFailures.left > 0) {
        relayRequestFailures.left -= 1;
        return Promise.reject(new Error("network"));
      }
      return actual.relayRequests(...args);
    },
  };
});

vi.mock("../../../utils/logger.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../utils/logger.js")>();
  return {
    ...actual,
    logWarn: vi.fn((...args: Parameters<typeof actual.logWarn>) => logWarn(...args)),
  };
});

import {
  RECONNECT_BASE_MS,
  RECONNECT_CAP_MS,
  RELAY_BINDING_META_KEY,
  REPLACED_MAX_MS,
  REPLACED_MIN_MS,
  RelayConnection,
  type RelayBinding,
  type RelayConnectionOptions,
  type RelayConnectionStatus,
} from "../relayConnection.js";
import type { RelayFetch } from "../relayCheck.js";
import { openDb } from "../../persistence/db.js";
import { DaintreeLocalStore } from "../daintreeLocalStore.js";
import { DecisionsAttachments } from "../attachmentSpool.js";
import { createTrustedPolicy } from "../workflowGates.js";
import { defaultDecisionsSettings } from "../decisionsSettings.js";
import { QuestionBridge } from "../questionBridge.js";
import type { QuestionSource } from "../relayConnection.js";
import { DAINTREE_PROTOCOL_FEATURES } from "../relayFeatures.js";

const RELAY: RelayBinding = {
  relayOrigin: "https://decisions.example.workers.dev",
  installationId: "inst_12345678",
  deviceId: "dev_12345678",
};

type Frame = Record<string, unknown>;

/** The relay's end of one socket: what Daintree sent, and frames and closes to send it. */
class FakeSocket implements WebSocketLike {
  readyState = 0;
  onopen: WebSocketLike["onopen"] = null;
  onmessage: WebSocketLike["onmessage"] = null;
  onclose: WebSocketLike["onclose"] = null;
  onerror: WebSocketLike["onerror"] = null;
  readonly sent: string[] = [];
  closedByClient: number | null = null;
  private waiters: Array<{ match: (frame: Frame) => boolean; resolve: (frame: Frame) => void }> =
    [];

  constructor(readonly url: string) {}

  send(data: string): void {
    if (this.readyState !== 1) throw new Error("not open");
    this.sent.push(data);
    if (data === "ping") return;
    const frame = JSON.parse(data) as Frame;
    for (const waiter of [...this.waiters]) {
      if (!waiter.match(frame)) continue;
      this.waiters.splice(this.waiters.indexOf(waiter), 1);
      waiter.resolve(frame);
    }
  }

  close(code = 1000): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.closedByClient = code;
  }

  frames(): Frame[] {
    return this.sent.filter((data) => data !== "ping").map((data) => JSON.parse(data) as Frame);
  }

  /** Resolves with the first frame Daintree sent, or sends later, that matches. */
  waitFor(match: (frame: Frame) => boolean): Promise<Frame> {
    const already = this.frames().find(match);
    if (already) return Promise.resolve(already);
    return new Promise((resolve) => this.waiters.push({ match, resolve }));
  }

  /** Opens and says hello, as the relay's Durable Object does on accept. */
  accept(highWater = 0): void {
    this.readyState = 1;
    this.onopen?.({});
    this.send_({
      t: "hello",
      protocol_version: 1,
      device_id: RELAY.deviceId,
      role: "owner-desktop",
      key_epoch: 1,
      high_water: highWater,
      server_time: new Date().toISOString(),
    });
  }

  event(seq: number): void {
    this.send_({
      t: "event",
      event: {
        protocol_version: 1,
        seq,
        event_id: `evt_${String(seq).padStart(8, "0")}`,
        event_type: "delivery.received",
        occurred_at: new Date().toISOString(),
        question_id: null,
        question_revision: null,
        origin_device_id: null,
        data: {},
      },
    });
  }

  caughtUp(highWater: number, hasMore: boolean): void {
    this.send_({ t: "caught_up", high_water: highWater, has_more: hasMore });
  }

  /** The relay closes the socket. */
  drop(code: number): void {
    this.readyState = 3;
    this.onclose?.({ code, reason: "closed by the relay" });
  }

  private send_(frame: Frame): void {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }
}

/** A relay answering socket tickets, and handing each socket Daintree opens to the test. */
function fakeRelay() {
  const sockets: FakeSocket[] = [];
  const socketWaiters = new Map<number, (socket: FakeSocket) => void>();
  const tickets: string[] = [];
  /** Idempotency keys of the questions Daintree published, in order. */
  const questions: string[] = [];
  /** Attachment ids whose ciphertext Daintree uploaded, in order. */
  const uploads: string[] = [];
  let answerTicket: (n: number) => Response = (n) =>
    new Response(
      JSON.stringify({
        ticket: `ticket-${n}`,
        expires_at: new Date(Date.now() + 30_000).toISOString(),
        ws_path: "/api/v1/socket",
      }),
      { status: 200, headers: { "content-type": "application/json" } }
    );
  const fetchImpl = async (url: string, init: RequestInit): Promise<Response> => {
    const { pathname } = new URL(url);
    if (pathname === "/api/v1/socket-ticket" && init.method === "POST") {
      tickets.push(url);
      return answerTicket(tickets.length);
    }
    if (pathname === "/api/v1/questions" && init.method === "POST") {
      const body = JSON.parse(String(init.body)) as { idempotency_key: string };
      questions.push(body.idempotency_key);
      return new Response(JSON.stringify({ event_seq: questions.length }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (pathname === "/api/v1/attachments/reservations" && init.method === "POST") {
      const body = JSON.parse(String(init.body)) as { attachment_id: string };
      return new Response(
        JSON.stringify({
          attachment_id: body.attachment_id,
          upload_path: `/api/v1/attachments/${body.attachment_id}/content`,
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }
    const upload = /^\/api\/v1\/attachments\/([^/]+)\/(content|complete)$/.exec(pathname);
    if (upload && (init.method === "PUT" || init.method === "POST")) {
      if (upload[2] === "content") uploads.push(upload[1]);
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response(JSON.stringify({ code: "not_found", message: "no route" }), {
      status: 404,
    });
  };
  const webSocket = (url: string): WebSocketLike => {
    const socket = new FakeSocket(url);
    sockets.push(socket);
    socketWaiters.get(sockets.length - 1)?.(socket);
    return socket;
  };
  return {
    sockets,
    tickets,
    questions,
    uploads,
    fetchImpl,
    webSocket,
    /** The nth socket Daintree opens (0-based), once it does. */
    socket(n: number): Promise<FakeSocket> {
      const existing = sockets[n];
      if (existing) return Promise.resolve(existing);
      return new Promise((resolve) => socketWaiters.set(n, resolve));
    },
    answerTicketsWith(answer: (n: number) => Response): void {
      answerTicket = answer;
    },
  };
}

async function ownerIdentity(relay: RelayBinding = RELAY): Promise<StoredIdentity> {
  const keys = await generateDeviceKeys(true);
  return {
    v: 1,
    config: {
      relayOrigin: relay.relayOrigin,
      installationId: relay.installationId,
      deviceId: relay.deviceId,
      label: "Test desktop",
    },
    keys: await serializeDeviceKeys(keys),
    epochs: [{ epoch: 1, raw: bytesToBase64Url(generateEpochKeyBytes()) }],
    currentEpoch: 1,
  };
}

interface Harness {
  connection: RelayConnection;
  relay: ReturnType<typeof fakeRelay>;
  store: MemoryLocalStore | DaintreeLocalStore;
  statuses: RelayConnectionStatus[];
  revoked: ReturnType<typeof vi.fn>;
  resume(): void;
  networkChanged(online: boolean): void;
  watching(): number;
  /** Resolves once the connection reports `state`, now or later. */
  status(state: RelayConnectionStatus["state"]): Promise<RelayConnectionStatus>;
  /** Resolves the next time the connection reports `state`, never with one already reported. */
  next(state: RelayConnectionStatus["state"]): Promise<RelayConnectionStatus>;
}

let identity: StoredIdentity;

beforeEach(async () => {
  identity ??= await ownerIdentity();
  relayRequestFailures.left = 0;
  vi.useFakeTimers({
    toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"],
  });
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

async function harness(
  options: {
    store?: MemoryLocalStore | DaintreeLocalStore;
    stored?: StoredIdentity | null;
    rand?: () => number;
    wrapFetch?: (fetchImpl: RelayFetch) => RelayFetch;
    keys?: KeyStore;
    overrides?: Partial<RelayConnectionOptions>;
  } = {}
): Promise<Harness> {
  const relay = fakeRelay();
  const store = options.store ?? new MemoryLocalStore();
  const keys = options.keys ?? new MemoryKeyStore();
  const stored = options.stored === undefined ? identity : options.stored;
  if (stored && !options.keys) await keys.save(stored);
  const statuses: RelayConnectionStatus[] = [];
  const waiters: Array<{ state: string; resolve: (status: RelayConnectionStatus) => void }> = [];
  const resumes = new Set<() => void>();
  const networks = new Set<(online: boolean) => void>();
  const revoked = vi.fn();
  const connection = new RelayConnection({
    relay: RELAY,
    store,
    keys,
    policy: createTrustedPolicy(
      { ...defaultDecisionsSettings(), proxyAllowlisted: false },
      "owner"
    ),
    onStatus: (status) => {
      statuses.push(status);
      for (const waiter of [...waiters]) {
        if (waiter.state !== status.state) continue;
        waiters.splice(waiters.indexOf(waiter), 1);
        waiter.resolve(status);
      }
    },
    onRevoked: revoked,
    webSocket: relay.webSocket,
    fetchImpl: options.wrapFetch ? options.wrapFetch(relay.fetchImpl) : relay.fetchImpl,
    watchResume: (onResume) => {
      resumes.add(onResume);
      return () => resumes.delete(onResume);
    },
    watchNetwork: (onChange) => {
      networks.add(onChange);
      return () => networks.delete(onChange);
    },
    rand: options.rand ?? (() => 0.5),
    pumpIntervalMs: 0,
    ...options.overrides,
  });
  return {
    connection,
    relay,
    store,
    statuses,
    revoked,
    resume: () => [...resumes].forEach((onResume) => onResume()),
    networkChanged: (online) => [...networks].forEach((onChange) => onChange(online)),
    watching: () => resumes.size + networks.size,
    status: (state) => {
      const last = statuses.at(-1);
      if (last?.state === state) return Promise.resolve(last);
      return new Promise((resolve) => waiters.push({ state, resolve }));
    },
    next: (state) => new Promise((resolve) => waiters.push({ state, resolve })),
  };
}

/** Whether `bridge` was given `advisoryDeadlines`: the library keeps it on its advice support, unexported. */
function hostSupport(bridge: DecisionsBridge): boolean {
  return (bridge as unknown as { advisory: { hostSupport: boolean } }).advisory.hostSupport;
}

/** Opens the first socket and brings it live with nothing to replay. */
async function connectLive(h: Harness, n = 0): Promise<FakeSocket> {
  const socket = await h.relay.socket(n);
  socket.accept();
  await socket.waitFor((frame) => frame.t === "sync");
  const cursor = await h.store.getCursor();
  socket.caughtUp(cursor, false);
  await socket.waitFor((frame) => frame.t === "ack" && frame.seq === cursor);
  await h.status("connected");
  return socket;
}

const QUESTION_ORIGIN = {
  host_id: "host_a",
  pane_id: "pane-1",
  terminal_generation: 1,
  ownership_principal: "principal-1",
  agent_incarnation: "0",
  agent_kind: "claude",
  agent_session_id: null,
  project_id: "p1",
  worktree_id: "wt-1",
  worktree_root: "/repo",
  workflow_gate_id: null,
};

describe("RelayConnection", () => {
  it("connects with a fresh ticket on the relay's own origin, then syncs from the stored cursor", async () => {
    const store = new MemoryLocalStore();
    await store.insertEvent({
      seq: 1,
      event_id: "evt_1",
      event_type: "delivery.received",
      json: "{}",
      received_at: 0,
      processed_at: 0,
    });
    await store.advanceCursor();
    const h = await harness({ store });

    h.connection.start();
    expect(h.statuses).toEqual([{ state: "connecting" }]);
    const socket = await h.relay.socket(0);
    expect(new URL(socket.url).origin).toBe("wss://decisions.example.workers.dev");
    expect(new URL(socket.url).searchParams.get("ticket")).toBe("ticket-1");

    socket.accept(1);
    expect(await socket.waitFor((frame) => frame.t === "sync")).toEqual({ t: "sync", after: 1 });
    await h.status("connected");
    h.connection.stop();
  });

  it("runs only the role it was made for: an owner's keys never connect as a Host's (#16022)", async () => {
    const h = await harness({ overrides: { role: "desktop-host" } });

    h.connection.start();

    expect(await h.status("not-connected")).toEqual({ state: "not-connected", problem: "keys" });
    expect(h.relay.tickets).toHaveLength(0);
    expect(h.relay.sockets).toHaveLength(0);
  });

  it("pages a replay: persists and acks each event, asks for the next segment, then goes live", async () => {
    const h = await harness();
    h.connection.start();
    const socket = await h.relay.socket(0);
    socket.accept(4);
    await socket.waitFor((frame) => frame.t === "sync" && frame.after === 0);

    socket.event(1);
    socket.event(2);
    socket.caughtUp(2, true);
    await socket.waitFor((frame) => frame.t === "sync" && frame.after === 2);
    socket.event(3);
    socket.event(4);
    socket.caughtUp(4, false);
    await socket.waitFor((frame) => frame.t === "ack" && frame.seq === 4);

    expect(await h.store.getCursor()).toBe(4);
    const acks = socket
      .frames()
      .filter((frame) => frame.t === "ack")
      .map((frame) => frame.seq);
    expect(acks).toContain(1);
    expect(acks).toContain(2);
    expect(acks).toContain(3);
    expect(socket.frames().filter((frame) => frame.t === "sync")).toEqual([
      { t: "sync", after: 0 },
      { t: "sync", after: 2 },
    ]);
    expect(h.statuses.at(-1)).toEqual({ state: "connected" });
    h.connection.stop();
  });

  it("holds the cursor at a gap, asks the relay to replay it, and moves once it closes", async () => {
    const h = await harness();
    h.connection.start();
    const socket = await connectLive(h);

    socket.event(1);
    await socket.waitFor((frame) => frame.t === "ack" && frame.seq === 1);
    socket.event(3);
    // The out-of-order event is stored, but the receipt cursor stays behind the hole.
    await socket.waitFor((frame) => frame.t === "sync" && frame.after === 1);
    expect(await h.store.getCursor()).toBe(1);
    // The replay that brought it live acked 0; each event since acks the cursor as it stands.
    expect(
      socket
        .frames()
        .filter((frame) => frame.t === "ack")
        .map((frame) => frame.seq)
    ).toEqual([0, 1, 1]);

    socket.event(2);
    await socket.waitFor((frame) => frame.t === "ack" && frame.seq === 3);
    expect(await h.store.getCursor()).toBe(3);
    h.connection.stop();
  });

  it("retries a dropped socket with full-jitter backoff, showing when, and resyncs from the stored cursor", async () => {
    const h = await harness({ rand: () => 0.5 });
    h.connection.start();
    const first = await connectLive(h);
    first.event(1);
    await first.waitFor((frame) => frame.t === "ack" && frame.seq === 1);

    const droppedAt = Date.now();
    first.drop(1006);
    const waiting = await h.status("reconnecting");
    expect(waiting).toEqual({
      state: "reconnecting",
      nextAttemptAt: droppedAt + RECONNECT_BASE_MS,
    });
    expect(h.relay.tickets).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(RECONNECT_BASE_MS);
    const second = await h.relay.socket(1);
    expect(h.relay.tickets).toHaveLength(2);
    second.accept(1);
    expect(await second.waitFor((frame) => frame.t === "sync")).toEqual({ t: "sync", after: 1 });

    // The library's own retry was cancelled: one ticket per attempt, nothing more.
    await vi.advanceTimersByTimeAsync(RECONNECT_CAP_MS);
    expect(h.relay.tickets).toHaveLength(2);
    h.connection.stop();
  });

  it("asks every attempt's bridge to apply the one policy it was given, never a fresh one", async () => {
    const policy = createTrustedPolicy(
      { ...defaultDecisionsSettings(), proxyAllowlisted: false },
      "owner"
    );
    const used: unknown[] = [];
    const start = vi.spyOn(DecisionsBridge.prototype, "start").mockImplementation(async function (
      this: DecisionsBridge
    ) {
      used.push(this.ctx.policy);
      throw new Error("no relay in this test");
    });
    const h = await harness({ rand: () => 0.5, overrides: { policy } });
    h.connection.start();
    await h.status("reconnecting");
    const retried = h.next("reconnecting");
    await vi.advanceTimersByTimeAsync(RECONNECT_BASE_MS);
    await retried;
    h.connection.stop();
    start.mockRestore();

    expect(used.length).toBeGreaterThanOrEqual(2);
    for (const seen of used) expect(seen).toBe(policy);
  });

  it("doubles the backoff window per failure up to five minutes, and resets after a hello", async () => {
    const h = await harness({ rand: () => 0.999 });
    h.relay.answerTicketsWith(
      () => new Response(JSON.stringify({ code: "unavailable", message: "down" }), { status: 503 })
    );
    h.connection.start();

    const delays: number[] = [];
    let startedAt = Date.now();
    let waiting = (await h.status("reconnecting")) as { nextAttemptAt: number };
    for (let failure = 0; failure < 11; failure += 1) {
      delays.push(waiting.nextAttemptAt - startedAt);
      if (failure === 10) break;
      // Listening before time moves, so a failure that lands within the advance is still seen.
      const next = h.next("reconnecting");
      await vi.advanceTimersByTimeAsync(waiting.nextAttemptAt - Date.now());
      startedAt = waiting.nextAttemptAt;
      waiting = (await next) as { nextAttemptAt: number };
    }
    for (let i = 0; i < delays.length; i += 1) {
      expect(delays[i]).toBe(
        Math.max(
          RECONNECT_BASE_MS,
          Math.floor(0.999 * Math.min(RECONNECT_CAP_MS, RECONNECT_BASE_MS * 2 ** i))
        )
      );
    }
    expect(Math.max(...delays)).toBeLessThanOrEqual(RECONNECT_CAP_MS);
    expect(delays.at(-1)).toBeGreaterThan(delays[0]! * 100);

    h.relay.answerTicketsWith(
      (n) =>
        new Response(
          JSON.stringify({ ticket: `ticket-${n}`, expires_at: "", ws_path: "/api/v1/socket" }),
          { status: 200 }
        )
    );
    await vi.advanceTimersByTimeAsync(waiting.nextAttemptAt - Date.now());
    const socket = await connectLive(h, 0);
    const droppedAt = Date.now();
    socket.drop(1006);
    const after = (await h.status("reconnecting")) as { nextAttemptAt: number };
    expect(after.nextAttemptAt - droppedAt).toBe(RECONNECT_BASE_MS);
    h.connection.stop();
  });

  it("on 4409 shows the replacement, waits out a long cooldown that resume doesn't cut short, then tries again", async () => {
    const h = await harness({ rand: () => 0.5 });
    h.connection.start();
    const first = await connectLive(h);
    first.event(1);
    await first.waitFor((frame) => frame.t === "ack" && frame.seq === 1);

    const replacedAt = Date.now();
    first.drop(4409);
    const replaced = (await h.status("replaced")) as { nextAttemptAt: number };
    const delay = replaced.nextAttemptAt - replacedAt;
    expect(delay).toBeGreaterThanOrEqual(REPLACED_MIN_MS);
    expect(delay).toBeLessThanOrEqual(REPLACED_MAX_MS);

    h.resume();
    h.networkChanged(true);
    await vi.advanceTimersByTimeAsync(REPLACED_MIN_MS - 1_000);
    expect(h.relay.tickets).toHaveLength(1);
    expect(h.statuses.at(-1)?.state).toBe("replaced");

    await vi.advanceTimersByTimeAsync(replaced.nextAttemptAt - Date.now());
    const second = await h.relay.socket(1);
    second.accept(1);
    expect(await second.waitFor((frame) => frame.t === "sync")).toEqual({ t: "sync", after: 1 });
    expect(h.revoked).not.toHaveBeenCalled();
    h.connection.stop();
  });

  it("on 4401 stops for good: revoked once, and nothing reconnects it", async () => {
    const h = await harness();
    h.connection.start();
    const socket = await connectLive(h);

    socket.drop(4401);
    await h.status("revoked");
    expect(h.revoked).toHaveBeenCalledTimes(1);
    expect(h.watching()).toBe(0);

    h.resume();
    h.networkChanged(true);
    await vi.advanceTimersByTimeAsync(RECONNECT_CAP_MS * 2);
    expect(h.relay.tickets).toHaveLength(1);
    expect(h.relay.sockets).toHaveLength(1);
    expect(h.statuses.at(-1)).toEqual({ state: "revoked" });
    expect(h.revoked).toHaveBeenCalledTimes(1);
  });

  it("treats a ticket the relay refuses as forbidden as a revocation", async () => {
    const h = await harness();
    h.relay.answerTicketsWith(
      () =>
        new Response(JSON.stringify({ code: "forbidden", message: "device revoked" }), {
          status: 403,
        })
    );
    h.connection.start();

    await h.status("revoked");
    await vi.advanceTimersByTimeAsync(RECONNECT_CAP_MS);
    expect(h.relay.tickets).toHaveLength(1);
    expect(h.revoked).toHaveBeenCalledTimes(1);
  });

  it("treats the relay's revoked frame as a revocation", async () => {
    const h = await harness();
    h.connection.start();
    const socket = await connectLive(h);

    socket.onmessage?.({ data: JSON.stringify({ t: "revoked" }) });
    await h.status("revoked");
    expect(h.revoked).toHaveBeenCalledTimes(1);
  });

  it("reconnects at once on resume and on a network change, and once for both together", async () => {
    const h = await harness();
    h.connection.start();
    const first = await connectLive(h);
    first.event(1);
    await first.waitFor((frame) => frame.t === "ack" && frame.seq === 1);
    await vi.advanceTimersByTimeAsync(10_000);

    h.resume();
    h.networkChanged(true);
    const second = await h.relay.socket(1);
    expect(first.closedByClient).toBe(1000);
    second.accept(1);
    expect(await second.waitFor((frame) => frame.t === "sync")).toEqual({ t: "sync", after: 1 });
    await h.status("connected");
    expect(h.relay.tickets).toHaveLength(2);

    // Going offline isn't a reason to try; coming back is.
    await vi.advanceTimersByTimeAsync(10_000);
    h.networkChanged(false);
    await vi.advanceTimersByTimeAsync(0);
    expect(h.relay.tickets).toHaveLength(2);
    h.networkChanged(true);
    await h.relay.socket(2);
    expect(h.relay.tickets).toHaveLength(3);
    h.connection.stop();
  });

  it("opens a fresh attempt with a new ticket when refreshed, even one just after another began", async () => {
    const h = await harness();
    h.connection.start();
    const first = await connectLive(h);
    first.event(1);
    await first.waitFor((frame) => frame.t === "ack" && frame.seq === 1);

    // A resume coalesces into an attempt this young; a refresh never does.
    expect(h.connection.refresh()).toBe(true);
    const second = await h.relay.socket(1);
    expect(first.closedByClient).toBe(1000);
    expect(h.statuses.at(-1)).toEqual({ state: "connecting" });
    second.accept(1);
    expect(await second.waitFor((frame) => frame.t === "sync")).toEqual({ t: "sync", after: 1 });
    await h.status("connected");
    expect(h.relay.tickets).toHaveLength(2);
    h.connection.stop();
  });

  it("gives each attempt's bridge the model's learner and the proxy armed as it began, and replaces it when that changes (#16026)", async () => {
    const learner = { learn: vi.fn() };
    const proxy: ProxyEngine = {
      gateAware: true,
      suggest: vi.fn(async () => ({ action: "abstain" as const, reason: "test" })),
    };
    let armed: ProxyEngine | null = null;
    const bridges: DecisionsBridge[] = [];
    const original = DecisionsBridge.prototype.start;
    const start = vi.spyOn(DecisionsBridge.prototype, "start").mockImplementation(function (
      this: DecisionsBridge,
      ...args
    ) {
      bridges.push(this);
      return original.apply(this, args);
    });
    const proxyOf = (bridge: DecisionsBridge) =>
      (bridge as unknown as { o: { proxy?: ProxyEngine } }).o.proxy ?? null;
    const h = await harness({ overrides: { model: { learner, proxy: () => armed } } });
    h.connection.start();
    const first = await connectLive(h);
    expect(bridges[0]!.ctx.learner).toBe(learner);
    expect(proxyOf(bridges[0]!)).toBeNull();

    // Nothing changed for the attempt running: it carries on.
    h.connection.modelChanged();
    await vi.advanceTimersByTimeAsync(0);
    expect(first.closedByClient).toBeNull();
    expect(h.statuses.at(-1)).toEqual({ state: "connected" });
    expect(h.relay.tickets).toHaveLength(1);
    expect(bridges).toHaveLength(1);

    armed = proxy;
    h.connection.modelChanged();
    const second = await h.relay.socket(1);
    expect(first.closedByClient).toBe(1000);
    second.accept();
    await h.status("connected");
    expect(bridges).toHaveLength(2);
    expect(proxyOf(bridges[1]!)).toBe(proxy);
    expect(bridges[1]!.ctx.learner).toBe(learner);

    armed = null;
    h.connection.modelChanged();
    const third = await h.relay.socket(2);
    expect(second.closedByClient).toBe(1000);
    third.accept();
    await h.status("connected");
    expect(proxyOf(bridges[2]!)).toBeNull();
    h.connection.stop();
    start.mockRestore();
  });

  it("leaves a 4409's wait alone when the proxy changes, and the attempt after it asks the new one (#16026)", async () => {
    const proxy: ProxyEngine = {
      suggest: vi.fn(async () => ({ action: "abstain" as const, reason: "test" })),
    };
    let armed: ProxyEngine | null = null;
    const bridges: DecisionsBridge[] = [];
    const original = DecisionsBridge.prototype.start;
    const start = vi.spyOn(DecisionsBridge.prototype, "start").mockImplementation(function (
      this: DecisionsBridge,
      ...args
    ) {
      bridges.push(this);
      return original.apply(this, args);
    });
    const h = await harness({
      rand: () => 0.5,
      overrides: { model: { learner: { learn: () => {} }, proxy: () => armed } },
    });
    h.connection.start();
    const first = await connectLive(h);
    first.drop(4409);
    const replaced = await h.status("replaced");
    const deadline = (replaced as { nextAttemptAt: number }).nextAttemptAt;

    armed = proxy;
    h.connection.modelChanged();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(h.relay.tickets).toHaveLength(1);
    expect(h.statuses.at(-1)).toEqual({ state: "replaced", nextAttemptAt: deadline });

    await vi.advanceTimersByTimeAsync(deadline - Date.now());
    const second = await h.relay.socket(1);
    second.accept();
    await h.status("connected");
    expect((bridges.at(-1) as unknown as { o: { proxy?: ProxyEngine } }).o.proxy).toBe(proxy);
    h.connection.stop();
    start.mockRestore();
  });

  it("refreshes nothing during a 4409's wait", async () => {
    const h = await harness({ rand: () => 0.5 });
    h.connection.start();
    const first = await connectLive(h);
    first.drop(4409);
    await h.status("replaced");

    expect(h.connection.refresh()).toBe(false);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(h.relay.tickets).toHaveLength(1);
    h.connection.stop();
  });

  it("refreshes nothing once stopped", async () => {
    const h = await harness();
    h.connection.start();
    await connectLive(h);
    h.connection.stop();

    expect(h.connection.refresh()).toBe(false);
    await vi.advanceTimersByTimeAsync(RECONNECT_CAP_MS);
    expect(h.relay.tickets).toHaveLength(1);
    expect(h.relay.sockets).toHaveLength(1);
  });

  it("cuts a backoff wait short on resume", async () => {
    const h = await harness({ rand: () => 0.999 });
    h.connection.start();
    const first = await connectLive(h);
    first.drop(1006);
    await h.status("reconnecting");
    await vi.advanceTimersByTimeAsync(RECONNECT_BASE_MS - 1);
    expect(h.relay.tickets).toHaveLength(1);

    h.resume();
    await h.relay.socket(1);
    expect(h.relay.tickets).toHaveLength(2);
    // The cancelled wait doesn't start a third attempt when it would have come due.
    await vi.advanceTimersByTimeAsync(RECONNECT_BASE_MS * 4);
    expect(h.relay.tickets).toHaveLength(2);
    h.connection.stop();
  });

  it("gives up on an attempt whose relay never says hello", async () => {
    const h = await harness();
    h.connection.start();
    const socket = await h.relay.socket(0);
    socket.readyState = 1;

    await vi.advanceTimersByTimeAsync(45_000);
    await h.status("reconnecting");
    expect(socket.closedByClient).toBe(1000);
    h.connection.stop();
  });

  it("sends only the four-minute text ping as a keep-alive, never an application heartbeat", async () => {
    const h = await harness();
    h.connection.start();
    const socket = await connectLive(h);
    const before = socket.frames().length;

    await vi.advanceTimersByTimeAsync(4 * 60_000);
    expect(socket.sent.filter((data) => data === "ping")).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(4 * 60_000);
    expect(socket.sent.filter((data) => data === "ping")).toHaveLength(2);
    expect(socket.frames()).toHaveLength(before);
    h.connection.stop();
  });

  it("never logs the socket's address or its ticket", async () => {
    const h = await harness();
    h.connection.start();
    const first = await connectLive(h);
    first.drop(1006);
    await h.status("reconnecting");
    await vi.advanceTimersByTimeAsync(RECONNECT_BASE_MS);
    await h.relay.socket(1);
    h.connection.stop();

    const logged = vi
      .mocked(console.warn)
      .mock.calls.flat()
      .map((value) => String(value))
      .join("\n");
    expect(logged).not.toContain("ticket");
    expect(logged).not.toContain("wss://");
    expect(logged).not.toContain(RELAY.relayOrigin);
  });

  it("stops everything it started, and a retired attempt can't reach the store again", async () => {
    const h = await harness();
    h.connection.start();
    const socket = await connectLive(h);

    h.connection.stop();
    expect(socket.closedByClient).toBe(1000);
    expect(h.watching()).toBe(0);
    await vi.advanceTimersByTimeAsync(RECONNECT_CAP_MS);
    expect(h.relay.tickets).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("lets a write in flight at a stop finish, and refuses the stopped attempt everything after it", async () => {
    const store = new MemoryLocalStore();
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const insert = store.insertEvent.bind(store);
    let inserting!: () => void;
    const insertStarted = new Promise<void>((resolve) => {
      inserting = resolve;
    });
    store.insertEvent = async (event) => {
      inserting();
      await held;
      return insert(event);
    };
    const advance = vi.spyOn(store, "advanceCursor");
    const processed = vi.spyOn(store, "markEventProcessed");
    const h = await harness({ store });
    h.connection.start();
    const socket = await connectLive(h);
    advance.mockClear();

    socket.event(1);
    await insertStarted;
    h.connection.stop();
    release();
    await vi.advanceTimersByTimeAsync(0);
    for (let i = 0; i < 20; i += 1) await Promise.resolve();

    // The insert was already handed on, so it lands; nothing after it does.
    expect((await store.unprocessedEvents(10)).map((event) => event.seq)).toEqual([1]);
    expect(advance).not.toHaveBeenCalled();
    expect(processed).not.toHaveBeenCalled();
    expect(await store.getCursor()).toBe(0);
    expect(socket.frames().some((frame) => frame.t === "ack" && frame.seq === 1)).toBe(false);
  });

  it("keeps an event whose key reload failed for the next lifetime, rather than marking it done", async () => {
    let loads = 0;
    const real = new MemoryKeyStore();
    await real.save(identity);
    const keys: KeyStore = {
      load: async () => {
        loads += 1;
        if (loads > 1) throw new Error("keychain locked");
        return real.load();
      },
      save: (stored) => real.save(stored),
      clear: () => real.clear(),
    };
    const store = new MemoryLocalStore();
    const processed = vi.spyOn(store, "markEventProcessed");
    const h = await harness({ store, keys });
    h.connection.start();
    const socket = await connectLive(h);

    // A rotation past the epoch held makes the bridge reload its keys.
    socket.onmessage?.({
      data: JSON.stringify({
        t: "event",
        event: {
          protocol_version: 1,
          seq: 1,
          event_id: "evt_00000001",
          event_type: "device.key_rotated",
          occurred_at: new Date().toISOString(),
          question_id: null,
          question_revision: null,
          origin_device_id: null,
          data: { key_epoch: 2 },
        },
      }),
    });

    expect(await h.status("not-connected")).toEqual({ state: "not-connected", problem: "keys" });
    for (let i = 0; i < 20; i += 1) await Promise.resolve();
    expect(loads).toBe(2);
    expect(processed).not.toHaveBeenCalled();
    expect((await store.unprocessedEvents(10)).map((event) => event.seq)).toEqual([1]);
  });

  it("leaves the attempt that replaced one alone when the retired one's key reload fails late", async () => {
    let loads = 0;
    let failHeld!: () => void;
    const real = new MemoryKeyStore();
    await real.save(identity);
    const keys: KeyStore = {
      load: async () => {
        loads += 1;
        if (loads === 2) {
          await new Promise<void>((resolve) => {
            failHeld = resolve;
          });
          throw new Error("keychain timed out");
        }
        return real.load();
      },
      save: (stored) => real.save(stored),
      clear: () => real.clear(),
    };
    const h = await harness({ keys });
    h.connection.start();
    const first = await connectLive(h);
    first.onmessage?.({
      data: JSON.stringify({
        t: "event",
        event: {
          protocol_version: 1,
          seq: 1,
          event_id: "evt_00000001",
          event_type: "device.key_rotated",
          occurred_at: new Date().toISOString(),
          question_id: null,
          question_revision: null,
          origin_device_id: null,
          data: { key_epoch: 2 },
        },
      }),
    });
    await vi.waitUntil(() => loads === 2, { interval: 1 });

    first.drop(1006);
    await h.status("reconnecting");
    await vi.advanceTimersByTimeAsync(RECONNECT_BASE_MS);
    await connectLive(h, 1);

    failHeld();
    for (let i = 0; i < 20; i += 1) await Promise.resolve();
    expect(h.statuses.at(-1)).toEqual({ state: "connected" });
    expect(h.watching()).toBe(2);
    h.connection.stop();
  });

  it("opens no socket for a ticket that answers after a stop", async () => {
    let asked!: () => void;
    const askedForTicket = new Promise<void>((resolve) => {
      asked = resolve;
    });
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const h = await harness({
      wrapFetch: (fetchImpl) => async (url, init) => {
        asked();
        await held;
        return fetchImpl(url, init);
      },
    });
    h.connection.start();
    await askedForTicket;

    h.connection.stop();
    release();
    await vi.advanceTimersByTimeAsync(RECONNECT_CAP_MS);
    expect(h.relay.sockets).toHaveLength(0);
  });

  it("refuses a store that holds another relay identity's ledger", async () => {
    const store = new MemoryLocalStore();
    await store.setMeta(
      RELAY_BINDING_META_KEY,
      JSON.stringify([RELAY.relayOrigin, "inst_otherinst", RELAY.deviceId])
    );
    const h = await harness({ store });

    h.connection.start();
    expect(await h.status("not-connected")).toEqual({
      state: "not-connected",
      problem: "other-relay",
    });
    expect(h.relay.tickets).toHaveLength(0);
  });

  it("records which relay identity the store's ledger belongs to on the first connection", async () => {
    const h = await harness();
    h.connection.start();
    await h.relay.socket(0);
    expect(JSON.parse((await h.store.getMeta(RELAY_BINDING_META_KEY)) ?? "null")).toEqual([
      RELAY.relayOrigin,
      RELAY.installationId,
      RELAY.deviceId,
    ]);
    h.connection.stop();
  });

  it("shows a keys problem when there are no keys, or they are another relay's", async () => {
    const missing = await harness({ stored: null });
    missing.connection.start();
    expect(await missing.status("not-connected")).toEqual({
      state: "not-connected",
      problem: "keys",
    });

    const other = await harness({
      stored: await ownerIdentity({ ...RELAY, deviceId: "dev_otherdevice" }),
    });
    other.connection.start();
    expect(await other.status("not-connected")).toEqual({
      state: "not-connected",
      problem: "keys",
    });
    expect(missing.relay.tickets).toHaveLength(0);
    expect(other.relay.tickets).toHaveLength(0);
  });

  it("stops on a store that stopped taking writes, rather than acking what it couldn't keep", async () => {
    const store = new MemoryLocalStore();
    let faulted = false;
    const faulting = Object.assign(store, {
      isFaulted: () => faulted,
    });
    const insert = store.insertEvent.bind(store);
    store.insertEvent = async (event) => {
      if (faulted) throw new Error("writes refused");
      return insert(event);
    };
    const h = await harness({ store: faulting });
    h.connection.start();
    const socket = await connectLive(h);

    logWarn.mockClear();
    faulted = true;
    socket.event(1);
    expect(await h.status("not-connected")).toEqual({ state: "not-connected", problem: "storage" });
    expect(socket.frames().some((frame) => frame.t === "ack" && frame.seq === 1)).toBe(false);
    expect(socket.closedByClient).toBe(1000);
    // The halt is on disk, with why (#16605).
    expect(logWarn).toHaveBeenCalledWith(expect.stringContaining("relay connection stopped"), {
      state: "not-connected",
      problem: "storage",
    });
  });

  it("leaves the store's injection intents to delivery: a socket attempt reconciles none", async () => {
    const store = new MemoryLocalStore();
    // An attempt's own engine would take this, with no question behind it, as abandoned.
    await store.putIntent({
      injection_id: "inj_12345678",
      question_id: "q_12345678",
      answer_revision: 1,
      message_id: null,
      host_id: "host_12345678",
      pane_id: "pane-1",
      terminal_generation: 1,
      ownership_principal: "principal-1",
      agent_incarnation: "0",
      state: "intent",
      created_at: 1,
      updated_at: 1,
    });
    const h = await harness({ store });

    h.connection.start();
    await connectLive(h);
    expect(await store.getIntent("inj_12345678")).toMatchObject({ state: "intent" });
    await h.connection.stop();
  });

  /** Delivery deps that record their hold and watchers, with a pty host that answers. */
  function deliveryDeps() {
    const holds = { taken: 0, released: 0 };
    const watched = new Set<() => void>();
    return {
      holds,
      watched,
      deps: {
        hostId: () => "host_12345678",
        principalFor: () => null,
        getPtyClient: () => ({
          getLiveGeneration: () => null,
          isLiveGeneration: () => false,
          getTerminalAsync: async () => null,
        }),
        holdWakes: () => {
          holds.taken += 1;
          return {
            queueWake: () => {},
            cancelQueued: () => {},
            release: () => {
              holds.released += 1;
            },
          };
        },
        watchPanes: (onPane: (signal: "settled" | "appeared") => void) => {
          const entry = () => onPane("appeared");
          watched.add(entry);
          return () => watched.delete(entry);
        },
      } satisfies NonNullable<RelayConnectionOptions["delivery"]>,
    };
  }

  it("delivers for the connection's lifetime, while the relay is out of reach, and stops with it", async () => {
    const { holds, watched, deps } = deliveryDeps();
    const store = new MemoryLocalStore() as MemoryLocalStore & {
      hasPendingDelivery: () => Promise<boolean>;
    };
    store.hasPendingDelivery = vi.fn(async () => false);
    const h = await harness({ store, overrides: { delivery: deps } });
    h.relay.answerTicketsWith(
      () => new Response(JSON.stringify({ code: "unavailable", message: "down" }), { status: 503 })
    );

    h.connection.start();
    await h.status("reconnecting");
    await vi.waitFor(() => expect(store.hasPendingDelivery).toHaveBeenCalledTimes(1));
    expect(holds.taken).toBe(1);
    expect(watched.size).toBe(1);

    // No socket all the while, and delivery still looks every minute.
    await vi.advanceTimersByTimeAsync(3 * 60_000);
    expect(h.statuses.some((status) => status.state === "connected")).toBe(false);
    expect(store.hasPendingDelivery).toHaveBeenCalledTimes(4);
    expect(holds).toEqual({ taken: 1, released: 0 });

    await h.connection.stop();
    expect(holds).toEqual({ taken: 1, released: 1 });
    expect(watched.size).toBe(0);
    await vi.advanceTimersByTimeAsync(3 * 60_000);
    expect(store.hasPendingDelivery).toHaveBeenCalledTimes(4);
  });

  it("gives every socket attempt delivery's lock and runs its own delivery stopped", async () => {
    const bridges: DecisionsBridge[] = [];
    const start = DecisionsBridge.prototype.start;
    vi.spyOn(DecisionsBridge.prototype, "start").mockImplementation(function (
      this: DecisionsBridge,
      ...args: Parameters<DecisionsBridge["start"]>
    ) {
      bridges.push(this);
      return start.apply(this, args);
    });
    let source: QuestionSource | null = null;
    const h = await harness({
      overrides: { delivery: deliveryDeps().deps, onQuestionsReady: (ready) => (source = ready) },
    });

    h.connection.start();
    const first = await connectLive(h);
    first.drop(1006);
    await h.status("reconnecting");
    await vi.advanceTimersByTimeAsync(RECONNECT_BASE_MS);
    await connectLive(h, 1);

    expect(bridges).toHaveLength(2);
    expect(bridges[0].ctx.lock).toBe(bridges[1].ctx.lock);
    // The same lock delivery holds, handed to agents' questions before either ran (#17101).
    expect(h.connection.getDelivery()!.lock).toBe(bridges[0].ctx.lock);
    expect((source as unknown as QuestionSource).lock).toBe(bridges[0].ctx.lock);
    // A reopen waits on the closure notice the lifetime's engine is typing, never the attempt's own.
    const writing = Promise.resolve();
    const closureWrite = vi
      .spyOn(h.connection.getDelivery()!, "closureWrite")
      .mockImplementation((id) => (id === "q1" ? writing : null));
    for (const bridge of bridges) expect(bridge.delivery.closureWrite("q1")).toBe(writing);
    expect(closureWrite).toHaveBeenCalledTimes(bridges.length);
    // Started, each attempt's own engine still types nothing: draining it reads no row (#17939).
    const listed = vi.spyOn(h.store, "listQuestions");
    for (const bridge of bridges) {
      expect(await bridge.delivery.drain()).toEqual({
        delivered: 0,
        deferred: 0,
        needsAttention: 0,
        uncertain: 0,
      });
    }
    expect(listed).not.toHaveBeenCalled();
    await h.connection.stop();
  });

  it.each([
    ["asked for, with delivery", { advisoryDeadlines: true, delivery: true }, true],
    ["asked for, without delivery", { advisoryDeadlines: true, delivery: false }, false],
    ["not asked for, with delivery", { advisoryDeadlines: false, delivery: true }, false],
    ["left out, with delivery", { delivery: true }, false],
  ])(
    "gives every bridge over the store advisoryDeadlines only when the lifetime delivers outcomes: %s (#17940)",
    async (_label, options, expected) => {
      const bridges: DecisionsBridge[] = [];
      const start = DecisionsBridge.prototype.start;
      vi.spyOn(DecisionsBridge.prototype, "start").mockImplementation(function (
        this: DecisionsBridge,
        ...args: Parameters<DecisionsBridge["start"]>
      ) {
        bridges.push(this);
        return start.apply(this, args);
      });
      let source: QuestionSource | null = null;
      const h = await harness({
        overrides: {
          ...("advisoryDeadlines" in options
            ? { advisoryDeadlines: options.advisoryDeadlines }
            : {}),
          ...(options.delivery ? { delivery: deliveryDeps().deps } : {}),
          onQuestionsReady: (ready) => (source = ready),
        },
      });
      try {
        h.connection.start();
        const first = await connectLive(h);
        // A reconnect's attempt is given it as the first was.
        first.drop(1006);
        await h.status("reconnecting");
        await vi.advanceTimersByTimeAsync(RECONNECT_BASE_MS);
        await connectLive(h, 1);

        const ready = source as unknown as QuestionSource;
        expect(ready.advisoryDeadlines).toBe(expected);
        expect(bridges).toHaveLength(2);
        expect(bridges.map(hostSupport)).toEqual([expected, expected]);
        // The bridge agents ask on between attempts reads a question as the attempts do.
        expect(hostSupport(new QuestionBridge({ source: ready, isCurrent: () => true }))).toBe(
          expected
        );
        const delivery = h.connection.getDelivery() as unknown as {
          owner: DecisionsBridge;
        } | null;
        if (options.delivery) {
          expect(hostSupport(delivery!.owner)).toBe(expected);
          // Delivery decides whether a plan may go ahead under the policy agents ask under.
          expect(delivery!.owner.ctx.policy).toBe(bridges[0].ctx.policy);
        } else {
          expect(delivery).toBeNull();
        }
      } finally {
        await h.connection.stop();
      }
    }
  );

  it("signs no advice on an attempt when the lifetime's delivery couldn't start (#17940)", async () => {
    const bridges: DecisionsBridge[] = [];
    const start = DecisionsBridge.prototype.start;
    vi.spyOn(DecisionsBridge.prototype, "start").mockImplementation(function (
      this: DecisionsBridge,
      ...args: Parameters<DecisionsBridge["start"]>
    ) {
      bridges.push(this);
      return start.apply(this, args);
    });
    // Delivery asks for its way to the relay first; the attempt's own request gets through.
    relayRequestFailures.left = 1;
    const h = await harness({
      overrides: { advisoryDeadlines: true, delivery: deliveryDeps().deps },
    });
    try {
      h.connection.start();
      await connectLive(h);
      expect(relayRequestFailures.left).toBe(0);
      expect(h.connection.getDelivery()).toBeNull();
      expect(bridges.map(hostSupport)).toEqual([false]);
    } finally {
      await h.connection.stop();
    }
  });

  it("picks up from the cursor the app database kept, after the app starts again", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "daintree-relay-connection-"));
    const migrations = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      "../../persistence/migrations"
    );
    const dbPath = path.join(dir, "app.db");
    try {
      const firstDb = openDb(dbPath, migrations).sqlite;
      const firstStore = new DaintreeLocalStore(firstDb);
      const first = await harness({ store: firstStore });
      first.connection.start();
      const socket = await connectLive(first);
      socket.event(1);
      socket.event(2);
      await socket.waitFor((frame) => frame.t === "ack" && frame.seq === 2);
      first.connection.stop();
      await firstStore.close();
      firstDb.close();

      const secondDb = openDb(dbPath, migrations).sqlite;
      const secondStore = new DaintreeLocalStore(secondDb);
      const second = await harness({ store: secondStore });
      second.connection.start();
      const next = await second.relay.socket(0);
      next.accept(2);
      expect(await next.waitFor((frame) => frame.t === "sync")).toEqual({ t: "sync", after: 2 });
      second.connection.stop();
      await secondStore.close();
      secondDb.close();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
  it("starts on a store a 0.8.0 bridge left with a reopened question open, stamping it and running 0.9.0's repair (#17939)", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "daintree-relay-migrated-"));
    const migrations = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      "../../persistence/migrations"
    );
    try {
      const sqlite = openDb(path.join(dir, "app.db"), migrations).sqlite;
      const store = new DaintreeLocalStore(sqlite);
      const deadline = "2026-12-01T00:00:00.000Z";
      // As 0.8.0 left it: reopened into round 1, with no format marked and no repair recorded.
      await store.commitNewQuestion(
        {
          question_id: "q_reopened_0001",
          alias: await store.nextAlias(),
          origin: QUESTION_ORIGIN,
          requirement: "human-required",
          question_revision: 1,
          remote_event_seq: 4,
          origin_created_at: "2026-11-01T00:00:00.000Z",
          expires_at: deadline,
          local_status: "open",
          delivery_status: "relay-queued",
          last_injection_id: null,
          last_attempt_at: null,
          agent_resume_strategy: null,
          error_code: null,
          content_sealed: '{"sealed":1}',
          answers_json: "[]",
          messages_json: "[]",
          history_only: false,
          delivered_revision: 0,
          attachment_digests: [],
        },
        {
          id: "o1",
          kind: "create",
          question_id: "q_reopened_0001",
          payload: {},
          attempts: 0,
          next_attempt_at: 0,
          created_at: 0,
          last_error: null,
        }
      );
      await store.deleteOutbox("o1");
      expect(await store.getMeta(STORE_FORMAT_KEY)).toBeNull();
      const history = vi.spyOn(store, "processedEventsOfType");

      const h = await harness({ store });
      h.connection.start();
      const socket = await connectLive(h);
      socket.event(1);
      await socket.waitFor((frame) => frame.t === "ack" && frame.seq === 1);

      await vi.waitFor(async () => expect(await store.getMeta("rounds-reconciled")).not.toBeNull());
      expect(history).toHaveBeenCalledWith("decision.reopened");
      expect(await store.getMeta(STORE_FORMAT_KEY)).toBe(String(STORE_FORMAT));
      expect(await store.getQuestion("q_reopened_0001")).toMatchObject({
        local_status: "open",
        question_revision: 1,
        expires_at: deadline,
      });
      h.connection.stop();
      await store.close();
      sqlite.close();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("uploads, after the app starts again, what an upload cut short left spooled, from the ciphertext alone", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "daintree-relay-attachments-"));
    const migrations = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      "../../persistence/migrations"
    );
    const dbPath = path.join(dir, "app.db");
    const spoolDir = path.join(dir, "spool");
    const worktree = path.join(dir, "worktree");
    fs.mkdirSync(worktree);
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
    fs.writeFileSync(path.join(worktree, "before.png"), png);
    fs.writeFileSync(path.join(worktree, "after.png"), Buffer.concat([png, png]));
    const origin = { ...QUESTION_ORIGIN, worktree_id: worktree, worktree_root: worktree };
    const spooled = () => (fs.existsSync(spoolDir) ? fs.readdirSync(spoolDir).sort() : []);
    try {
      const firstDb = openDb(dbPath, migrations).sqlite;
      const firstStore = new DaintreeLocalStore(firstDb);
      const firstAttachments = new DecisionsAttachments({
        dir: spoolDir,
        referenced: () => firstStore.referencedAttachmentIds(),
      });
      let firstSource: QuestionSource | null = null;
      let uploadsTried = 0;
      let finishLateUpload!: () => void;
      const lateUpload = new Promise<void>((resolve) => (finishLateUpload = resolve));
      const first = await harness({
        store: firstStore,
        overrides: {
          attachments: firstAttachments,
          onQuestionsReady: (ready) => (firstSource = ready),
        },
        // The relay takes the first image; the app quits while the second is still going up.
        wrapFetch: (fetchImpl) => async (url, init) => {
          if (init.method === "PUT" && ++uploadsTried === 2) await lateUpload;
          return fetchImpl(url, init);
        },
      });
      first.connection.start();
      await connectLive(first);
      const ready = firstSource as unknown as QuestionSource;
      expect(ready.attachments).toBe(firstAttachments);
      const asked = await new QuestionBridge({
        source: ready,
        isCurrent: () => true,
      }).registerQuestion({
        origin,
        input: {
          question: "Which one?",
          attachments: [{ local_resource_id: "before.png" }, { local_resource_id: "after.png" }],
        },
      });
      await vi.waitFor(() => expect(uploadsTried).toBe(2));
      await vi.waitFor(async () => {
        const [create] = await firstStore.outboxFor(asked.questionId);
        expect((create?.payload as { uploaded: string[] }).uploaded).toHaveLength(1);
      });
      const [uploadedFirst] = first.relay.uploads;
      expect(first.relay.questions).toEqual([]);
      const pending = spooled();
      expect(pending).toHaveLength(2);
      // Quit mid-upload: the second image's request is still out.
      void first.connection.stop();
      await firstAttachments.close();
      await firstStore.close();
      firstDb.close();

      // The screenshots are gone: only the spooled ciphertext can publish the question now.
      fs.rmSync(worktree, { recursive: true });

      const secondDb = openDb(dbPath, migrations).sqlite;
      const secondStore = new DaintreeLocalStore(secondDb);
      const secondAttachments = new DecisionsAttachments({
        dir: spoolDir,
        referenced: () => secondStore.referencedAttachmentIds(),
      });
      const second = await harness({
        store: secondStore,
        overrides: { attachments: secondAttachments },
      });
      second.connection.start();
      await connectLive(second);
      await vi.waitFor(() => expect(second.relay.questions).toHaveLength(1));
      expect(second.relay.uploads).toHaveLength(1);
      expect(second.relay.uploads[0]).not.toBe(uploadedFirst);
      expect(pending).toContain(second.relay.uploads[0]);
      await vi.waitFor(async () =>
        expect((await secondStore.getQuestion(asked.questionId))?.local_status).toBe("open")
      );
      expect(spooled()).toEqual([]);
      expect(await secondStore.outboxFor(asked.questionId)).toEqual([]);

      // The interrupted upload finishing late changes nothing the restart did.
      finishLateUpload();
      for (let i = 0; i < 20; i++) await new Promise((resolve) => setImmediate(resolve));
      expect(first.relay.questions).toEqual([]);
      expect((await secondStore.getQuestion(asked.questionId))?.local_status).toBe("open");
      expect(await secondStore.outboxFor(asked.questionId)).toEqual([]);
      expect(spooled()).toEqual([]);
      second.connection.stop();
      await secondAttachments.close();
      await secondStore.close();
      secondDb.close();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("hands questions a source once the identity loads, before any request, with a bridge only while an attempt runs", async () => {
    let source: QuestionSource | null = null;
    let atReady: { tickets: number; live: unknown } | null = null;
    const h = await harness({
      overrides: {
        onQuestionsReady: (ready) => {
          source = ready;
          atReady = { tickets: h.relay.tickets.length, live: ready.live() };
        },
      },
    });
    h.connection.start();
    await vi.waitFor(() => expect(source).not.toBeNull());
    const ready = source as unknown as QuestionSource;
    expect(atReady).toEqual({ tickets: 0, live: null });
    expect(ready.identity()?.config.deviceId).toBe(RELAY.deviceId);

    const socket = await connectLive(h);
    const first = ready.live();
    expect(first).not.toBeNull();
    expect(first?.state).toBe("running");

    socket.drop(1006);
    await h.status("reconnecting");
    expect(ready.live()).toBeNull();
    expect(ready.identity()).not.toBeNull();

    await vi.advanceTimersByTimeAsync(RECONNECT_BASE_MS);
    await connectLive(h, 1);
    expect(ready.live()).not.toBeNull();
    expect(ready.live()).not.toBe(first);

    h.connection.stop();
    expect(ready.live()).toBeNull();
    expect(ready.identity()).toBeNull();
    await expect(ready.store.listQuestions()).rejects.toThrow();
  });

  it("asks locally while an attempt is still starting, and publishes once it is live", async () => {
    // The attempt's bridge seals what an earlier run stored, reading every
    // question, before it runs; until it has, the question goes to the store
    // alone. (Its store view shows it no injection intents to reconcile.)
    let startup!: () => void;
    const started = new Promise<void>((resolve) => {
      startup = resolve;
    });
    let recovering = false;
    class StartingStore extends MemoryLocalStore {
      override async listQuestions() {
        if (!recovering) {
          recovering = true;
          await started;
        }
        return super.listQuestions();
      }
    }
    const store = new StartingStore();
    let source: QuestionSource | null = null;
    const h = await harness({
      store,
      overrides: { onQuestionsReady: (ready) => (source = ready) },
    });
    h.connection.start();
    await vi.waitFor(() => expect(recovering).toBe(true));
    const ready = source as unknown as QuestionSource;
    const bridge = new QuestionBridge({ source: ready, isCurrent: () => true });

    expect(ready.live()).toBeNull();
    const asked = await bridge.registerQuestion({
      origin: QUESTION_ORIGIN,
      input: { question: "Asked offline?" },
    });
    expect(ready.live()).toBeNull();
    expect(h.relay.questions).toEqual([]);
    expect((await store.getQuestion(asked.questionId))?.local_status).toBe("queued");

    startup();
    await connectLive(h);
    expect(ready.live()).not.toBeNull();
    await vi.waitFor(() => expect(h.relay.questions).toHaveLength(1));
    await vi.waitFor(async () =>
      expect((await store.getQuestion(asked.questionId))?.local_status).toBe("open")
    );
    h.connection.stop();
  });

  it("publishes a live attempt's question only once it and its origin are committed", async () => {
    let commit!: () => void;
    const committed = new Promise<void>((resolve) => {
      commit = resolve;
    });
    class SlowStore extends MemoryLocalStore {
      override async commitNewQuestion(...args: Parameters<MemoryLocalStore["commitNewQuestion"]>) {
        await committed;
        return super.commitNewQuestion(...args);
      }
    }
    const store = new SlowStore();
    const seenAtPublish: unknown[] = [];
    let source: QuestionSource | null = null;
    const h = await harness({
      store,
      overrides: { onQuestionsReady: (ready) => (source = ready) },
      wrapFetch: (fetchImpl) => async (url, init) => {
        if (new URL(url).pathname === "/api/v1/questions") {
          seenAtPublish.push(...(await store.listQuestions()).map((row) => row.origin));
        }
        return fetchImpl(url, init);
      },
    });
    h.connection.start();
    await connectLive(h);
    const ready = source as unknown as QuestionSource;
    expect(ready.live()).not.toBeNull();
    const bridge = new QuestionBridge({ source: ready, isCurrent: () => true });

    const asking = bridge.registerQuestion({
      origin: QUESTION_ORIGIN,
      input: { question: "Live?" },
    });
    await vi.advanceTimersByTimeAsync(50);
    expect(h.relay.questions).toEqual([]);
    commit();
    await asking;
    await vi.waitFor(() => expect(h.relay.questions).toHaveLength(1));
    expect(seenAtPublish).toEqual([QUESTION_ORIGIN]);
    h.connection.stop();
  });

  it("gives questions no source when the identity can't be loaded", async () => {
    const ready = vi.fn();
    const h = await harness({ stored: null, overrides: { onQuestionsReady: ready } });
    h.connection.start();
    await h.status("not-connected");
    expect(ready).not.toHaveBeenCalled();
  });

  describe("key rotations (#16010)", () => {
    /** The owner identity with epoch 2 staged for a rotation the relay may not have taken. */
    function withPendingRotation(): StoredIdentity {
      return {
        ...identity,
        epochs: [...identity.epochs, { epoch: 2, raw: bytesToBase64Url(generateEpochKeyBytes()) }],
        daintreePendingRotation: { epoch: 2, revoke: null },
      } as StoredIdentity;
    }

    function deviceEvent(socket: FakeSocket, seq: number, type: string, data: object): void {
      socket.onmessage?.({
        data: JSON.stringify({
          t: "event",
          event: {
            protocol_version: 1,
            seq,
            event_id: `evt_${String(seq).padStart(8, "0")}`,
            event_type: type,
            occurred_at: new Date().toISOString(),
            question_id: null,
            question_revision: null,
            origin_device_id: null,
            data,
          },
        }),
      });
    }

    it("finishes a rotation a crash left pending before it opens a socket", async () => {
      const keys = new MemoryKeyStore();
      await keys.save(withPendingRotation());
      const onDevicesChanged = vi.fn();
      const devicesRead = vi.fn();
      let answerDevices!: () => void;
      const devicesAnswered = new Promise<void>((resolve) => (answerDevices = resolve));
      const h = await harness({
        keys,
        overrides: { onDevicesChanged },
        wrapFetch: (inner) => async (url, init) => {
          if (new URL(url).pathname === "/api/v1/devices") {
            devicesRead();
            await devicesAnswered;
            // The relay took the rotation before the crash.
            return new Response(JSON.stringify({ key_epoch: 2, devices: [] }), {
              status: 200,
              headers: { "content-type": "application/json" },
            });
          }
          return inner(url, init);
        },
      });

      h.connection.start();
      await vi.waitFor(() => expect(devicesRead).toHaveBeenCalledOnce());
      for (let i = 0; i < 20; i += 1) await Promise.resolve();
      // No ticket, so no socket, until the pending key is settled.
      expect(h.relay.tickets).toHaveLength(0);
      answerDevices();
      await connectLive(h);

      expect(devicesRead).toHaveBeenCalledOnce();
      const stored = await keys.load();
      expect(stored?.currentEpoch).toBe(2);
      expect(pendingRotationOf(stored!)).toBeNull();
      expect(onDevicesChanged).toHaveBeenCalledOnce();
      h.connection.stop();
    });

    it("makes a pending key current when the ledger confirms its epoch, before the bridge reloads it", async () => {
      const real = new MemoryKeyStore();
      await real.save(withPendingRotation());
      let holdSaves = false;
      let releaseSave: (() => void) | null = null;
      const keys: KeyStore = {
        load: () => real.load(),
        save: async (stored) => {
          if (holdSaves) await new Promise<void>((resolve) => (releaseSave = resolve));
          await real.save(stored);
        },
        clear: () => real.clear(),
      };
      const onDevicesChanged = vi.fn();
      // The relay refuses the device list read (404), so the key is still pending once live.
      const h = await harness({ keys, overrides: { onDevicesChanged } });
      h.connection.start();
      const socket = await connectLive(h);
      expect((await real.load())?.currentEpoch).toBe(1);
      const bridgeEpoch = () =>
        (
          h.connection as unknown as {
            current: { bridge: { ctx: { identity: { currentEpoch: number } } } | null } | null;
          }
        ).current?.bridge?.ctx.identity.currentEpoch;

      holdSaves = true;
      deviceEvent(socket, 1, "device.key_rotated", { key_epoch: 2 });
      // The bridge applies the event only once the key it will reload is current.
      await vi.waitFor(() => expect(releaseSave).not.toBeNull());
      for (let i = 0; i < 20; i += 1) await Promise.resolve();
      expect(bridgeEpoch()).toBe(1);
      releaseSave!();

      await vi.waitFor(() => expect(bridgeEpoch()).toBe(2));
      expect((await real.load())?.currentEpoch).toBe(2);
      expect(pendingRotationOf((await real.load())!)).toBeNull();
      await vi.waitFor(() => expect(onDevicesChanged).toHaveBeenCalledOnce());
      h.connection.stop();
    });

    it("says the devices changed on a new device event, reading no keys when nothing is pending", async () => {
      let loads = 0;
      const real = new MemoryKeyStore();
      await real.save(identity);
      const keys: KeyStore = {
        load: () => {
          loads += 1;
          return real.load();
        },
        save: (stored) => real.save(stored),
        clear: () => real.clear(),
      };
      const onDevicesChanged = vi.fn();
      const h = await harness({ keys, overrides: { onDevicesChanged } });
      h.connection.start();
      const socket = await connectLive(h);
      const loadsLive = loads;

      // A revocation at the epoch already held: nothing to reload or make current.
      deviceEvent(socket, 1, "device.revoked", { device_id: "dev_phone_1", key_epoch: 1 });
      await socket.waitFor((frame) => frame.t === "ack" && frame.seq === 1);
      // The same event again is a duplicate: not news.
      deviceEvent(socket, 1, "device.revoked", { device_id: "dev_phone_1", key_epoch: 1 });
      deviceEvent(socket, 2, "delivery.received", {});
      await socket.waitFor((frame) => frame.t === "ack" && frame.seq === 2);

      expect(onDevicesChanged).toHaveBeenCalledOnce();
      expect(loads).toBe(loadsLive);
      h.connection.stop();
    });
  });
});

describe("get_involvement over a connection (#17228)", () => {
  const PHONE = "dev_phone_1234";
  /** Runs whether or not the test got that far: held reads released, connections stopped. */
  const teardown: Array<() => unknown> = [];

  afterEach(async () => {
    for (const step of teardown.splice(0)) await step();
  });

  function deviceInfo(cert: DeviceCert) {
    return {
      device_id: cert.device_id,
      role: cert.role,
      label: cert.label,
      created_at: new Date().toISOString(),
      revoked_at: null,
      last_seen_at: null,
      last_ack_seq: 0,
      cert,
      push_enabled: false,
    };
  }

  /**
   * A relay holding a phone's involvement preference: its device directory
   * (this owner and one phone, certified by the owner) and the latest signed
   * record, which `setOnPhone` replaces as the phone would. Every ticket's
   * declared features are kept, and `holdReads` keeps the preference's reads
   * unanswered until released.
   */
  async function relayWithPreference() {
    const keys = new MemoryKeyStore();
    await keys.save(identity);
    const owner = await loadIdentity(keys);
    const phone: DeviceKeys = await generateDeviceKeys(false);
    const certFor = async (deviceId: string, role: "owner-desktop" | "phone", of: DeviceKeys) =>
      issueDeviceCert({
        issuerDeviceId: RELAY.deviceId,
        issuerSigningKey: owner.keys.signing.privateKey,
        installationId: RELAY.installationId,
        deviceId,
        role,
        label: role,
        signingPub: await exportPublicKey(of.signing.publicKey),
        exchangePub: await exportPublicKey(of.exchange.publicKey),
      });
    const devices = {
      key_epoch: 1,
      owner_device_id: RELAY.deviceId,
      devices: [
        deviceInfo(await certFor(RELAY.deviceId, "owner-desktop", owner.keys)),
        deviceInfo(await certFor(PHONE, "phone", phone)),
      ],
    };
    let preference: InvolvementRecord | null = null;
    let held: Promise<void> = Promise.resolve();
    const declared: unknown[] = [];
    /** Every request Daintree made, as `METHOD /path`. */
    const requests: string[] = [];
    /** What `/info` advertises; null answers it as the stock fake does, with a 404. */
    let advertised: string[] | null = null;
    const json = (body: unknown) =>
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    const wrapFetch =
      (fetchImpl: RelayFetch): RelayFetch =>
      async (url, init) => {
        const { pathname } = new URL(url);
        requests.push(`${init.method ?? "GET"} ${pathname}`);
        if (pathname === "/api/v1/info" && advertised !== null) {
          return json({
            name: "daintree-decisions",
            protocol_min: 1,
            protocol_max: 1,
            worker_version: "0.7.0",
            claimed: true,
            claim_configured: true,
            voice: { xai: false, anthropic: false, openai: false },
            features: advertised,
          });
        }
        if (pathname === "/api/v1/devices") return json(devices);
        if (pathname === "/api/v1/involvement" && (init.method ?? "GET") === "GET") {
          await held;
          return json({
            preference,
            received_at: preference ? preference.created_at : null,
          });
        }
        if (pathname === "/api/v1/socket-ticket") {
          declared.push((JSON.parse(String(init.body)) as { features?: unknown }).features);
        }
        return fetchImpl(url, init);
      };
    return {
      wrapFetch,
      declared,
      requests,
      phone,
      advertise(features: string[]): void {
        advertised = features;
      },
      serve(record: InvolvementRecord | null): void {
        preference = record;
      },
      holdReads(): () => void {
        let release!: () => void;
        held = new Promise((resolve) => {
          release = resolve;
        });
        return release;
      },
      async setOnPhone(
        revision: number,
        normalMode: InvolvementRecord["normal_mode"],
        consultCount: number
      ) {
        preference = await buildSignedInvolvement({
          installationId: RELAY.installationId,
          signerDeviceId: PHONE,
          signingKey: phone.signing.privateKey,
          revision,
          normalMode,
          consultCount,
          override: null,
        });
      },
    };
  }

  /**
   * A record as a 0.7.0 phone signs it: the fields that release builds,
   * written out here so no 0.8.0 builder shapes it.
   */
  async function signedOn070Phone(
    phone: DeviceKeys,
    revision: number,
    override: InvolvementRecord["override"]
  ): Promise<InvolvementRecord> {
    return (await signObject(phone.signing.privateKey, {
      v: 1,
      type: "involvement.preference",
      installation_id: RELAY.installationId,
      revision,
      normal_mode: "recommend",
      consult_count: 3,
      override,
      created_at: new Date().toISOString(),
      signer_device_id: PHONE,
    })) as InvolvementRecord;
  }

  /** A 0.7.0 phone's own reading of a record: `ready` only for one it would have set itself. */
  function readOn070Phone(phone: DeviceKeys, record: InvolvementRecord) {
    return legacyPhoneInvolvementRead(
      LEGACY_PHONE_INVOLVEMENT_START,
      { preference: record, received_at: record.created_at },
      {
        installationId: RELAY.installationId,
        signer: (deviceId) =>
          deviceId === PHONE
            ? {
                role: "phone",
                revoked: false,
                verify: (r) => verifyObject(phone.signing.publicKey, r),
              }
            : null,
      }
    );
  }

  /** The relay's hint that the preference changed: question-free, it only says to read again. */
  function involvementHint(socket: FakeSocket, seq: number): void {
    socket.onmessage?.({
      data: JSON.stringify({
        t: "event",
        event: {
          protocol_version: 1,
          seq,
          event_id: `evt_${String(seq).padStart(8, "0")}`,
          event_type: "involvement.updated",
          occurred_at: new Date().toISOString(),
          question_id: null,
          question_revision: null,
          origin_device_id: null,
          data: {},
        },
      }),
    });
  }

  it("serves the live attempt's preference, a phone's change without a relaunch, and the verified copy between attempts", async () => {
    const relay = await relayWithPreference();
    await relay.setOnPhone(1, "involve-early", 1);
    const release = relay.holdReads();
    let source: QuestionSource | null = null;
    const h = await harness({
      wrapFetch: relay.wrapFetch,
      overrides: { onQuestionsReady: (ready) => (source = ready) },
    });
    teardown.push(release, () => h.connection.stop());
    h.connection.start();
    await vi.waitFor(() => expect(source).not.toBeNull());
    // One bridge for the agent's whole run, as the route holds it.
    const bridge = new QuestionBridge({
      source: source as unknown as QuestionSource,
      isCurrent: () => true,
    });

    // Before the relay has answered a read, there is no preference.
    await expect(bridge.getInvolvement()).resolves.toMatchObject({
      status: "unavailable",
      reason: "not-synced",
      stale: true,
    });

    release();
    const socket = await connectLive(h);
    expect(relay.declared[0]).toContain("involvement-v1");
    await vi.waitFor(async () =>
      expect(await bridge.getInvolvement()).toMatchObject({
        status: "available",
        mode: "involve-early",
        revision: 1,
        stale: false,
      })
    );

    // The person changes it on their phone; the relay hints, and the same bridge reads the new one.
    await relay.setOnPhone(2, "recommend", 2);
    involvementHint(socket, 1);
    await socket.waitFor((frame) => frame.t === "ack" && frame.seq === 1);
    await vi.waitFor(async () =>
      expect(await bridge.getInvolvement()).toMatchObject({
        status: "available",
        mode: "recommend",
        consultCount: 2,
        revision: 2,
        stale: false,
      })
    );

    // Between attempts: the copy the last attempt verified, as possibly out of date.
    socket.drop(1006);
    await h.status("reconnecting");
    expect((source as unknown as QuestionSource).live()).toBeNull();
    await expect(bridge.getInvolvement()).resolves.toMatchObject({
      status: "available",
      mode: "recommend",
      revision: 2,
      stale: true,
    });
  });

  it("keeps a 0.6.0 relay's connection, which serves no preference, and says so", async () => {
    // The stock fake relay answers `/involvement` with a 404, as a relay from before 0.7.0 does.
    let source: QuestionSource | null = null;
    const h = await harness({ overrides: { onQuestionsReady: (ready) => (source = ready) } });
    teardown.push(() => h.connection.stop());
    h.connection.start();
    await connectLive(h);
    const bridge = new QuestionBridge({
      source: source as unknown as QuestionSource,
      isCurrent: () => true,
    });

    await vi.waitFor(async () =>
      expect(await bridge.getInvolvement()).toMatchObject({
        status: "unavailable",
        reason: "unsupported",
        stale: false,
      })
    );
    expect(h.statuses.at(-1)?.state).toBe("connected");
    const asked = await bridge.registerQuestion({
      origin: QUESTION_ORIGIN,
      input: { question: "Still asking?" },
    });
    await vi.waitFor(() => expect(h.relay.questions).toHaveLength(1));
    expect(asked.status).toBe("queued");
  });

  it("serves a 0.7.0 phone's preference through a 0.7.0 relay as agents read it before 0.8.0, and asks that relay for nothing 0.8.0 added (#17433, #17239)", async () => {
    const relay = await relayWithPreference();
    // Every feature a 0.7.0 relay can advertise; none of 0.8.0's.
    const releasedBy070 = [
      "thread-messages-v1",
      "phone-images-v1",
      "pane-snapshots-v1",
      "owner-desktop-answers-v1",
      "involvement-v1",
      "person-declines-v1",
    ];
    relay.advertise(releasedBy070);
    // 0.8.0's host APIs, on every bridge the connection makes: none of them is Daintree's to call yet.
    const hostApis = (
      ["reportPresence", "setInvolvementPreference", "declineQuestion", "sendFollowUp"] as const
    ).map((name) => vi.spyOn(DecisionsBridge.prototype, name));
    const until = new Date(Date.now() + 60 * 60_000).toISOString();
    const record = await signedOn070Phone(relay.phone, 4, { mode: "involve-early", until });
    await expect(readOn070Phone(relay.phone, record)).resolves.toMatchObject({
      status: "ready",
      revision: 4,
      problem: null,
    });
    relay.serve(record);
    let source: QuestionSource | null = null;
    const h = await harness({
      wrapFetch: relay.wrapFetch,
      overrides: { onQuestionsReady: (ready) => (source = ready) },
    });
    teardown.push(() => h.connection.stop());
    h.connection.start();
    await connectLive(h);
    const bridge = new QuestionBridge({
      source: source as unknown as QuestionSource,
      isCurrent: () => true,
    });

    await vi.waitFor(async () =>
      expect(await bridge.getInvolvement()).toMatchObject({ status: "available", stale: false })
    );
    const view = await bridge.getInvolvement();
    // The fields an agent read on 0.7.0, and no more: where it was set is the person's own display.
    expect(view).toEqual({
      status: "available",
      mode: "involve-early",
      normalMode: "recommend",
      consultCount: 3,
      revision: 4,
      overrideActive: true,
      until,
      setAt: record.created_at,
      lastSyncedAt: expect.any(String),
      stale: false,
    });

    await bridge.registerQuestion({
      origin: QUESTION_ORIGIN,
      input: { question: "Still asking?" },
    });
    await vi.waitFor(() => expect(h.relay.questions).toHaveLength(1));
    expect(h.statuses.at(-1)?.state).toBe("connected");
    expect(relay.declared.length).toBeGreaterThan(0);
    // Only the owner desktop's decline (#17239) and follow-ups (#17238) are declared beyond 0.7.0's:
    // a relay ignores a token it doesn't know, and nothing is declined or followed up unless the
    // person dismisses a question or writes on one here.
    const declarable = [...releasedBy070, "owner-desktop-declines-v1", "owner-desktop-messages-v1"];
    for (const features of relay.declared) {
      for (const feature of (features as string[] | undefined) ?? []) {
        expect(declarable).toContain(feature);
      }
    }
    for (const api of hostApis) expect(api).not.toHaveBeenCalled();
    expect(relay.requests).not.toContain("PUT /api/v1/presence");
    expect(relay.requests).not.toContain("PUT /api/v1/involvement");
  });

  // Every feature a 0.8.0 relay can advertise, and the two 0.9.0 adds.
  const releasedBy080 = [
    "thread-messages-v1",
    "phone-images-v1",
    "pane-snapshots-v1",
    "owner-desktop-answers-v1",
    "involvement-v1",
    "person-declines-v1",
    "owner-desktop-messages-v1",
    "owner-desktop-declines-v1",
    "presence-v1",
  ];
  it.each([
    ["a 0.8.0 relay", releasedBy080],
    ["a 0.9.0 relay", [...releasedBy080, "advisory-deadlines-v1", "agent-stopped-push-v1"]],
  ])(
    "asks through %s as it did on 0.8.0, declaring and asking for nothing 0.9.0 added (#17939)",
    async (_label, advertised) => {
      const relay = await relayWithPreference();
      relay.advertise(advertised);
      const created: Array<{ question: { envelope: { aad: Record<string, unknown> } } }> = [];
      const wrapFetch =
        (fetchImpl: RelayFetch): RelayFetch =>
        (url, init) => {
          if (new URL(url).pathname === "/api/v1/questions" && init.method === "POST") {
            created.push(JSON.parse(String(init.body)) as (typeof created)[number]);
          }
          return relay.wrapFetch(fetchImpl)(url, init);
        };
      const push = vi.spyOn(DecisionsBridge.prototype, "requestAgentStoppedPush");
      let source: QuestionSource | null = null;
      const h = await harness({
        wrapFetch,
        overrides: { onQuestionsReady: (ready) => (source = ready) },
      });
      teardown.push(() => h.connection.stop());
      h.connection.start();
      await connectLive(h);
      const bridge = new QuestionBridge({
        source: source as unknown as QuestionSource,
        isCurrent: () => true,
      });

      await bridge.registerQuestion({
        origin: QUESTION_ORIGIN,
        input: { question: "Still asking?" },
      });
      await vi.waitFor(() => expect(h.relay.questions).toHaveLength(1));
      expect(h.statuses.at(-1)?.state).toBe("connected");
      // An ordinary question's envelope binds only what a 0.8.0 reader's strict AAD allows.
      expect(Object.keys(created[0]!.question.envelope.aad).sort()).toEqual([
        "installation_id",
        "question_id",
        "record_type",
        "revision",
        "sender_device_id",
      ]);
      expect(relay.declared.length).toBeGreaterThan(0);
      for (const features of relay.declared) {
        for (const feature of (features as string[] | undefined) ?? []) {
          expect(DAINTREE_PROTOCOL_FEATURES).toContain(feature);
        }
      }
      expect(relay.declared.flat()).toContain("owner-desktop-declines-v1");
      expect(relay.declared.flat()).not.toContain("advisory-deadlines-v1");
      expect(push).not.toHaveBeenCalled();
      expect(relay.requests).not.toContain("POST /api/v1/push/agent-stopped");
    }
  );

  it("repairs a reopened question's deadline from the signed reopen a 0.8.0 bridge kept but didn't apply (#17939)", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "daintree-relay-repair-"));
    const migrations = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      "../../persistence/migrations"
    );
    try {
      const relay = await relayWithPreference();
      const sqlite = openDb(path.join(dir, "app.db"), migrations).sqlite;
      const store = new DaintreeLocalStore(sqlite);
      const questionId = "q_reopened_0002";
      const earlier = "2026-11-25T00:00:00.000Z";
      const reopenedUntil = "2026-12-20T00:00:00.000Z";
      // As 0.8.0 left it: the reopen applied to status and round, the first round's deadline kept.
      await store.commitNewQuestion(
        {
          question_id: questionId,
          alias: await store.nextAlias(),
          origin: QUESTION_ORIGIN,
          requirement: "human-required",
          question_revision: 1,
          remote_event_seq: 7,
          origin_created_at: "2026-11-01T00:00:00.000Z",
          expires_at: earlier,
          local_status: "open",
          delivery_status: "relay-queued",
          last_injection_id: null,
          last_attempt_at: null,
          agent_resume_strategy: null,
          error_code: null,
          content_sealed: '{"sealed":1}',
          answers_json: "[]",
          messages_json: "[]",
          history_only: false,
          delivered_revision: 0,
          attachment_digests: [],
        },
        {
          id: "o2",
          kind: "create",
          question_id: questionId,
          payload: {},
          attempts: 0,
          next_attempt_at: 0,
          created_at: 0,
          last_error: null,
        }
      );
      await store.deleteOutbox("o2");
      const owner = await loadIdentity(
        await (async () => {
          const keys = new MemoryKeyStore();
          await keys.save(identity);
          return keys;
        })()
      );
      const signed = await buildSignedAction({
        installationId: RELAY.installationId,
        questionId,
        action: "reopen",
        signerDeviceId: RELAY.deviceId,
        signingKey: owner.keys.signing.privateKey,
        expectedRevision: 0,
        expiresAt: reopenedUntil,
      });
      const reopen = {
        protocol_version: 1,
        seq: 7,
        event_id: "evt_00000007",
        event_type: "decision.reopened",
        occurred_at: "2026-11-20T00:00:00.000Z",
        question_id: questionId,
        question_revision: 1,
        origin_device_id: RELAY.deviceId,
        data: EventData.action.parse({
          action: "reopen",
          record: signed.record,
          envelope: signed.envelope,
          provenance: null,
          status: "open",
          revision: 1,
          target_host_id: await hostRef(QUESTION_ORIGIN.host_id),
          deliverable: false,
        }),
      };
      await store.insertEvent({
        seq: 7,
        event_id: reopen.event_id,
        event_type: reopen.event_type,
        json: JSON.stringify(reopen),
        received_at: 1,
        processed_at: null,
      });
      await store.markEventProcessed(7, 2);
      await store.setMeta("cursor", "7");

      const h = await harness({ store, wrapFetch: relay.wrapFetch });
      h.connection.start();
      const socket = await connectLive(h);
      socket.event(8);
      await socket.waitFor((frame) => frame.t === "ack" && frame.seq === 8);

      await vi.waitFor(async () => expect(await store.getMeta("rounds-reconciled")).not.toBeNull());
      expect(await store.getQuestion(questionId)).toMatchObject({
        local_status: "open",
        question_revision: 1,
        expires_at: reopenedUntil,
      });
      h.connection.stop();
      await store.close();
      sqlite.close();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("answers from the verified copy a 0.7.0 Daintree kept, and still refuses an older record against it (#17433)", async () => {
    const relay = await relayWithPreference();
    const kept = await signedOn070Phone(relay.phone, 2, null);
    const syncedAt = Date.now() - 60_000;
    const store = new MemoryLocalStore();
    // The copy exactly as 0.7.0 stored it: no record of where the preference was set.
    await store.setMeta(
      INVOLVEMENT_META,
      JSON.stringify({ record: kept, high_water: 2, synced_at: syncedAt })
    );
    // The relay hands back an older revision, as a rolled-back relay would.
    relay.serve(await signedOn070Phone(relay.phone, 1, null));
    const release = relay.holdReads();
    let source: QuestionSource | null = null;
    const h = await harness({
      store,
      wrapFetch: relay.wrapFetch,
      overrides: { onQuestionsReady: (ready) => (source = ready) },
    });
    teardown.push(release, () => h.connection.stop());
    h.connection.start();
    await vi.waitFor(() => expect(source).not.toBeNull());
    const bridge = new QuestionBridge({
      source: source as unknown as QuestionSource,
      isCurrent: () => true,
    });

    const fromCopy = {
      status: "available",
      mode: "recommend",
      consultCount: 3,
      revision: 2,
      setAt: kept.created_at,
      lastSyncedAt: new Date(syncedAt).toISOString(),
      stale: true,
    };
    await expect(bridge.getInvolvement()).resolves.toMatchObject(fromCopy);

    release();
    await connectLive(h);
    await vi.waitFor(async () =>
      expect(await store.listAudit(50)).toContainEqual(
        expect.objectContaining({ event: "involvement.refused", result: "rollback" })
      )
    );
    await expect(bridge.getInvolvement()).resolves.toMatchObject(fromCopy);
  });
});

describe("presence over a connection (#17240)", () => {
  const teardown: Array<() => unknown> = [];

  afterEach(async () => {
    for (const step of teardown.splice(0)) await step();
  });

  const json = (body: unknown) =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });

  /** A relay advertising `features` in `/info`, keeping each presence report Daintree sends. */
  function presenceRelay(features: string[]) {
    const reports: boolean[] = [];
    const requests: string[] = [];
    const wrapFetch =
      (fetchImpl: RelayFetch): RelayFetch =>
      async (url, init) => {
        const { pathname } = new URL(url);
        requests.push(`${init.method ?? "GET"} ${pathname}`);
        if (pathname === "/api/v1/info") {
          return json({
            name: "daintree-decisions",
            protocol_min: 1,
            protocol_max: 1,
            worker_version: "0.8.0",
            claimed: true,
            claim_configured: true,
            voice: { xai: false, anthropic: false, openai: false },
            features,
          });
        }
        if (pathname === "/api/v1/presence" && init.method === "PUT") {
          const { present } = JSON.parse(String(init.body)) as { present: boolean };
          reports.push(present);
          return json({
            present,
            until: present ? new Date(Date.now() + 60_000).toISOString() : null,
          });
        }
        return fetchImpl(url, init);
      };
    return { wrapFetch, reports, requests };
  }

  /** What the owner's presence reads, and whether it may be reported; no Electron watchers. */
  function presenceState() {
    const state = { presence: "present" as UserPresence, allowed: true };
    const watch: PresenceWatchers = {
      onSuspend: () => () => {},
      onResume: () => () => {},
      onChange: () => () => {},
    };
    return {
      state,
      presence: { read: () => state.presence, allowed: () => state.allowed, watch },
    };
  }

  async function connected(
    relay: ReturnType<typeof presenceRelay>,
    presence: ReturnType<typeof presenceState>["presence"]
  ): Promise<Harness> {
    const h = await harness({ wrapFetch: relay.wrapFetch, overrides: { presence } });
    teardown.push(() => h.connection.stop());
    h.connection.start();
    await connectLive(h);
    return h;
  }

  it("tells the relay while the person is here, and that they left once they're away", async () => {
    const relay = presenceRelay(["presence-v1"]);
    const { state, presence } = presenceState();
    const h = await connected(relay, presence);
    await vi.waitFor(() => expect(relay.reports).toEqual([true]));

    state.presence = "away";
    h.connection.presenceChanged();
    await vi.waitFor(() => expect(relay.reports).toEqual([true, false]));
  });

  it("tells the relay nothing while presence isn't allowed, and starts and ends as that changes", async () => {
    const report = vi.spyOn(DecisionsBridge.prototype, "reportPresence");
    const relay = presenceRelay(["presence-v1"]);
    const { state, presence } = presenceState();
    state.allowed = false;
    const h = await connected(relay, presence);
    await vi.advanceTimersByTimeAsync(PRESENCE_TICK_MS * 2);
    expect(report).not.toHaveBeenCalled();
    expect(relay.requests).not.toContain("PUT /api/v1/presence");

    state.allowed = true;
    h.connection.presenceChanged();
    await vi.waitFor(() => expect(relay.reports).toEqual([true]));

    state.allowed = false;
    h.connection.presenceChanged();
    await vi.waitFor(() => expect(relay.reports).toEqual([true, false]));
    expect(report.mock.calls.map(([present]) => present)).toEqual([true, false]);
  });

  it("counts unknown presence as away: nothing is reported", async () => {
    const report = vi.spyOn(DecisionsBridge.prototype, "reportPresence");
    const relay = presenceRelay(["presence-v1"]);
    const { state, presence } = presenceState();
    state.presence = "unknown";
    await connected(relay, presence);
    await vi.advanceTimersByTimeAsync(PRESENCE_TICK_MS * 2);
    expect(report).not.toHaveBeenCalled();
    expect(relay.requests).not.toContain("PUT /api/v1/presence");
  });

  it("tells each new attempt's bridge at once, not a tick later", async () => {
    const relay = presenceRelay(["presence-v1"]);
    const { presence } = presenceState();
    const h = await connected(relay, presence);
    await vi.waitFor(() => expect(relay.reports).toEqual([true]));

    expect(h.connection.refresh()).toBe(true);
    await connectLive(h, 1);
    await vi.waitFor(() => expect(relay.reports).toEqual([true, true]));
  });

  it("sends a relay that doesn't serve presence nothing for it", async () => {
    const relay = presenceRelay(["thread-messages-v1", "involvement-v1"]);
    const { presence } = presenceState();
    await connected(relay, presence);
    await vi.waitFor(() => expect(relay.requests).toContain("GET /api/v1/info"));
    await vi.advanceTimersByTimeAsync(PRESENCE_TICK_MS * 2);
    expect(relay.requests).not.toContain("PUT /api/v1/presence");
  });

  it("tells the relay the person left once the store stops writing, since no question can show", async () => {
    const relay = presenceRelay(["presence-v1"]);
    const { presence } = presenceState();
    let faulted = false;
    const store = Object.assign(new MemoryLocalStore(), { isFaulted: () => faulted });
    const h = await harness({ store, wrapFetch: relay.wrapFetch, overrides: { presence } });
    teardown.push(() => h.connection.stop());
    h.connection.start();
    await connectLive(h);
    await vi.waitFor(() => expect(relay.reports).toEqual([true]));

    faulted = true;
    // The library may renew once before the next read sees the fault; that read ends the lease.
    await vi.advanceTimersByTimeAsync(PRESENCE_TICK_MS);
    await vi.waitFor(() => expect(relay.reports.at(-1)).toBe(false));
    const sent = relay.reports.length;
    await vi.advanceTimersByTimeAsync(PRESENCE_TICK_MS * 3);
    expect(relay.reports).toHaveLength(sent);
  });

  it("stops following presence when the connection stops", async () => {
    const relay = presenceRelay(["presence-v1"]);
    const read = vi.fn<() => UserPresence>(() => "present");
    const { presence } = presenceState();
    const h = await connected(relay, { ...presence, read });
    await vi.waitFor(() => expect(relay.reports).toEqual([true]));
    await h.connection.stop();
    const reads = read.mock.calls.length;
    await vi.advanceTimersByTimeAsync(PRESENCE_TICK_MS * 3);
    h.connection.presenceChanged();
    expect(read).toHaveBeenCalledTimes(reads);
  });
});

describe("agent-stopped pushes over a connection (#17319)", () => {
  const teardown: Array<() => unknown> = [];

  afterEach(async () => {
    for (const step of teardown.splice(0)) await step();
  });

  const json = (body: unknown) =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });

  /** A relay advertising `features` in `/info`, keeping the body of each agent-stopped request. */
  function stoppedRelay(features: string[]) {
    const bodies: unknown[] = [];
    const requests: string[] = [];
    /** While set, `/info` answers only once it resolves. */
    let infoHeld: Promise<void> | null = null;
    const wrapFetch =
      (fetchImpl: RelayFetch): RelayFetch =>
      async (url, init) => {
        const { pathname } = new URL(url);
        requests.push(`${init.method ?? "GET"} ${pathname}`);
        if (pathname === "/api/v1/info") {
          if (infoHeld) await infoHeld;
          return json({
            name: "daintree-decisions",
            protocol_min: 1,
            protocol_max: 1,
            worker_version: "0.9.0",
            claimed: true,
            claim_configured: true,
            voice: { xai: false, anthropic: false, openai: false },
            features,
          });
        }
        if (pathname === "/api/v1/push/agent-stopped" && init.method === "POST") {
          bodies.push(JSON.parse(String(init.body)));
          return json({ outcome: "sent" });
        }
        return fetchImpl(url, init);
      };
    return {
      wrapFetch,
      bodies,
      posts: () => requests.filter((r) => r === "POST /api/v1/push/agent-stopped").length,
      infoReads: () => requests.filter((r) => r === "GET /api/v1/info").length,
      /** Holds every `/info` from now until the returned function is called. */
      holdInfo: () => {
        let release!: () => void;
        infoHeld = new Promise<void>((resolve) => (release = resolve));
        return () => {
          infoHeld = null;
          release();
        };
      },
    };
  }

  /** An owner away from the computer, outside quiet hours, with the switch on; no Electron watchers. */
  function stoppedState() {
    const state = { allowed: true, presence: "away" as UserPresence };
    const listeners = new Set<(t: AgentTransition) => void>();
    const agentStopped: NonNullable<RelayConnectionOptions["agentStopped"]> = {
      allowed: () => state.allowed,
      presence: () => state.presence,
      quiet: () => false,
      putAside: () => false,
      watchTransitions: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      watchPutAside: () => () => {},
      watch: { onSuspend: () => () => {}, onResume: () => () => {}, onChange: () => () => {} },
      now: () => Date.now(),
    };
    const stop = (terminalId: string) =>
      listeners.forEach((l) => l({ terminalId, state: "completed", previousState: "working" }));
    return { state, agentStopped, stop, listening: () => listeners.size };
  }

  async function connected(
    relay: ReturnType<typeof stoppedRelay>,
    agentStopped: NonNullable<RelayConnectionOptions["agentStopped"]>,
    store?: MemoryLocalStore
  ): Promise<Harness> {
    const h = await harness({ store, wrapFetch: relay.wrapFetch, overrides: { agentStopped } });
    teardown.push(() => h.connection.stop());
    h.connection.start();
    await connectLive(h);
    return h;
  }

  it("asks a relay that serves them once for stops that land together, sending nothing but the protocol version", async () => {
    const relay = stoppedRelay(["agent-stopped-push-v1"]);
    const { agentStopped, stop } = stoppedState();
    await connected(relay, agentStopped);

    stop("pane-a");
    stop("pane-b");
    await vi.advanceTimersByTimeAsync(AGENT_STOPPED_BATCH_MS);
    await vi.waitFor(() => expect(relay.bodies).toHaveLength(1));
    expect(relay.bodies[0]).toEqual({ protocol_version: 1 });
    await vi.advanceTimersByTimeAsync(AGENT_STOPPED_COOLDOWN_MS);
    expect(relay.posts()).toBe(1);
  });

  it("sends nothing when the switch is turned off while the relay's features are being read", async () => {
    const relay = stoppedRelay(["agent-stopped-push-v1"]);
    const { state, agentStopped, stop } = stoppedState();
    const h = await connected(relay, agentStopped);
    const before = relay.infoReads();
    const info = vi.spyOn(console, "info").mockImplementation(() => {});

    const release = relay.holdInfo();
    stop("pane-a");
    await vi.advanceTimersByTimeAsync(AGENT_STOPPED_BATCH_MS);
    await vi.waitFor(() => expect(relay.infoReads()).toBe(before + 1));
    state.allowed = false;
    h.connection.agentStoppedPushesChanged();
    release();
    // The request settles as dropped, never having been sent.
    await vi.waitFor(() => expect(info.mock.calls.flat().join(" ")).toContain("dropped"));
    expect(relay.posts()).toBe(0);
  });

  it("sends nothing when the person is back while the relay's features are being read", async () => {
    const relay = stoppedRelay(["agent-stopped-push-v1"]);
    const { state, agentStopped, stop } = stoppedState();
    await connected(relay, agentStopped);
    const before = relay.infoReads();
    const info = vi.spyOn(console, "info").mockImplementation(() => {});

    const release = relay.holdInfo();
    stop("pane-a");
    await vi.advanceTimersByTimeAsync(AGENT_STOPPED_BATCH_MS);
    await vi.waitFor(() => expect(relay.infoReads()).toBe(before + 1));
    state.presence = "present";
    release();
    await vi.waitFor(() => expect(info.mock.calls.flat().join(" ")).toContain("dropped"));
    expect(relay.posts()).toBe(0);

    // Away again, a fresh stop is asked for as before.
    state.presence = "away";
    stop("pane-b");
    await vi.advanceTimersByTimeAsync(AGENT_STOPPED_COOLDOWN_MS);
    await vi.waitFor(() => expect(relay.posts()).toBe(1));
  });

  it("sends a relay that doesn't serve them nothing", async () => {
    const relay = stoppedRelay(["presence-v1"]);
    const { agentStopped, stop } = stoppedState();
    await connected(relay, agentStopped);
    const info = vi.spyOn(console, "info").mockImplementation(() => {});

    stop("pane-a");
    await vi.advanceTimersByTimeAsync(AGENT_STOPPED_BATCH_MS);
    // Asked, and found the relay without the feature.
    await vi.waitFor(() => expect(info.mock.calls.flat().join(" ")).toContain("unsupported"));
    expect(relay.posts()).toBe(0);
  });

  it("listens to no agent while they aren't allowed, and starts and stops as that changes", async () => {
    const relay = stoppedRelay(["agent-stopped-push-v1"]);
    const { state, agentStopped, stop, listening } = stoppedState();
    state.allowed = false;
    const h = await connected(relay, agentStopped);
    expect(listening()).toBe(0);

    state.allowed = true;
    h.connection.agentStoppedPushesChanged();
    expect(listening()).toBe(1);
    stop("pane-a");

    // Turned off with a stop gathering: it goes, and nothing more is heard.
    state.allowed = false;
    h.connection.agentStoppedPushesChanged();
    expect(listening()).toBe(0);
    state.allowed = true;
    await vi.advanceTimersByTimeAsync(AGENT_STOPPED_BATCH_MS * 2);
    expect(relay.posts()).toBe(0);
  });

  it("sends a stop gathered before an attempt gave way through the attempt live when it goes", async () => {
    const relay = stoppedRelay(["agent-stopped-push-v1"]);
    const { agentStopped, stop } = stoppedState();
    const h = await connected(relay, agentStopped);

    stop("pane-a");
    expect(h.connection.refresh()).toBe(true);
    await connectLive(h, 1);
    await vi.advanceTimersByTimeAsync(AGENT_STOPPED_BATCH_MS);
    await vi.waitFor(() => expect(relay.posts()).toBe(1));
  });

  it("drops a batch when no bridge is live as it goes, and sends nothing for it once one is", async () => {
    const relay = stoppedRelay(["agent-stopped-push-v1"]);
    const { agentStopped, stop } = stoppedState();
    const h = await connected(relay, agentStopped);

    stop("pane-a");
    // Replaced by another connection: the next attempt waits minutes, well past the batch.
    const socket = await h.relay.socket(0);
    socket.drop(4409);
    await h.status("replaced");
    await vi.advanceTimersByTimeAsync(AGENT_STOPPED_BATCH_MS);
    expect(relay.posts()).toBe(0);
    await vi.advanceTimersByTimeAsync(REPLACED_MAX_MS);
    await connectLive(h, 1);
    await vi.advanceTimersByTimeAsync(AGENT_STOPPED_COOLDOWN_MS);
    expect(relay.posts()).toBe(0);
  });

  it("asks nothing once the store stops writing", async () => {
    const relay = stoppedRelay(["agent-stopped-push-v1"]);
    const { agentStopped, stop } = stoppedState();
    let faulted = false;
    const store = Object.assign(new MemoryLocalStore(), { isFaulted: () => faulted });
    await connected(relay, agentStopped, store);

    stop("pane-a");
    faulted = true;
    await vi.advanceTimersByTimeAsync(AGENT_STOPPED_BATCH_MS * 2);
    expect(relay.posts()).toBe(0);
  });

  it("stops listening when the connection stops", async () => {
    const relay = stoppedRelay(["agent-stopped-push-v1"]);
    const { agentStopped, listening } = stoppedState();
    const h = await connected(relay, agentStopped);
    expect(listening()).toBe(1);
    await h.connection.stop();
    expect(listening()).toBe(0);
    h.connection.agentStoppedPushesChanged();
    expect(listening()).toBe(0);
  });
});
