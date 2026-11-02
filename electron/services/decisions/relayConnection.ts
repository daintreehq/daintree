import {
  DecisionsBridge,
  RelayClient,
  RelayError,
  loadIdentity,
  type Identity,
  type InboundEvent,
  type KeyStore,
  type LocalStore,
  type PolicyRegistry,
  type SocketState,
  type WebSocketLike,
} from "@daintreehq/decisions-client";
import { EventData, WS_CLOSE } from "@daintreehq/decisions-protocol";
import type { DecisionsConnectionProblem } from "../../../shared/types/decisions.js";
import { AnswerDelivery, type AnswerDeliveryDeps } from "./answerDelivery.js";
import { normalizeRelayOrigin } from "./decisionsSettings.js";
import { KeyRotations, pendingRotationOf } from "./keyRotation.js";
import type { RelayFetch } from "./relayCheck.js";
import { relayRequests } from "./relayIdentity.js";
import {
  ObservedSocket,
  RetiredAttemptError,
  chromiumWebSocket,
  holdingTerminalSink,
  isRelaySocketUrl,
  retireable,
  socketBridgeStore,
  watchNetwork,
  watchResume,
} from "./relayTransport.js";
import type { QuestionAttachments } from "./attachmentSpool.js";

/** The relay identity a connection is for, as the setting records it. */
export interface RelayBinding {
  relayOrigin: string;
  installationId: string;
  deviceId: string;
}

/** What the connection last observed; the service shows it as Decisions' state. */
export type RelayConnectionStatus =
  | { state: "connecting" }
  | { state: "connected" }
  | { state: "reconnecting" | "replaced"; nextAttemptAt: number }
  | { state: "revoked" }
  | { state: "not-connected"; problem: DecisionsConnectionProblem };

/**
 * The store as a connection uses it: the library's, whether it stopped taking
 * writes, and whether any answer waits to be typed.
 */
export type RelayConnectionStore = LocalStore & {
  isFaulted?(): boolean;
  hasPendingDelivery?(): Promise<boolean>;
  /** Marks a question's pending create as possibly published, atomically, if it has one (#16014). */
  markCreateMaybePublished?(questionId: string): Promise<boolean>;
};

/**
 * What agents' questions are asked through while a connection runs (#16011):
 * the identity and store it runs on, and the attempt bridge that is live now.
 */
export interface QuestionSource {
  /** The identity as the latest attempt left it; null once the connection has ended. */
  identity(): Identity | null;
  /** The started attempt's bridge, while it is current; null between attempts. */
  live(): DecisionsBridge | null;
  /** The lifetime's store, refused to anyone once the connection has ended. */
  readonly store: RelayConnectionStore;
  /** The lifetime's trusted policy, the one every attempt's bridge asks under. */
  readonly policy: PolicyRegistry;
  /** The lifetime's attachments, the ones every attempt's bridge asks with; none refuses them. */
  readonly attachments?: QuestionAttachments;
}

export interface RelayConnectionOptions {
  relay: RelayBinding;
  store: RelayConnectionStore;
  keys: KeyStore;
  /**
   * The trusted gates and proxy allowlist every attempt's bridge asks and
   * answers questions under. Shared, never copied, so a change reaches the
   * bridge that is running.
   */
  policy: PolicyRegistry;
  /**
   * The resolver, durable spool and ask gate of the lifetime's store
   * (#16014), shared by every attempt's bridge so a flush after a restart or
   * a reconnect uploads what an earlier one spooled. Without them,
   * attachments are refused.
   */
  attachments?: QuestionAttachments;
  onStatus(status: RelayConnectionStatus): void;
  /** The relay revoked this identity. Called once, after which nothing reconnects. */
  onRevoked(): void;
  /**
   * The lifetime's key rotations (#16010), shared with the owner's revoke and
   * rotate; a connection without one keeps its own.
   */
  rotations?: KeyRotations;
  /**
   * The relay's devices changed: the ledger brought a new `device.revoked` or
   * `device.key_rotated`, or a pending rotation was finished on connecting.
   */
  onDevicesChanged?(): void;
  webSocket?: (url: string) => WebSocketLike;
  fetchImpl?: RelayFetch;
  /**
   * Types received answers into the panes that asked (#16017), for as long as
   * the connection lasts, whether or not a socket is up. Without it answers
   * stay stored and untyped.
   */
  delivery?: AnswerDeliveryDeps;
  watchResume?: (onResume: () => void) => () => void;
  watchNetwork?: (onChange: (online: boolean) => void) => () => void;
  now?: () => number;
  rand?: () => number;
  /** How long an attempt may take to hear the relay's first frame. */
  helloTimeoutMs?: number;
  /** The bridge's background pass over the outbox and pending work; the library's 30 s by default. */
  pumpIntervalMs?: number;
  /**
   * The identity loaded and the store bound, before the first attempt goes
   * out: questions can be asked from here on, and are published once an
   * attempt is live. Called at most once.
   */
  onQuestionsReady?(source: QuestionSource): void;
}

