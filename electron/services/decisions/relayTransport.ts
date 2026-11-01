import { networkInterfaces } from "node:os";
import { net, powerMonitor } from "electron";
import type {
  InjectResult,
  LocateResult,
  QuestionOrigin,
  TerminalSink,
  WebSocketLike,
} from "@daintreehq/decisions-client";
import { targetOf } from "@daintreehq/decisions-client";

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
 * Until delivery lands (#16017), received answers stay saved and undelivered:
 * every pane reads as present but busy, so the delivery engine defers without
 * changing a question's status, and nothing is ever typed.
 */
export const holdingTerminalSink: TerminalSink = {
  locate: async (origin: QuestionOrigin): Promise<LocateResult> => ({
    state: "alive",
    target: targetOf(origin),
  }),
  isIdle: async () => false,
  inject: async (): Promise<InjectResult> => ({ outcome: "held", reason: "delivery-not-wired" }),
  hasMarker: async () => false,
};

/**
 * This machine's network as a comparable string: whether Chromium thinks it
 * is online, and every external interface address. Addresses stay in memory.
 */
export function networkFingerprint(
  online: boolean,
  interfaces: ReturnType<typeof networkInterfaces> = networkInterfaces()
): string {
  const addresses: string[] = [];
  for (const [name, entries] of Object.entries(interfaces)) {
    for (const entry of entries ?? []) {
      if (!entry.internal) addresses.push(`${name}/${entry.family}/${entry.address}`);
    }
  }
  return `${online ? "online" : "offline"}|${addresses.sort().join(",")}`;
}

export interface NetworkWatchOptions {
  /** How often to compare; the default is five seconds. */
  intervalMs?: number;
  /** Reads the fingerprint and whether the machine is online. */
  read?: () => { online: boolean; fingerprint: string };
}

const NETWORK_POLL_MS = 5_000;

function readNetwork(): { online: boolean; fingerprint: string } {
  const online = net.isOnline();
  return { online, fingerprint: networkFingerprint(online) };
}

/**
 * Electron's main process has no network-change event, so this compares the
 * network every few seconds while a relay connection is wanted, and calls
 * `onChange` with whether it is online once it differs from the last look.
 * It sees link and address changes; a change only of route, DNS or proxy
 * shows nothing here.
 */
export function watchNetwork(
  onChange: (online: boolean) => void,
  options: NetworkWatchOptions = {}
): () => void {
  const read = options.read ?? readNetwork;
  let last: string | null = null;
  const look = () => {
    let reading: { online: boolean; fingerprint: string };
    try {
      reading = read();
    } catch {
      return;
    }
    const changed = last !== null && reading.fingerprint !== last;
    last = reading.fingerprint;
    if (changed) onChange(reading.online);
  };
  look();
  const timer = setInterval(look, options.intervalMs ?? NETWORK_POLL_MS);
  timer.unref?.();
  return () => clearInterval(timer);
}

/** Calls `onResume` each time the machine wakes from sleep. */
export function watchResume(onResume: () => void): () => void {
  powerMonitor.on("resume", onResume);
  return () => {
    powerMonitor.off("resume", onResume);
  };
}
