import { net, powerMonitor } from "electron";
import type {
  DeliveryEngine,
  InjectResult,
  InjectionIntent,
  LocalStore,
  LocateResult,
  QuestionOrigin,
  QuestionRow,
  TerminalSink,
  WebSocketLike,
} from "@daintreehq/decisions-client";
import { DecisionsBridge, targetOf } from "@daintreehq/decisions-client";

export type BridgeLock = DecisionsBridge["ctx"]["lock"];

/**
 * A lock whose turns run one at a time, in arrival order, as the library's
 * own mutex does: it doesn't export one, and its bridges only ever call `run`.
 * One per connection lifetime, shared by every bridge over its store.
 */
export function newBridgeLock(): BridgeLock {
  let tail: Promise<unknown> = Promise.resolve();
  const lock = {
    run<T>(fn: () => Promise<T>): Promise<T> {
      const turn = tail.then(fn);
      tail = turn.catch(() => {});
      return turn;
    },
  };
  return lock as unknown as BridgeLock;
}

/**
 * The relay socket through Chromium's network stack, as the relay's HTTP
 * already goes (`net.fetch`), so both follow the system proxy and trust store.
 * Its `onX` handlers and `readyState` are the WHATWG ones the library drives.
 */
export function chromiumWebSocket(url: string): WebSocketLike {
  return new net.WebSocket(url) as unknown as WebSocketLike;
}

/**
 * Stands between the library and a real socket so Daintree sees each close
 * code before the library acts on it: the library stops on 4409 without
 * saying why, and only the code tells a replacement from any other stop.
 */
export class ObservedSocket implements WebSocketLike {
  onopen: WebSocketLike["onopen"] = null;
  onmessage: WebSocketLike["onmessage"] = null;
  onclose: WebSocketLike["onclose"] = null;
  onerror: WebSocketLike["onerror"] = null;

  constructor(
    private readonly socket: WebSocketLike,
    observeClose: (code: number) => void
  ) {
    socket.onopen = (event) => this.onopen?.(event);
    socket.onmessage = (event) => this.onmessage?.(event);
    socket.onerror = (event) => this.onerror?.(event);
    socket.onclose = (event) => {
      observeClose(event.code);
      this.onclose?.(event);
    };
  }

  get readyState(): number {
    return this.socket.readyState;
  }

  send(data: string): void {
    this.socket.send(data);
  }

  close(code?: number, reason?: string): void {
    this.socket.close(code, reason);
  }

  /** Lets go of the real socket's events and closes it, if it isn't already. */
  detach(): void {
    const socket = this.socket;
    socket.onopen = socket.onmessage = socket.onerror = socket.onclose = null;
    try {
      socket.close(1000, "client stop");
    } catch {
      // Already closed.
    }
  }
}

/** The `wss:` origin a relay's `https:` origin (or loopback `http:`) serves its socket on. */
export function socketOriginOf(relayOrigin: string): string {
  return relayOrigin.replace(/^http/, "ws");
}

/** True when the socket address is on the relay's own origin; the ticket goes nowhere else. */
export function isRelaySocketUrl(url: string, relayOrigin: string): boolean {
  return URL.parse(url)?.origin === socketOriginOf(relayOrigin);
}

/** Refused because the attempt it belonged to was retired. */
export class RetiredAttemptError extends Error {
  constructor() {
    super("This relay connection attempt has ended");
    this.name = "RetiredAttemptError";
  }
}

/**
 * The target, with every method refused once `isRetired()` turns true. A
 * stopped bridge doesn't wait for work it already started, so an attempt
 * that has been retired must not reach the store or keys again: its frames
 * and pumps stop at their next call, and the work they leave is redone by the
 * next attempt from what was committed. Calls already handed on finish.
 */
export function retireable<T extends object>(target: T, isRetired: () => boolean): T {
  return new Proxy(target, {
    get(object, property) {
      const value: unknown = Reflect.get(object, property, object);
      if (typeof value !== "function") return value;
      return (...args: unknown[]) =>
        isRetired()
          ? Promise.reject(new RetiredAttemptError())
          : (value as (...a: unknown[]) => unknown).apply(object, args);
    },
  });
}