/** Where the store records which relay identity its cursor and events belong to. */
export const RELAY_BINDING_META_KEY = "daintree:relay-binding";

export const RECONNECT_BASE_MS = 1_000;
export const RECONNECT_CAP_MS = 5 * 60_000;
/** After a 4409, wait this long or longer, so two processes don't take turns replacing each other. */
export const REPLACED_MIN_MS = 150_000;
export const REPLACED_MAX_MS = 300_000;
const HELLO_TIMEOUT_MS = 45_000;
/** A wake and a network change often arrive together; one fresh attempt serves both. */
const COALESCE_MS = 2_000;

interface Attempt {
  retired: boolean;
  startedAt: number;
  controller: AbortController;
  bridge: DecisionsBridge | null;
  /** Its bridge finished starting: it has reconciled what an earlier run left and runs its pump. */
  started: boolean;
  socket: ObservedSocket | null;
  closeCode: number | null;
  helloTimer: ReturnType<typeof setTimeout> | null;
  offs: Array<() => void>;
}

function sameStatus(a: RelayConnectionStatus | null, b: RelayConnectionStatus): boolean {
  if (a === null || a.state !== b.state) return false;
  if ("nextAttemptAt" in a && "nextAttemptAt" in b) return a.nextAttemptAt === b.nextAttemptAt;
  if ("problem" in a && "problem" in b) return a.problem === b.problem;
  return true;
}

function bindingText(relay: RelayBinding): string {
  return JSON.stringify([relay.relayOrigin, relay.installationId, relay.deviceId]);
}

const DEVICE_EVENTS = new Set(["device.revoked", "device.key_rotated"]);

/** The epoch the relay says it holds after a device event; null when the event doesn't say. */
function keyEpochOf(event: InboundEvent): number | null {
  let wire: unknown;
  try {
    wire = JSON.parse(event.json);
  } catch {
    return null;
  }
  const data = typeof wire === "object" && wire !== null ? (wire as { data?: unknown }).data : null;
  const parsed =
    event.event_type === "device.revoked"
      ? EventData.deviceRevoked.safeParse(data)
      : EventData.keyRotated.safeParse(data);
  return parsed.success ? parsed.data.key_epoch : null;
}

/** No answer, or a failure the relay may have acted on: the attempt retries. */
function unanswered(error: unknown): boolean {
  return (
    error instanceof RelayError &&
    (error.code === "network_error" || error.retryable || error.status >= 500)
  );
}

/**
 * One enabled lifetime's connection to the relay: the library's bridge over
 * the lifetime's store, socket and all, kept up across drops, sleep and
 * network changes until `stop`.
 *
 * Each attempt gets a bridge of its own. A stopped bridge can't start again,
 * and restarting its socket while a ticket request is still out would leave
 * two sockets open on one identity, which the relay answers with a 4409. So a
 * dropped socket retires its attempt (bridge stopped, requests aborted, store
 * and keys refused to it from then on) and Daintree schedules the next one
 * itself, which is also the only way to know when it will be: the library
 * keeps its own retry delay to itself.
 *
 * The socket's URL carries its ticket, so nothing here logs it, and nothing
 * here logs what the relay or the socket said, only numbers.
 */
export class RelayConnection {
  private readonly o: RelayConnectionOptions;
  private readonly now: () => number;
  private readonly rand: () => number;
  private identity: Identity | null = null;
  private current: Attempt | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private replacedUntil = 0;
  private failures = 0;
  private ended = false;
  private status: RelayConnectionStatus | null = null;
  private watchers: Array<() => void> = [];
  private readonly keys: KeyStore;
  private readonly store: RelayConnectionStore;
  private delivery: AnswerDelivery | null = null;
  private stopping: Promise<void> = Promise.resolve();
  /** Aborts the lifetime's own requests: delivery's reports to the relay. */
  private readonly lifetime = new AbortController();
  private readonly rotations: KeyRotations;

