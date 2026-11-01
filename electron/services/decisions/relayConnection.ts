import {
  DecisionsBridge,
  RelayClient,
  loadIdentity,
  type Identity,
  type KeyStore,
  type LocalStore,
  type PolicyRegistry,
  type SocketState,
  type TerminalSink,
  type WebSocketLike,
} from "@daintreehq/decisions-client";
import { WS_CLOSE } from "@daintreehq/decisions-protocol";
import type { DecisionsConnectionProblem } from "../../../shared/types/decisions.js";
import { normalizeRelayOrigin } from "./decisionsSettings.js";
import type { RelayFetch } from "./relayCheck.js";
import { relayRequests } from "./relayIdentity.js";
import {
  ObservedSocket,
  RetiredAttemptError,
  chromiumWebSocket,
  holdingTerminalSink,
  isRelaySocketUrl,
  retireable,
  watchNetwork,
  watchResume,
} from "./relayTransport.js";

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

/** The store as a connection uses it: the library's, and whether it stopped taking writes. */
export type RelayConnectionStore = LocalStore & { isFaulted?(): boolean };

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
  readonly store: LocalStore;
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
  onStatus(status: RelayConnectionStatus): void;
  /** The relay revoked this identity. Called once, after which nothing reconnects. */
  onRevoked(): void;
  webSocket?: (url: string) => WebSocketLike;
  fetchImpl?: RelayFetch;
  sink?: TerminalSink;
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

  constructor(options: RelayConnectionOptions) {
    this.o = options;
    this.now = options.now ?? Date.now;
    this.rand = options.rand ?? Math.random;
    this.keys = retireable(options.keys, () => this.ended);
    this.store = retireable(options.store, () => this.ended);
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
   * next lifetime picks up from what was committed.
   */
  stop(): void {
    if (this.ended) return;
    this.end();
    if (this.current) this.retire(this.current);
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

  private async prepare(): Promise<void> {
    let identity: Identity;
    try {
      identity = await loadIdentity(this.keys);
    } catch {
      if (!this.ended) this.halt({ state: "not-connected", problem: "keys" });
      return;
    }
    if (this.ended) return;
    const { config } = identity;
    if (
      identity.role !== "owner-desktop" ||
      normalizeRelayOrigin(config.relayOrigin) !== this.o.relay.relayOrigin ||
      config.installationId !== this.o.relay.installationId ||
      config.deviceId !== this.o.relay.deviceId
    ) {
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
    });
    if (this.ended) return;
    this.watchers.push(
      (this.o.watchResume ?? watchResume)(() => this.reconnectNow()),
      (this.o.watchNetwork ?? watchNetwork)((online) => {
        if (online) this.reconnectNow();
      })
    );
    this.begin();
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
      bridge = new DecisionsBridge({
        identity,
        keyStore: this.bridgeKeys(attempt, retireable(this.keys, retired)),
        store: retireable(this.store, retired),
        sink: this.o.sink ?? holdingTerminalSink,
        policy: this.o.policy,
        // The outbox keeps its own retry times, so a request is tried once per pass.
        client: new RelayClient({ identity, fetch: requests.fetch, maxRetries: 0 }),
        webSocket: (url) => this.openSocket(attempt, url),
        ...(this.o.pumpIntervalMs !== undefined ? { pumpIntervalMs: this.o.pumpIntervalMs } : {}),
      });
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