/**
 * The sink a socket attempt's bridge runs with. Answers are typed by the
 * lifetime's delivery (`AnswerDelivery`, #16017), never by an attempt: every
 * pane reads as present but busy, so an attempt's engine, which is also
 * inert (`inertAttemptDelivery`), types nothing.
 */
export const holdingTerminalSink: TerminalSink = {
  locate: async (origin: QuestionOrigin): Promise<LocateResult> => ({
    state: "alive",
    target: targetOf(origin),
  }),
  isIdle: async () => false,
  inject: async (): Promise<InjectResult> => ({ outcome: "held", reason: "socket-attempt" }),
  hasMarker: async () => false,
};

/** The lifetime's delivery, as a socket attempt's inert engine reports to it. */
export interface LifetimeDelivery {
  /** An advisory notice waits for the ledger (#17941). */
  readonly replayHeld: boolean;
  request(): void;
  /** Whether an advisory notice would wait for the ledger, on the lifetime engine's clock. */
  ledgerHolds(questionId: string, opts?: { start?: boolean }): Promise<boolean>;
}

/**
 * Makes a socket attempt's delivery engine inert, as the lifetime's delivery
 * types every answer (#16017). From 0.9.0 the bridge reopens delivery a stop
 * closed, as it starts and on any pump that finds it closed, so the engine's
 * `stopped` no longer holds: its drain does nothing instead, reading no rows
 * and reporting no receipts. Its inbox waits for a closure notice being typed
 * before it applies a reopen; the lifetime's engine is the one typing it, so
 * the attempt asks that one. An advisory notice of the lifetime's waits for
 * the ledger the attempt reads (#17941): the attempt sees that wait as its
 * own, so once its read settles, its drain asks the lifetime's delivery to
 * try again, without waiting for it. Whether a notice waits, as `get_decision`
 * reads it, is the lifetime engine's answer on its own clock, so the two never
 * disagree. `lifetime` is null once the attempt has ended.
 */
export function inertAttemptDelivery(
  engine: DeliveryEngine,
  closureWrite: (questionId: string) => Promise<void> | null,
  lifetime: () => LifetimeDelivery | null = () => null
): void {
  engine.drain = async () => {
    const delivery = lifetime();
    if (delivery?.replayHeld === true) delivery.request();
    return { delivered: 0, deferred: 0, needsAttention: 0, uncertain: 0 };
  };
  Object.defineProperty(engine, "replayHeld", {
    configurable: true,
    get: () => lifetime()?.replayHeld === true,
  });
  const ownHolds = engine.ledgerHolds.bind(engine);
  engine.ledgerHolds = (questionId, opts) =>
    (lifetime() ?? { ledgerHolds: ownHolds }).ledgerHolds(questionId, opts);
  engine.closureWrite = closureWrite;
}

/**
 * An attempt's drain is inert (`inertAttemptDelivery`), so it never reports
 * a delivery for the bridge to announce. The rows the bridge reads before
 * each drain to tell what it delivered, on every pump and every ask, would be
 * read for nothing, every settled question with them (#18033): the attempt
 * drains without that read.
 */
export function drainWithoutAnnouncing(bridge: { delivery: Pick<DeliveryEngine, "drain"> }): void {
  Object.defineProperty(bridge, "deliverNow", {
    configurable: true,
    writable: true,
    value: async (): Promise<void> => {
      await bridge.delivery.drain();
    },
  });
}

const noop = (): void => {};

/**
 * A pump asked for while one runs, run once more after it. The library joins
 * such a call to the pass in flight, which may already have read its outbox:
 * a question committed then would reach the relay only on the next pump, 30 s
 * later (#18002). Every call made meanwhile shares the one pass after it,
 * which waits on the passes in flight alone, never on the advisory read the
 * library runs beside them. A call made once that pass has started queues
 * another. Each caller still settles as the pass it joined does; the pass
 * after is extra work, so it fails to `report`, as a background pump does.
 */
export class TrailingPump {
  private queued: { started: Promise<void>; done: Promise<void> } | null = null;