  constructor(options: RelayConnectionOptions) {
    this.o = options;
    this.now = options.now ?? Date.now;
    this.rand = options.rand ?? Math.random;
    this.keys = retireable(options.keys, () => this.ended);
    this.store = retireable(options.store, () => this.ended);
    this.rotations = options.rotations ?? new KeyRotations(this.keys);
  }

  /** What the connection last observed; null before `start`. */
  getStatus(): RelayConnectionStatus | null {
    return this.status;
  }

  /**
   * Loads the identity and opens the first attempt. Returns at once: the keys
   * may wait on a keychain prompt and the relay on the network, and neither
   * holds up the caller.
   */
  start(): void {
    if (this.ended || this.status !== null) return;
    this.publish({ state: "connecting" });
    void this.prepare();
  }

  /**
   * Ends the connection for good. Everything it started stops now; work a
   * retired attempt had already handed to the store finishes there, and the
   * next lifetime picks up from what was committed. Resolves once delivery
   * writes nothing more: an answer being typed settles first, briefly, so
   * its outcome is recorded.
   */
  stop(): Promise<void> {
    if (this.ended) return this.stopping;
    this.end();
    if (this.current) this.retire(this.current);
    return this.stopping;
  }

  /**
   * Starts a fresh attempt now (a wake, a network change), unless the relay
   * revoked this identity, a 4409's wait is still running, or an attempt
   * began a moment ago.
   */
  reconnectNow(): void {
    if (this.ended || this.identity === null) return;
    if (this.replacedUntil > this.now()) return;
    const current = this.current;
    if (current && this.now() - current.startedAt < COALESCE_MS) return;
    if (current) this.retire(current);
    this.failures = 0;
    this.begin();
  }

  /**
   * Starts a fresh attempt now, whatever the current one is doing, so the
   * setup check (#16024) sees a socket open on a new ticket. False when none
   * can start: the connection has ended (revoked or stopped), its identity
   * isn't loaded yet, or a 4409's wait is still running, which this never
   * cuts short.
   */
  refresh(): boolean {
    if (this.ended || this.identity === null) return false;
    if (this.replacedUntil > this.now()) return false;
    if (this.current) this.retire(this.current);
    this.failures = 0;
    this.begin();
    return true;
  }

  private async prepare(): Promise<void> {
    let identity: Identity;
    try {
      identity = await loadIdentity(this.keys);
    } catch {
      if (!this.ended) this.halt({ state: "not-connected", problem: "keys" });
      return;
    }
    if (this.ended) return;
    if (!this.isBound(identity)) {
      this.halt({ state: "not-connected", problem: "keys" });
      return;
    }
    let bound: boolean;
    try {
      bound = await this.bindStore();
    } catch {
      if (!this.ended) this.halt({ state: "not-connected", problem: "storage" });
      return;
    }
    if (this.ended) return;
    if (!bound) {
      this.halt({ state: "not-connected", problem: "other-relay" });
      return;
    }
    this.identity = identity;
    this.o.onQuestionsReady?.({
      identity: () => (this.ended ? null : this.identity),
      live: () => {
        const current = this.current;
        return current?.started && !current.retired ? current.bridge : null;
      },
      store: this.store,
      policy: this.o.policy,
      ...(this.o.attachments ? { attachments: this.o.attachments } : {}),
    });
    if (this.ended) return;
    await this.startDelivery(identity);
    if (this.ended) return;
    this.watchers.push(
      (this.o.watchResume ?? watchResume)(() => this.reconnectNow()),
      (this.o.watchNetwork ?? watchNetwork)((online) => {
        if (online) this.reconnectNow();
      })
    );
    this.begin();
  }

  /** Whether `identity` is the owner identity this connection is for. */
  private isBound(identity: Identity): boolean {
    const { config } = identity;
    return (
      identity.role === "owner-desktop" &&
      normalizeRelayOrigin(config.relayOrigin) === this.o.relay.relayOrigin &&
      config.installationId === this.o.relay.installationId &&
      config.deviceId === this.o.relay.deviceId
    );
  }

  /**
   * The store's cursor and events are positions in one relay identity's
   * ledger: another identity's sequence numbers would collide with them, and
   * its sync would start past events it never sent. The first connection
   * records which identity they belong to; a different one is refused.
   */
  private async bindStore(): Promise<boolean> {
    const wanted = bindingText(this.o.relay);
    const recorded = await this.store.getMeta(RELAY_BINDING_META_KEY);
    if (recorded === wanted) return true;
    if (recorded !== null) return false;
    await this.store.setMeta(RELAY_BINDING_META_KEY, wanted);
    return true;
  }

