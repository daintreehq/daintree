import {
  DecisionsBridge,
  DeliveryEngine,
  parseAnswers,
  serializeAnswers,
  type Identity,
  type InjectionIntent,
  type KeyStore,
  type LocalStore,
  type RelayClient,
} from "@daintreehq/decisions-client";
import { NOTIFY_SETTLE_GRACE_MS } from "../../../shared/types/terminalNotify.js";
import type { LaneWake, OwnPane } from "../mcp-server/terminalNotify.js";
import { DaintreeTerminalSink, type DaintreeTerminalSinkDeps } from "./daintreeTerminalSink.js";
import { RetiredAttemptError, retireable } from "./relayTransport.js";

/** A hold on the wake engine's queue (#15999), which takes wakes with the MCP server off. */
export interface DecisionWakeHold {
  queueWake(pane: OwnPane, projectId: string, wake: LaneWake): void;
  release(): void;
}

/**
 * Something happened to a pane that may let it take an answer now: it settled
 * waiting (`settled`), or its run appeared or came back (`appeared`).
 */
export type PaneSignal = "settled" | "appeared";

/** What delivery needs from the rest of main; the lazy entry supplies the real ones. */
export interface AnswerDeliveryDeps extends Omit<DaintreeTerminalSinkDeps, "queueWake" | "now"> {
  /** Takes a hold on the wake engine. Called before the first delivery, and again after a failure. */
  holdWakes(): DecisionWakeHold | Promise<DecisionWakeHold>;
  /** Calls `onPane` on each pane signal; returns the unsubscribe. */
  watchPanes(onPane: (signal: PaneSignal) => void): () => void;
  now?: () => number;
  /** How often to look for answers still waiting; one minute unless a test says otherwise. */
  checkIntervalMs?: number;
}

/** The store as delivery uses it: the library's, and its indexed read of whether anything waits. */
export type AnswerDeliveryStore = LocalStore & { hasPendingDelivery?(): Promise<boolean> };

export interface AnswerDeliveryOptions {
  deps: AnswerDeliveryDeps;
  identity: Identity;
  store: AnswerDeliveryStore;
  keys: KeyStore;
  /** Reports deliveries to the relay; failures leave them to be reported on a later pass. */
  client: RelayClient;
  /** The keys couldn't be reloaded: the connection stops, and nothing more is written. */
  onKeysUnusable(): void;
}

export const DELIVERY_CHECK_INTERVAL_MS = 60_000;
/** Past the wake's settle grace, so a pane that just settled reads as idle when delivery looks. */
const SETTLED_RECHECK_MS = NOTIFY_SETTLE_GRACE_MS + 250;
/** How long a stop waits for an answer being typed to settle before the store stops taking its result. */
export const DELIVERY_SETTLE_MS = 3_000;

/** The store with only intents still in state `intent`: what crash recovery has to reconcile. */
function untypedIntentsOnly<T extends LocalStore>(store: T): T {
  return new Proxy(store, {
    get(object, property) {
      const value: unknown = Reflect.get(object, property, object);
      if (property === "openIntents") {
        return async (): Promise<InjectionIntent[]> =>
          (await object.openIntents()).filter((intent) => intent.state === "intent");
      }
      return typeof value === "function"
        ? (value as (...args: unknown[]) => unknown).bind(object)
        : value;
    },
  });
}

/**
 * Types received Decisions answers into the terminal that asked, for one
 * enabled lifetime with a relay identity (#16017). The store is the
 * authority: an answer waits there, across restarts and a lost connection,
 * until the exact run that asked is at its prompt, and a wake is only how it
 * gets typed.
 *
 * It runs the library's delivery engine over the lifetime's store, apart
 * from the socket's attempts, so an answer already received is typed while
 * the relay is unreachable; only the report to the relay waits for it. The
 * engine lives on a bridge that is never started, which supplies the
 * library's own context: the lock that the socket bridges' inboxes share, so
 * an answer appended while another is marked delivered is never lost.
 *
 * Delivery is tried when the lifetime starts, when a pane settles or its run
 * appears, when an answer arrives, when the socket comes up, and every minute
 * while anything waits (an indexed read, so the minute costs nothing when
 * nothing does). Before the first attempt it reconciles injections a crash
 * interrupted, once the pty host can be asked.
 */
