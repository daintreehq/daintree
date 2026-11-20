import crypto from "node:crypto";
import { AppError } from "../../utils/errorTypes.js";
import { keepAwakeRequestUrl, keepAwakeUrlProblem } from "../cloud/agent37/agent37KeepAwake.js";
import type { KeepAwakeArmRequest, KeepAwakeStatus } from "../cloud/machineKeeperLink.js";
import type { HostIdleActorSource } from "./HostIdleTracker.js";

/** Something on this machine that Agent 37's edge forwards a port's requests to. */
export interface KeepAwakeListener {
  readonly port: number;
  /** A nonce a coming request should carry; a few may be outstanding at once. */
  expect(nonce: string): void;
  /** Whether a request carrying `nonce` reached this listener, forgetting it either way. */
  take(nonce: string): boolean;
  close(): void;
}

export interface KeepAwakeKeeperDeps {
  idle: Pick<HostIdleActorSource, "observation">;
  /** Opens a listener on a port the system picks, reachable from Agent 37's edge. */
  listen(): Promise<KeepAwakeListener>;
  fetch?: typeof fetch;
  /** Wall-clock time, for expiries and what is reported. */
  now?: () => number;
  /** A clock no wall-clock step moves, for how often requests go out. */
  monotonic?: () => number;
  tickMs?: number;
}

interface HeldUrl {
  url: string;
  resourceId: string;
  expiresAt: number;
  /** A request through it has reached this listener. */
  verified: boolean;
  /** When a request through it last reached this listener; null before the first. */
  reachedAt: number | null;
}

type Outcome = { kind: "reached" } | { kind: "retry" } | { kind: "lost"; problem: string };

/** Often enough that work starting just as Agent 37's timer runs out is still seen in time. */
const TICK_MS = 10_000;
/** Agent 37 sleeps an instance after 5 minutes without activity at the least. */
const PING_EVERY_MS = 60_000;
/**
 * Far below the host's shortest idle time (5 minutes): every request starts
 * only while the host sees work, so none is still out once anything could
 * claim an idle time and sleep the instance. Two in a row (a pass's, then an
 * arm's check) also fit inside the Shell's wait for the arm's answer.
 */
const REQUEST_TIMEOUT_MS = 10_000;
const RETRY_BASE_MS = 15_000;
const RETRY_MAX_MS = 60_000;
/** A listener opened for a URL that never came is closed after this long. */
const LISTENER_GRACE_MS = 5 * 60_000;

const EXPIRED =
  "The link Daintree gave this host to keep Agent 37 from sleeping it expired. Connect to it from Daintree to renew it.";
const REFUSED = "Agent 37 no longer accepts the link Daintree gave this host to keep it awake.";
const NOT_ARRIVED = "A request through the link Daintree gave this host never arrived at it.";
const UNREACHED = "Agent 37 couldn't reach this host through the link Daintree gave it.";
const PORT_CLOSED = "This host's port closed while it checked that link. Ask for its port again.";
/** A URL that never reached this listener is given up on after this many tries that may have passed. */
const UNVERIFIED_TRIES = 3;

function shuttingDown(): AppError {
  return new AppError({ code: "UNSUPPORTED", message: "This host is shutting down" });
}

/**
 * Holds an Agent 37 instance awake while its host sees work, with no Shell
 * connected (#17918). Agent 37 counts only traffic on the instance's URLs as
 * activity, and the one credential it scopes to a single instance is a signed
 * URL for one port, which a Shell mints and hands over on every link. While
 * the host's idle clock sees work, this sends a request through that URL to
 * its own listener every minute; once the host is idle it sends nothing, so
 * Agent 37's own idle timer sleeps the instance after its idle time.
 *
 * The URL lives only in this process and is never reported or logged. Each
 * request carries a fresh nonce that must reach the listener, so a URL that
 * answers from anywhere but this machine is dropped. One request is out at a
 * time.
 */
export class KeepAwakeKeeper {
  private listener: KeepAwakeListener | null = null;
  private opening: Promise<KeepAwakeListener> | null = null;
  private listenerProblem: string | null = null;
  private held: HeldUrl | null = null;
  /**
   * A URL that reached this listener and still works, kept while the one that
   * replaced it hasn't yet: taken back if that one is dropped.
   */
  private fallback: HeldUrl | null = null;
  private problem: string | null = null;
  /** When the last request that reached this listener went out, by the monotonic clock. */
  private lastSentAt = Number.NEGATIVE_INFINITY;
  private retryAt = Number.NEGATIVE_INFINITY;
  private failures = 0;
  private generation = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private graceTimer: ReturnType<typeof setTimeout> | null = null;
  private running: Promise<void> | null = null;
  private controller: AbortController | null = null;
  /** An arm's own check is out: no pass sends meanwhile. */
  private verifying: AbortController | null = null;
  /** Arms in the order they came, so a late one from a link since gone can't land over a newer one. */
  private arms: Promise<unknown> = Promise.resolve();
  private disposed = false;