  /**
   * Delivery runs for the connection's lifetime, not an attempt's, so an
   * answer already stored is typed while the relay is out of reach.
   */
  private async startDelivery(identity: Identity): Promise<void> {
    const deps = this.o.delivery;
    if (!deps) return;
    let requests: Awaited<ReturnType<typeof relayRequests>>;
    try {
      requests = await relayRequests(this.o.relay.relayOrigin, {
        fetchImpl: this.o.fetchImpl,
        signal: this.lifetime.signal,
      });
    } catch {
      console.warn("[Decisions] Answers can't be delivered: no way to reach the relay was made");
      return;
    }
    if (this.ended) return;
    const delivery = new AnswerDelivery({
      deps,
      identity,
      store: this.o.store,
      keys: this.o.keys,
      // Reports are retried on every pass while they fail, so each is tried once.
      client: new RelayClient({ identity, fetch: requests.fetch, maxRetries: 0 }),
      onKeysUnusable: () => this.halt({ state: "not-connected", problem: "keys" }),
    });
    this.delivery = delivery;
    delivery.start();
  }

  private begin(): void {
    if (this.ended || this.identity === null) return;
    this.clearRetry();
    if (this.o.store.isFaulted?.()) {
      this.halt({ state: "not-connected", problem: "storage" });
      return;
    }
    const attempt: Attempt = {
      retired: false,
      startedAt: this.now(),
      controller: new AbortController(),
      bridge: null,
      started: false,
      socket: null,
      closeCode: null,
      helloTimer: null,
      offs: [],
    };
    this.current = attempt;
    this.publish({ state: "connecting" });
    attempt.helloTimer = setTimeout(
      () => this.fail(attempt),
      this.o.helloTimeoutMs ?? HELLO_TIMEOUT_MS
    );
    attempt.helloTimer.unref?.();
    void this.open(attempt, this.identity);
  }

  private async open(attempt: Attempt, identity: Identity): Promise<void> {
    let bridge: DecisionsBridge | null = null;
    try {
      const requests = await relayRequests(this.o.relay.relayOrigin, {
        fetchImpl: this.o.fetchImpl,
        signal: attempt.controller.signal,
      });
      if (attempt.retired) return;
      const retired = () => attempt.retired;
      // The outbox keeps its own retry times, so a request is tried once per pass.
      const client = new RelayClient({ identity, fetch: requests.fetch, maxRetries: 0 });
      const settled = await this.settleKeys(attempt, client);
      if (attempt.retired) return;
      bridge = new DecisionsBridge({
        identity: settled,
        keyStore: this.bridgeKeys(attempt, retireable(this.keys, retired)),
        store: this.watchedStore(
          attempt,
          socketBridgeStore(retireable(this.store, retired), () => this.delivery?.request())
        ),
        sink: holdingTerminalSink,
        policy: this.o.policy,
        ...(this.o.attachments
          ? { resolver: this.o.attachments.resolver, spool: this.o.attachments.spool }
          : {}),
        client,
        webSocket: (url) => this.openSocket(attempt, url),
        ...(this.o.pumpIntervalMs !== undefined ? { pumpIntervalMs: this.o.pumpIntervalMs } : {}),
      });
      // Answers are typed by the lifetime's delivery. An attempt's own engine
      // would stop with its socket, and reconcile the lifetime's injections as
      // crashed ones each time an attempt starts.
      bridge.delivery.stopped = true;
      // Its inbox appends answers to the rows delivery marks delivered.
      if (this.delivery) bridge.ctx.lock = this.delivery.lock;
      attempt.bridge = bridge;
      const started = bridge;
      attempt.offs.push(
        started.on("socket", (state) => this.onSocketState(attempt, state)),
        started.on("state", (state) => {
          if (state === "revoked") queueMicrotask(() => this.settle(attempt));
        }),
        started.on("error", () => {
          if (this.o.store.isFaulted?.()) this.halt({ state: "not-connected", problem: "storage" });
        })
      );
      await started.start();
      if (!attempt.retired) attempt.started = true;
    } catch {
      if (this.o.store.isFaulted?.()) this.halt({ state: "not-connected", problem: "storage" });
      else this.fail(attempt);
    } finally {
      // Retired while it was starting: start carries on past a stop, so stop it again.
      if (attempt.retired && bridge) void bridge.stop().catch(() => {});
    }
  }