  constructor(
    private readonly pass: () => Promise<void>,
    private readonly inFlight: () => Promise<unknown> | null,
    private readonly report: (error: Error) => void
  ) {}

  run(): Promise<void> {
    const running = this.inFlight();
    const joined = this.pass();
    if (running === null) return joined;
    this.queued ??= this.after(running);
    return Promise.all([joined, this.queued.done]).then(noop);
  }

  /** Settles once the queued pass has started, from when the library's `idle()` sees it; null with none queued. */
  started(): Promise<void> | null {
    return this.queued?.started ?? null;
  }

  /**
   * Starts a pass once none is in flight. One another call started meanwhile
   * may have read before a call sharing this pass was made, so it's waited out
   * too.
   */
  private after(running: Promise<unknown>): { started: Promise<void>; done: Promise<void> } {
    let done: Promise<void> = Promise.resolve();
    const start = async (current: Promise<unknown>): Promise<void> => {
      await current.then(noop, noop);
      const next = this.inFlight();
      if (next !== null) {
        await start(next);
        return;
      }
      this.queued = null;
      try {
        done = this.pass();
      } catch (error) {
        done = Promise.reject(error as Error);
      }
    };
    const started = start(running);
    return {
      started,
      done: started
        .then(() => done)
        .catch((error: unknown) => {
          try {
            this.report(error instanceof Error ? error : new Error(String(error)));
          } catch {
            // A listener's own failure: its callers still settle as the pass they joined.
          }
        }),
    };
  }
}

/**
 * A socket attempt's bridge, whose pump never joins a pass that may already
 * have read past what the call was made for (`TrailingPump`). The library's
 * own calls, from an ask, a cancel, a thread post and the end of a replay,
 * reach the override too. A stopped or revoked bridge, and a library without
 * the pass where this reads it, pump as the library does.
 */
export class AttemptBridge extends DecisionsBridge {
  private trailing: TrailingPump | undefined;

  override pump(): Promise<void> {
    if (this.state === "stopped" || this.state === "revoked") return super.pump();
    this.trailing ??= new TrailingPump(
      () => super.pump(),
      () => (this as unknown as { pumping?: Promise<unknown> | null }).pumping ?? null,
      (error) => this.reportPumpError(error)
    );
    return this.trailing.run();
  }

  override idle(): Promise<void> {
    const queued = this.trailing?.started() ?? null;
    return queued === null ? super.idle() : queued.then(() => super.idle());
  }

  /** On the bridge's `error`, where the library reports a background pump's failure. */
  private reportPumpError(error: Error): void {
    const emit = (this as unknown as { emitError?: (e: Error) => void }).emitError;
    if (typeof emit === "function") emit.call(this, error);
    else console.warn("[Decisions] A relay pump failed:", error.message);
  }
}

/**
 * The store as a socket attempt's bridge sees it once delivery runs for the
 * lifetime (#16017). The attempt's own delivery engine never types, so it
 * sees no injection intents: on start it would otherwise reconcile the
 * lifetime engine's injections as ones a crash interrupted. Each answer its
 * inbox makes deliverable, and each change to a question's follow-ups
 * (#16231), is passed on once that write has committed.
 */
export function socketBridgeStore<T extends LocalStore>(store: T, onDeliverable: () => void): T {
  return new Proxy(store, {
    get(object, property) {
      const value: unknown = Reflect.get(object, property, object);
      if (property === "openIntents") return async (): Promise<InjectionIntent[]> => [];
      if (property === "updateQuestion") {
        return (id: string, patch: Partial<QuestionRow>) => {
          const written = object.updateQuestion(id, patch);
          if (patch.delivery_status === "desktop-received" || patch.messages_json !== undefined) {
            written.then(onDeliverable, () => {});
          }
          return written;
        };
      }
      return typeof value === "function"
        ? (value as (...args: unknown[]) => unknown).bind(object)
        : value;
    },
  });
}

/** Calls `onResume` each time the machine wakes from sleep. */
export function watchResume(onResume: () => void): () => void {
  powerMonitor.on("resume", onResume);
  return () => {
    powerMonitor.off("resume", onResume);
  };
}