  constructor(private readonly deps: KeepAwakeKeeperDeps) {}

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  private mono(): number {
    return (this.deps.monotonic ?? (() => performance.now()))();
  }

  status(): KeepAwakeStatus {
    const held = this.held;
    return {
      port: this.listener?.port ?? null,
      expiresAt: held?.expiresAt ?? null,
      reachedAt: held?.reachedAt ?? null,
      problem: held ? null : (this.problem ?? this.listenerProblem),
    };
  }

  /** Opens the listener if it isn't open, once every URL handed over so far is taken or refused. */
  async open(): Promise<KeepAwakeStatus> {
    await this.arms;
    if (this.disposed) throw shuttingDown();
    try {
      await this.ensureListener();
    } catch {
      // Said in the status; the Shell asks again on its next link.
    }
    if (!this.held) this.scheduleClose();
    return this.status();
  }

  /**
   * Holds this URL in place of any other, once it is checked to reach this
   * listener: at once while the host sees work, otherwise on the first request
   * it sends. Refused, the URL it held stays; replaced by one not checked yet,
   * a URL that reached it is taken back if the new one is dropped. Taken one
   * at a time, in order.
   */
  arm(request: KeepAwakeArmRequest): Promise<KeepAwakeStatus> {
    const taken = this.arms.then(() => this.armNow(request));
    this.arms = taken.catch(() => {});
    return taken;
  }

  private async armNow(request: KeepAwakeArmRequest): Promise<KeepAwakeStatus> {
    if (this.disposed) throw shuttingDown();
    const refuse = (message: string): never => {
      // A port opened for this URL alone closes again in time.
      if (!this.held && !this.disposed) this.scheduleClose();
      throw new AppError({ code: "VALIDATION", message, userMessage: message });
    };
    if (request.expiresAt <= this.now()) refuse("That link has already expired.");
    const listener = this.listener;
    if (!listener) {
      return refuse("This host has no port open for that link. Ask for its port first.");
    }
    const wrong = keepAwakeUrlProblem(request.url, request.resourceId, listener.port);
    if (wrong) refuse(wrong);
    // Held open while the URL for it is checked.
    if (this.graceTimer) clearTimeout(this.graceTimer);
    this.graceTimer = null;
    const candidate: HeldUrl = {
      url: request.url,
      resourceId: request.resourceId,
      expiresAt: request.expiresAt,
      verified: false,
      reachedAt: null,
    };
    let outcome: Outcome | null = null;
    if (this.deps.idle.observation().busy) {
      const check = new AbortController();
      this.verifying = check;
      try {
        // A request a pass already sent goes first: one at a time.
        while (this.running) await this.running;
        if (!this.disposed && this.deps.idle.observation().busy) {
          outcome = await this.send(candidate, check.signal);
        }
      } finally {
        if (this.verifying === check) this.verifying = null;
      }
    }
    if (this.disposed) throw shuttingDown();
    if (this.listener !== listener) refuse(PORT_CLOSED);
    if (outcome?.kind === "lost") refuse(outcome.problem);
    const reached = outcome?.kind === "reached";
    // Not checked yet: the last URL that reached it stays behind it, however many came between.
    const working = this.held?.verified ? this.held : this.fallback;
    this.replace(candidate);
    if (!reached && working && working.expiresAt > this.now()) this.fallback = working;
    if (reached) {
      candidate.verified = true;
      candidate.reachedAt = this.now();
      this.lastSentAt = this.mono();
    } else if (outcome?.kind === "retry") {
      this.noteRetry();
    }
    this.timer ??= setInterval(() => void this.tick(), this.deps.tickMs ?? TICK_MS);
    this.timer.unref?.();
    return this.status();
  }

  /** One pass; a pass already under way is shared. Exposed for tests. */
  tick(): Promise<void> {
    if (this.disposed || !this.held) return Promise.resolve();
    this.running ??= this.step().finally(() => {
      this.running = null;
    });
    return this.running;
  }

  dispose(): void {
    this.disposed = true;
    this.verifying?.abort();
    this.verifying = null;
    this.replace(null);
    if (this.graceTimer) clearTimeout(this.graceTimer);
    this.graceTimer = null;
    this.closeListener();
  }

  private async ensureListener(): Promise<KeepAwakeListener> {
    if (this.listener) return this.listener;
    this.opening ??= this.deps
      .listen()
      .then((listener) => {
        if (this.disposed) {
          listener.close();
          throw shuttingDown();
        }
        this.listener = listener;
        this.listenerProblem = null;
        return listener;
      })
      .catch((error: unknown) => {
        this.listenerProblem =
          "This host couldn't open a port for Agent 37 to reach it, so it can't keep the machine awake.";
        throw error;
      })
      .finally(() => {
        this.opening = null;
      });
    return this.opening;
  }