  /**
   * Finishes a key rotation that a crash or a lost answer left pending
   * (#16010) before the bridge starts sealing, and returns the keys as they
   * then stand. The relay took the pending key or it didn't: either it
   * becomes current, or the same key is sent again. A request the relay may
   * not have answered fails the attempt, which tries again; any other refusal
   * leaves the current key in force, which every remaining device still
   * holds, and the next attempt tries again.
   */
  private async settleKeys(attempt: Attempt, client: RelayClient): Promise<Identity> {
    if (!this.mayBePending(client.identity)) return client.identity;
    try {
      const outcome = await this.rotations.settle(client);
      if (outcome.outcome === "unconfirmed") throw outcome.error;
      if (outcome.outcome === "done") {
        if (!attempt.retired) this.o.onDevicesChanged?.();
      } else if (outcome.outcome !== "none") {
        console.warn(`[Decisions] A pending key rotation is still unfinished (${outcome.outcome})`);
      }
    } catch (error) {
      if (unanswered(error)) throw error;
      if (!attempt.retired) console.warn("[Decisions] A pending key rotation couldn't be checked");
    }
    const identity = client.identity;
    if (attempt.retired) return identity;
    if (!this.isBound(identity)) {
      this.halt({ state: "not-connected", problem: "keys" });
      return identity;
    }
    this.identity = identity;
    return identity;
  }

  /**
   * Whether a rotation may be pending: the keys this connection holds record
   * one, or one was staged or seen since. Otherwise the keys aren't read again.
   */
  private mayBePending(identity: Identity | null): boolean {
    return (
      this.rotations.mayBePending() ||
      (identity !== null && pendingRotationOf(identity.stored) !== null)
    );
  }

  /**
   * The attempt's store, watching the ledger for the relay's device events
   * (#16010). A new `device.key_rotated` or `device.revoked` whose epoch is a
   * pending key's makes that key current before the insert returns, so the
   * bridge's own reload, which comes when it applies the event, finds it;
   * then the service hears that the devices changed.
   */
  private watchedStore(attempt: Attempt, store: RelayConnectionStore): RelayConnectionStore {
    const insertEvent = async (event: InboundEvent): Promise<boolean> => {
      const inserted = await store.insertEvent(event);
      if (!inserted || !DEVICE_EVENTS.has(event.event_type) || attempt.retired) return inserted;
      const epoch = keyEpochOf(event);
      if (epoch !== null && this.mayBePending(this.identity)) {
        try {
          await this.rotations.confirm(epoch);
        } catch {
          // Still pending: the next attempt's settle finds the relay holds it.
          console.warn("[Decisions] A rotated key couldn't be made current yet");
        }
      }
      if (!attempt.retired) this.o.onDevicesChanged?.();
      return inserted;
    };
    return new Proxy(store, {
      get(object, property, receiver) {
        if (property === "insertEvent") return insertEvent;
        return Reflect.get(object, property, receiver) as unknown;
      },
    });
  }

  /**
   * The keys as a bridge reloads them after a key rotation. The library's
   * inbox takes a failed reload as final for the event that needed it, and
   * marks that event processed, so an answer would be lost to a keychain that
   * was only locked. A failed reload stops the connection first, which
   * refuses the mark: the event stays stored for the next lifetime. A reload
   * that fails after its attempt was retired leaves the attempt that replaced
   * it alone: the retired one can't reach the store anyway.
   */
  private bridgeKeys(attempt: Attempt, keys: KeyStore): KeyStore {
    const unusable = () => {
      if (!attempt.retired) this.halt({ state: "not-connected", problem: "keys" });
    };
    return {
      load: () =>
        keys.load().then(
          (stored) => {
            // Gone or unfinished keys fail the library's reload all the same.
            if (stored === null || stored.claimed === false) unusable();
            return stored;
          },
          (error: unknown) => {
            if (!(error instanceof RetiredAttemptError)) unusable();
            throw error;
          }
        ),
      save: (identity) => keys.save(identity),
      clear: () => keys.clear(),
    };
  }

