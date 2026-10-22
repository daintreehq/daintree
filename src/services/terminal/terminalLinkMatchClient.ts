import { logWarn } from "@/utils/logger";
import type { TerminalLinkPatternMatch } from "@shared/utils/pluginTerminalLinks";
import type {
  TerminalLinkMatchMessage,
  TerminalLinkMatchRequest,
  TerminalLinkPatternSpec,
} from "./terminalLinkMatchWork";

/** How long one pattern may run before the worker is terminated and the pattern switched off. */
const MATCHER_DEADLINE_MS = 1_000;

/** How long a request may wait for its first pattern to start, which covers a cold worker loading. */
const STARTUP_DEADLINE_MS = 10_000;

export type TerminalLinkMatches = Record<string, TerminalLinkPatternMatch[]>;

interface Pending {
  request: TerminalLinkMatchRequest;
  resolve: (matches: TerminalLinkMatches | null) => void;
}

interface InFlight extends Pending {
  /** The pattern the worker last said it started. */
  runningKey: string | null;
  timer: ReturnType<typeof setTimeout>;
}

/** The part of a `Worker` the client drives. */
export interface TerminalLinkWorker {
  postMessage(request: TerminalLinkMatchRequest): void;
  terminate(): void;
  onmessage: ((event: { data: TerminalLinkMatchMessage }) => void) | null;
  onerror: ((event: unknown) => void) | null;
}

function createDefaultWorker(): TerminalLinkWorker {
  const worker = new Worker(new URL("../../workers/terminalLinkMatch.worker.ts", import.meta.url), {
    type: "module",
  });
  const wrapped: TerminalLinkWorker = {
    postMessage: (request) => worker.postMessage(request),
    terminate: () => worker.terminate(),
    onmessage: null,
    onerror: null,
  };
  worker.onmessage = (event: MessageEvent<TerminalLinkMatchMessage>) => wrapped.onmessage?.(event);
  worker.onerror = (event) => wrapped.onerror?.(event);
  return wrapped;
}

/**
 * Runs plugin terminal-link patterns in a worker (#13798). One request is in
 * flight at a time and the newest waiting one replaces any older: a hover that
 * moved on has no use for its answer. A pattern that runs past the deadline
 * gets the worker terminated and is switched off for the session, and so is
 * one the worker reports as slow. Fails closed: with no worker, no patterns
 * match.
 */
export class TerminalLinkMatchClient {
  private worker: TerminalLinkWorker | null = null;
  private failed = false;
  private nextId = 1;
  private inFlight: InFlight | null = null;
  private waiting: Pending | null = null;
  private readonly slowKeys = new Set<string>();

  constructor(private readonly createWorker: () => TerminalLinkWorker = createDefaultWorker) {}

  /**
   * The matches of each usable pattern in `text`, keyed by matcher, or `null`
   * when this request was superseded or the worker couldn't answer.
   */
  match(
    text: string,
    matchers: readonly TerminalLinkPatternSpec[]
  ): Promise<TerminalLinkMatches | null> {
    if (this.failed) return Promise.resolve(null);
    const usable = matchers.filter((matcher) => !this.slowKeys.has(matcher.key));
    if (usable.length === 0) return Promise.resolve({});
    return new Promise((resolve) => {
      const pending: Pending = { request: { id: this.nextId++, text, matchers: usable }, resolve };
      if (this.inFlight === null) {
        this.post(pending);
        return;
      }
      this.waiting?.resolve(null);
      this.waiting = pending;
    });
  }

  isSlow(key: string): boolean {
    return this.slowKeys.has(key);
  }

  private post(pending: Pending): void {
    const worker = this.ensureWorker();
    if (worker === null) {
      pending.resolve(null);
      return;
    }
    this.inFlight = {
      ...pending,
      runningKey: null,
      timer: setTimeout(() => this.onDeadline(), STARTUP_DEADLINE_MS),
    };
    worker.postMessage(pending.request);
  }

  private onMessage(message: TerminalLinkMatchMessage): void {
    const inFlight = this.inFlight;
    if (inFlight === null || message.id !== inFlight.request.id) return;
    clearTimeout(inFlight.timer);
    if (message.type === "start") {
      inFlight.runningKey = message.key;
      inFlight.timer = setTimeout(() => this.onDeadline(), MATCHER_DEADLINE_MS);
      return;
    }
    for (const key of message.slowKeys) this.switchOff(key, "ran slowly");
    this.inFlight = null;
    inFlight.resolve(message.matches);
    this.postWaiting();
  }

  private onDeadline(): void {
    const inFlight = this.inFlight;
    if (inFlight === null) return;
    this.inFlight = null;
    if (inFlight.runningKey !== null) this.switchOff(inFlight.runningKey, "didn't finish");
    this.worker?.terminate();
    this.worker = null;
    inFlight.resolve(null);
    this.postWaiting();
  }

  private postWaiting(): void {
    const waiting = this.waiting;
    this.waiting = null;
    if (waiting === null) return;
    const matchers = waiting.request.matchers.filter((matcher) => !this.slowKeys.has(matcher.key));
    if (matchers.length === 0) {
      waiting.resolve({});
      return;
    }
    this.post({ request: { ...waiting.request, matchers }, resolve: waiting.resolve });
  }

  private switchOff(key: string, reason: string): void {
    if (this.slowKeys.has(key)) return;
    this.slowKeys.add(key);
    logWarn(`Switched off a plugin terminal link matcher that ${reason}, for this session`, {
      matcher: key,
    });
  }

  private ensureWorker(): TerminalLinkWorker | null {
    if (this.worker !== null) return this.worker;
    if (this.failed) return null;
    try {
      const worker = this.createWorker();
      worker.onmessage = (event) => this.onMessage(event.data);
      worker.onerror = (event) => this.fail(event);
      this.worker = worker;
      return worker;
    } catch (error) {
      this.fail(error);
      return null;
    }
  }

  private fail(error: unknown): void {
    if (this.failed) return;
    this.failed = true;
    logWarn("Plugin terminal link patterns are off: their worker couldn't run", { error });
    this.worker?.terminate();
    this.worker = null;
    const inFlight = this.inFlight;
    this.inFlight = null;
    if (inFlight !== null) {
      clearTimeout(inFlight.timer);
      inFlight.resolve(null);
    }
    this.waiting?.resolve(null);
    this.waiting = null;
  }
}

let client: TerminalLinkMatchClient | null = null;

/** The view's one client, created on the first hover that has plugin patterns to run. */
export function getTerminalLinkMatchClient(): TerminalLinkMatchClient {
  client ??= new TerminalLinkMatchClient();
  return client;
}

/** Test-only: swap the view's client, or drop it with `null`. */
export function _setTerminalLinkMatchClientForTest(next: TerminalLinkMatchClient | null): void {
  client = next;
}