  /** Closes a listener no URL uses once a Shell has had time to hand one over. */
  private scheduleClose(): void {
    if (this.graceTimer) clearTimeout(this.graceTimer);
    this.graceTimer = setTimeout(() => {
      this.graceTimer = null;
      if (!this.held && !this.verifying) this.closeListener();
    }, LISTENER_GRACE_MS);
    this.graceTimer.unref?.();
  }

  private closeListener(): void {
    this.listener?.close();
    this.listener = null;
  }

  /** A new URL, or none. A request already out under the old one is abandoned, and nothing it finds counts. */
  private replace(next: HeldUrl | null): void {
    this.generation += 1;
    this.controller?.abort();
    this.controller = null;
    this.held = next;
    this.fallback = null;
    this.lastSentAt = Number.NEGATIVE_INFINITY;
    this.retryAt = Number.NEGATIVE_INFINITY;
    this.failures = 0;
    if (next) {
      this.problem = null;
      if (this.graceTimer) clearTimeout(this.graceTimer);
      this.graceTimer = null;
    } else if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Lets go of the URL held, taking back the one it replaced if that still works. */
  private drop(problem: string): void {
    const fallback = this.fallback;
    if (fallback && fallback.expiresAt > this.now()) {
      this.replace(fallback);
      return;
    }
    this.replace(null);
    this.problem = problem;
    if (!this.disposed) this.scheduleClose();
  }

  private noteRetry(): void {
    this.failures += 1;
    const delay = RETRY_BASE_MS * 2 ** (this.failures - 1) * (0.8 + Math.random() * 0.4);
    this.retryAt = this.mono() + Math.min(delay, RETRY_MAX_MS);
  }

  private async step(): Promise<void> {
    const held = this.held;
    if (!held) return;
    if (this.now() >= held.expiresAt) {
      this.drop(EXPIRED);
      return;
    }
    if (this.fallback && this.now() >= this.fallback.expiresAt) this.fallback = null;
    if (this.verifying) return;
    // Only while the host sees work: nothing sent then is still out once an idle time can end.
    if (!this.deps.idle.observation().busy) return;
    if (this.mono() < this.retryAt) return;
    if (held.verified && this.mono() - this.lastSentAt < PING_EVERY_MS) return;
    const generation = this.generation;
    const controller = new AbortController();
    this.controller = controller;
    const startedAt = this.mono();
    let outcome: Outcome;
    try {
      outcome = await this.send(held, controller.signal);
    } finally {
      if (this.controller === controller) this.controller = null;
    }
    if (this.disposed || this.generation !== generation) return;
    if (outcome.kind === "lost") {
      this.drop(outcome.problem);
      return;
    }
    if (outcome.kind === "retry") {
      if (!held.verified && this.failures + 1 >= UNVERIFIED_TRIES) {
        this.drop(UNREACHED);
        return;
      }
      this.noteRetry();
      return;
    }
    this.failures = 0;
    this.retryAt = Number.NEGATIVE_INFINITY;
    held.verified = true;
    held.reachedAt = this.now();
    this.fallback = null;
    this.lastSentAt = startedAt;
  }

  /** One request through the URL, carrying a nonce only this listener knows to expect. */
  private async send(held: HeldUrl, signal: AbortSignal): Promise<Outcome> {
    const listener = this.listener;
    // Its port gone, the URL reaches nothing here.
    if (!listener) return { kind: "lost", problem: NOT_ARRIVED };
    if (this.now() >= held.expiresAt) return { kind: "lost", problem: EXPIRED };
    const nonce = crypto.randomBytes(16).toString("hex");
    listener.expect(nonce);
    const fetchFn = this.deps.fetch ?? globalThis.fetch.bind(globalThis);
    let status: number;
    try {
      const response = await fetchFn(keepAwakeRequestUrl(held.url, nonce), {
        method: "GET",
        redirect: "error",
        cache: "no-store",
        signal: AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]),
      });
      status = response.status;
      await response.body?.cancel().catch(() => {});
    } catch {
      // Arrived, its answer slow or lost on the way back: it went through the edge all the same.
      return listener.take(nonce) ? { kind: "reached" } : { kind: "retry" };
    }
    const arrived = listener.take(nonce);
    if (status >= 200 && status < 300) {
      return arrived ? { kind: "reached" } : { kind: "lost", problem: NOT_ARRIVED };
    }
    if (status === 401 || status === 403 || status === 410) {
      return { kind: "lost", problem: this.now() >= held.expiresAt ? EXPIRED : REFUSED };
    }
    if (status === 404) return { kind: "lost", problem: NOT_ARRIVED };
    // A 502 is the edge not reaching the port, perhaps for a moment; anything else may pass too.
    return { kind: "retry" };
  }
}