export class AnswerDelivery {
  private readonly o: AnswerDeliveryOptions;
  private readonly store: AnswerDeliveryStore;
  private readonly sink: DaintreeTerminalSink;
  private readonly owner: DecisionsBridge;
  private readonly engine: DeliveryEngine;
  private hold: DecisionWakeHold | null = null;
  private holding: Promise<DecisionWakeHold | null> | null = null;
  private started = false;
  private stopped = false;
  /** No more writes: set once a stop has settled, or at once when the keys failed. */
  private retired = false;
  private recovered = false;
  private requested = false;
  private running: Promise<void> | null = null;
  private settled: Promise<void> | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private settleTimer: ReturnType<typeof setTimeout> | null = null;
  private offPanes: (() => void) | null = null;

  constructor(options: AnswerDeliveryOptions) {
    this.o = options;
    this.store = retireable(options.store, () => this.retired);
    const { deps } = options;
    this.sink = new DaintreeTerminalSink({
      hostId: deps.hostId,
      principalFor: deps.principalFor,
      getPtyClient: deps.getPtyClient,
      queueWake: (pane, projectId, wake) => this.queueWake(pane, projectId, wake),
      ...(deps.now ? { now: deps.now } : {}),
    });
    this.owner = new DecisionsBridge({
      identity: options.identity,
      keyStore: this.keysFor(retireable(options.keys, () => this.retired)),
      store: this.store,
      sink: this.sink,
      client: options.client,
      ...(deps.now ? { now: deps.now } : {}),
    });
    this.engine = this.owner.delivery;
  }

  /** The lock every bridge over this store must use, so answer appends and delivery marks never interleave. */
  get lock(): DecisionsBridge["ctx"]["lock"] {
    return this.owner.ctx.lock;
  }

  /** Starts watching panes and the minute check, and tries delivery now. */
  start(): void {
    if (this.started || this.stopped) return;
    this.started = true;
    this.offPanes = this.o.deps.watchPanes((signal) => {
      if (signal === "appeared") this.request();
      else this.requestAfterSettle();
    });
    this.timer = setInterval(
      () => this.request(),
      this.o.deps.checkIntervalMs ?? DELIVERY_CHECK_INTERVAL_MS
    );
    this.timer.unref?.();
    this.request();
  }

  /** Tries delivery as soon as the attempt running now, if any, is done. */
  request(): void {
    if (this.stopped) return;
    this.requested = true;
    this.running ??= this.run().finally(() => {
      this.running = null;
    });
  }

  /**
   * Stops for good. Nothing new is typed from now on; an answer already being
   * typed settles first, for up to `DELIVERY_SETTLE_MS`, so its outcome is
   * recorded rather than left for the next start to find. Resolves once the
   * store takes nothing more from this delivery.
   */
  stop(): Promise<void> {
    if (this.settled) return this.settled;
    this.stopped = true;
    this.engine.stopped = true;
    this.offPanes?.();
    this.offPanes = null;
    if (this.timer) clearInterval(this.timer);
    if (this.settleTimer) clearTimeout(this.settleTimer);
    this.timer = this.settleTimer = null;
    this.releaseHold();
    const running = this.running;
    this.settled = (async () => {
      if (running) {
        let timeout: ReturnType<typeof setTimeout> | undefined;
        await Promise.race([
          running,
          new Promise<void>((resolve) => {
            timeout = setTimeout(resolve, DELIVERY_SETTLE_MS);
            timeout.unref?.();
          }),
        ]);
        clearTimeout(timeout);
      }
      this.retired = true;
    })();
    return this.settled;
  }

  private requestAfterSettle(): void {
    if (this.stopped) return;
    if (this.settleTimer) clearTimeout(this.settleTimer);
    this.settleTimer = setTimeout(() => {
      this.settleTimer = null;
      this.request();
    }, SETTLED_RECHECK_MS);
    this.settleTimer.unref?.();
  }

  private async run(): Promise<void> {
    while (this.requested && !this.stopped) {
      this.requested = false;
      try {
        await this.attempt();
      } catch (error) {
        // The store refusing a retired delivery is the stop doing its job.
        if (error instanceof RetiredAttemptError || this.stopped) return;
        console.warn(
          "[Decisions] Delivering answers failed:",
          error instanceof Error ? error.name : typeof error
        );
      }
    }
  }

