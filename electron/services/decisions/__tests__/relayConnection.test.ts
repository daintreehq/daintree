import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  DecisionsBridge,
  MemoryKeyStore,
  MemoryLocalStore,
  type KeyStore,
  type StoredIdentity,
  type WebSocketLike,
} from "@daintreehq/decisions-client";
import {
  generateDeviceKeys,
  generateEpochKeyBytes,
  serializeDeviceKeys,
} from "@daintreehq/decisions-crypto";
import { pendingRotationOf } from "../keyRotation.js";
import { bytesToBase64Url } from "@daintreehq/decisions-protocol";

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
import { createTrustedPolicy } from "../workflowGates.js";
import { QuestionBridge } from "../questionBridge.js";
import type { QuestionSource } from "../relayConnection.js";

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
    policy: createTrustedPolicy({ proxyAllowlisted: false }),
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
    const policy = createTrustedPolicy({ proxyAllowlisted: false });
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

    faulted = true;
    socket.event(1);
    expect(await h.status("not-connected")).toEqual({ state: "not-connected", problem: "storage" });
    expect(socket.frames().some((frame) => frame.t === "ack" && frame.seq === 1)).toBe(false);
    expect(socket.closedByClient).toBe(1000);
  });

  it("leaves the store's injection intents to delivery: a socket attempt reconciles none", async () => {
    const store = new MemoryLocalStore();
    // An attempt's own engine would take this, with no question behind it, as abandoned.
    await store.putIntent({
      injection_id: "inj_12345678",
      question_id: "q_12345678",
      answer_revision: 1,
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
    const h = await harness({ overrides: { delivery: deliveryDeps().deps } });

    h.connection.start();
    const first = await connectLive(h);
    first.drop(1006);
    await h.status("reconnecting");
    await vi.advanceTimersByTimeAsync(RECONNECT_BASE_MS);
    await connectLive(h, 1);

    expect(bridges).toHaveLength(2);
    expect(bridges[0].ctx.lock).toBe(bridges[1].ctx.lock);
    expect(bridges.every((bridge) => bridge.delivery.stopped)).toBe(true);
    await h.connection.stop();
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