  private openSocket(attempt: Attempt, url: string): WebSocketLike {
    if (attempt.retired) throw new Error("This relay connection attempt has ended");
    if (!isRelaySocketUrl(url, this.o.relay.relayOrigin)) {
      throw new Error("The relay named a socket on another origin");
    }
    const socket = new ObservedSocket((this.o.webSocket ?? chromiumWebSocket)(url), (code) => {
      if (attempt.socket === socket) attempt.closeCode = code;
    });
    attempt.socket = socket;
    return socket;
  }

  private onSocketState(attempt: Attempt, state: SocketState): void {
    if (attempt.retired) return;
    switch (state) {
      case "syncing":
      case "live":
        if (attempt.helloTimer) clearTimeout(attempt.helloTimer);
        attempt.helloTimer = null;
        this.failures = 0;
        this.publish({ state: "connected" });
        // Deliveries made while the relay was out of reach can be reported now.
        if (state === "live") this.delivery?.request();
        return;
      case "backoff":
        // The library schedules its own retry right after saying so; once it
        // has, stopping the bridge cancels it, and the retry is Daintree's.
        queueMicrotask(() => this.fail(attempt));
        return;
      case "stopped":
        // A revocation stops the socket before the bridge says it was one.
        queueMicrotask(() => this.settle(attempt));
        return;
      default:
        return;
    }
  }

  /** The socket stopped by itself: revoked, replaced, or anything else, which is retried. */
  private settle(attempt: Attempt): void {
    if (attempt.retired) return;
    if (attempt.bridge?.state === "revoked" || attempt.closeCode === WS_CLOSE.revoked) {
      this.retire(attempt);
      this.halt({ state: "revoked" });
      this.o.onRevoked();
      return;
    }
    if (attempt.closeCode === WS_CLOSE.replaced) {
      this.retire(attempt);
      const delay = REPLACED_MIN_MS + Math.floor(this.rand() * (REPLACED_MAX_MS - REPLACED_MIN_MS));
      this.replacedUntil = this.now() + delay;
      this.wait("replaced", delay);
      return;
    }
    this.fail(attempt);
  }

  /** The attempt failed or its socket dropped: retry with full-jitter backoff from 1 s to 5 min. */
  private fail(attempt: Attempt): void {
    if (attempt.retired) return;
    this.retire(attempt);
    if (this.ended) return;
    const delay = Math.max(
      RECONNECT_BASE_MS,
      Math.floor(this.rand() * Math.min(RECONNECT_CAP_MS, RECONNECT_BASE_MS * 2 ** this.failures))
    );
    this.failures += 1;
    if (this.failures === 1 || this.failures % 5 === 0) {
      const code = attempt.closeCode === null ? "none" : String(attempt.closeCode);
      console.warn(`[Decisions] Relay connection lost (close ${code}); retrying in ${delay} ms`);
    }
    this.wait("reconnecting", delay);
  }

  private wait(state: "reconnecting" | "replaced", delay: number): void {
    if (this.ended) return;
    this.clearRetry();
    this.publish({ state, nextAttemptAt: this.now() + delay });
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.begin();
    }, delay);
    this.retryTimer.unref?.();
  }

  private retire(attempt: Attempt): void {
    if (attempt.retired) return;
    attempt.retired = true;
    if (this.current === attempt) this.current = null;
    if (attempt.helloTimer) clearTimeout(attempt.helloTimer);
    attempt.helloTimer = null;
    attempt.controller.abort();
    for (const off of attempt.offs.splice(0)) off();
    const bridge = attempt.bridge;
    if (bridge) {
      // Keys it reloaded after a rotation carry on into the next attempt.
      this.identity = bridge.ctx.identity;
      void bridge.stop().catch(() => {});
    }
    attempt.socket?.detach();
  }

  /** Stops for this lifetime and shows why; nothing here reconnects after it. */
  private halt(status: RelayConnectionStatus): void {
    if (this.ended) return;
    this.end();
    if (this.current) this.retire(this.current);
    this.publish(status);
  }

  private end(): void {
    this.ended = true;
    this.clearRetry();
    for (const off of this.watchers.splice(0)) off();
    // Reports to the relay stop now: a stalled one must not hold up the local
    // record of an answer being typed. A delivery's report is sent again next
    // lifetime; a failure's is best effort, as the library makes it.
    this.lifetime.abort();
    const delivery = this.delivery;
    this.delivery = null;
    if (delivery) this.stopping = delivery.stop();
  }

  private clearRetry(): void {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
  }

  private publish(status: RelayConnectionStatus): void {
    if (sameStatus(this.status, status)) return;
    this.status = status;
    this.o.onStatus(status);
  }
}