  private async attempt(): Promise<void> {
    if ((await this.ensureHold()) === null || this.stopped) return;
    if (!this.recovered) {
      // Until the pty host can be asked, every run would read as gone and
      // every interrupted injection as uncertain; the next request tries again.
      if (this.o.deps.getPtyClient() === null) return;
      await this.recover();
      this.recovered = true;
    }
    if (this.stopped) return;
    if (this.store.hasPendingDelivery && !(await this.store.hasPendingDelivery())) return;
    await this.engine.drain();
  }

  /**
   * Reconciles injections a crash interrupted, once per lifetime. An intent
   * still in state `intent` may or may not have been typed: the library looks
   * for its marker in the run's scrollback, and anything it can't find is
   * `delivery-uncertain`, never typed again. A `typed` intent was recorded
   * only on the host's proof of the write and needs no search; only its
   * report is outstanding, which the first pass sends. The library would
   * search for it too, and call an answer whose pane has closed since
   * uncertain, so recovery sees only the untyped ones.
   */
  private async recover(): Promise<void> {
    await this.markTypedDelivered();
    if (this.stopped) return;
    const ctx = { ...this.owner.ctx, store: untypedIntentsOnly(this.store) };
    await new DeliveryEngine(ctx, { sink: this.sink }).recover();
  }

  /**
   * The library records an intent as typed before it marks the answer
   * delivered. A crash between the two leaves an answer that would be typed a
   * second time; the typed record is the proof it already was.
   */
  private async markTypedDelivered(): Promise<void> {
    const { ctx } = this.owner;
    for (const intent of await this.store.openIntents()) {
      if (this.stopped) return;
      if (intent.state !== "typed") continue;
      await ctx.lock.run(async () => {
        const row = await this.store.getQuestion(intent.question_id);
        if (!row) return;
        const entries = parseAnswers(row.answers_json);
        const at = entries.findIndex(
          (entry) => entry.revision === intent.answer_revision && entry.deliver && !entry.delivered
        );
        if (at < 0) return;
        entries[at] = { ...entries[at], delivered: true, injection_id: intent.injection_id };
        const stillPending = entries.some((entry) => entry.deliver && !entry.delivered);
        await this.store.updateQuestion(row.question_id, {
          answers_json: serializeAnswers(entries),
          delivered_revision: Math.max(row.delivered_revision, intent.answer_revision),
          delivery_status: stillPending ? row.delivery_status : "terminal-delivered",
          last_injection_id: intent.injection_id,
          error_code: null,
        });
        await ctx.audit.log({
          event: "answer.delivered",
          question_id: row.question_id,
          requirement: row.requirement,
          result: "typed-record",
        });
      });
    }
  }

  private async ensureHold(): Promise<DecisionWakeHold | null> {
    if (this.hold) return this.hold;
    this.holding ??= (async () => {
      try {
        const hold = await this.o.deps.holdWakes();
        if (this.stopped) {
          hold.release();
          return null;
        }
        this.hold = hold;
        return hold;
      } catch (error) {
        console.warn(
          "[Decisions] Couldn't hold the terminal wake engine:",
          error instanceof Error ? error.name : typeof error
        );
        return null;
      } finally {
        this.holding = null;
      }
    })();
    return this.holding;
  }

  private queueWake(pane: OwnPane, projectId: string, wake: LaneWake): void {
    const hold = this.hold;
    if (hold === null || this.stopped) {
      // Never typed: the sink reads the pane again and holds the answer for later.
      wake.report({ kind: "unavailable", reason: "stopped" });
      return;
    }
    hold.queueWake(pane, projectId, wake);
  }

  private releaseHold(): void {
    const hold = this.hold;
    this.hold = null;
    try {
      // Queued answers end untyped and settle as held; one already typing finishes.
      hold?.release();
    } catch (error) {
      console.warn(
        "[Decisions] Releasing the terminal wake hold failed:",
        error instanceof Error ? error.name : typeof error
      );
    }
  }

  /**
   * The keys as the engine reloads them after a key rotation. A reload that
   * fails would leave an answer unopenable, and the library would send it to
   * needs-attention; a keychain that was only locked must not cost an answer
   * that, so a failure stops all writing first and stops the connection.
   */
  private keysFor(keys: KeyStore): KeyStore {
    const unusable = () => {
      if (this.retired) return;
      this.retired = true;
      this.o.onKeysUnusable();
    };
    return {
      load: () =>
        keys.load().then(
          (stored) => {
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
}
