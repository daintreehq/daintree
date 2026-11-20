import { net, powerMonitor } from "electron";
import type {
  DecisionsBridge,
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
import { targetOf } from "@daintreehq/decisions-client";

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

/**
 * Makes a socket attempt's delivery engine inert, as the lifetime's delivery
 * types every answer (#16017). From 0.9.0 the bridge reopens delivery a stop
 * closed, as it starts and on any pump that finds it closed, so the engine's
 * `stopped` no longer holds: its drain does nothing instead, reading no rows
 * and reporting no receipts. Its inbox waits for a closure notice being typed
 * before it applies a reopen; the lifetime's engine is the one typing it, so
 * the attempt asks that one.
 */
export function inertAttemptDelivery(
  engine: DeliveryEngine,
  closureWrite: (questionId: string) => Promise<void> | null
): void {
  engine.drain = async () => ({ delivered: 0, deferred: 0, needsAttention: 0, uncertain: 0 });
  engine.closureWrite = closureWrite;
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
