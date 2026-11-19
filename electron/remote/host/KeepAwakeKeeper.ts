import crypto from "node:crypto";
import { AppError } from "../../utils/errorTypes.js";
import { keepAwakeRequestUrl, keepAwakeUrlProblem } from "../cloud/agent37/agent37KeepAwake.js";
import type { KeepAwakeArmRequest, KeepAwakeStatus } from "../cloud/machineKeeperLink.js";
import type { HostIdleActorSource } from "./HostIdleTracker.js";

/** Something on this machine that Agent 37's edge forwards a port's requests to. */
export interface KeepAwakeListener {
  readonly port: number;
  /** The one nonce the next request should carry; any earlier one is forgotten. */
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
  now?: () => number;
  tickMs?: number;
}

interface HeldUrl {
  url: string;
  resourceId: string;
  expiresAt: number;
  /** A request through it has reached this listener. */
  verified: boolean;
}

type Outcome = { kind: "reached" } | { kind: "retry" } | { kind: "lost"; problem: string };

const TICK_MS = 30_000;
/** Agent 37 sleeps an instance after 5 minutes without activity at the least. */
const PING_EVERY_MS = 60_000;
/**
 * Far below the host's shortest idle time (5 minutes): every request starts
 * only while the host sees work, so none is still out once anything could
 * claim an idle time and sleep the instance.
 */
const REQUEST_TIMEOUT_MS = 20_000;
const RETRY_BASE_MS = 15_000;
const RETRY_MAX_MS = 60_000;
/** A listener opened for a URL that never came is closed after this long. */
const LISTENER_GRACE_MS = 5 * 60_000;

const EXPIRED =
  "The link Daintree gave this host to keep Agent 37 from sleeping it expired. Connect to it from Daintree to renew it.";
const REFUSED = "Agent 37 no longer accepts the link Daintree gave this host to keep it awake.";
const ELSEWHERE = "The link Daintree gave this host reaches something other than this machine.";
const UNREACHED = "Agent 37 couldn't reach this host through the link Daintree gave it.";
/** A URL that never reached this listener is given up on after this many tries that may have passed. */
const UNVERIFIED_TRIES = 3;

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
 * answers from anywhere but this machine is dropped.
 */
export class KeepAwakeKeeper {
  private listener: KeepAwakeListener | null = null;
  private opening: Promise<KeepAwakeListener> | null = null;
  private listenerProblem: string | null = null;
  private held: HeldUrl | null = null;
  private problem: string | null = null;
  private reachedAt: number | null = null;
  private lastSentAt = Number.NEGATIVE_INFINITY;
  private retryAt = 0;
  private failures = 0;
  private generation = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private graceTimer: ReturnType<typeof setTimeout> | null = null;
  private running: Promise<void> | null = null;
  private controller: AbortController | null = null;
  /** Arms in the order they came, so a late one from a link since gone can't land over a newer one. */
  private arms: Promise<unknown> = Promise.resolve();
  private disposed = false;

  constructor(private readonly deps: KeepAwakeKeeperDeps) {}

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  status(): KeepAwakeStatus {
    const held = this.held;
    return {
      port: this.listener?.port ?? null,
      expiresAt: held?.expiresAt ?? null,
      reachedAt: held ? this.reachedAt : null,
      problem: held ? null : (this.problem ?? this.listenerProblem),
    };
  }

  /** Opens the listener if it isn't open, once every URL handed over so far is taken or refused. */
  async open(): Promise<KeepAwakeStatus> {
    await this.arms;
    if (this.disposed) {
      throw new AppError({ code: "UNSUPPORTED", message: "This host is shutting down" });
    }
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
   * it sends. Refused, the URL it held stays. Taken one at a time, in order.
   */
  arm(request: KeepAwakeArmRequest): Promise<KeepAwakeStatus> {
    const taken = this.arms.then(() => this.armNow(request));
    this.arms = taken.catch(() => {});
    return taken;
  }

  private async armNow(request: KeepAwakeArmRequest): Promise<KeepAwakeStatus> {
    if (this.disposed) {
      throw new AppError({ code: "UNSUPPORTED", message: "This host is shutting down" });
    }
    const refuse = (message: string): never => {
      throw new AppError({ code: "VALIDATION", message, userMessage: message });
    };
    if (request.expiresAt <= this.now()) refuse("That link has already expired.");
    const listener = this.listener;
    if (!listener) refuse("This host has no port open for that link. Ask for its port first.");
    const wrong = keepAwakeUrlProblem(request.url, request.resourceId, listener!.port);
    if (wrong) refuse(wrong);
    const candidate: HeldUrl = {
      url: request.url,
      resourceId: request.resourceId,
      expiresAt: request.expiresAt,
      verified: false,
    };
    let reached = false;
    if (this.deps.idle.observation().busy) {
      const outcome = await this.send(candidate, new AbortController().signal);
      if (this.disposed) {
        throw new AppError({ code: "UNSUPPORTED", message: "This host is shutting down" });
      }
      if (outcome.kind === "lost") refuse(outcome.problem);
      reached = outcome.kind === "reached";
      // Unreachable for now: taken on trust, and its first request says whether it works.
    }
    this.replace({ ...candidate, verified: reached });
    if (reached) {
      this.reachedAt = this.now();
      this.lastSentAt = this.now();
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
          throw new AppError({ code: "UNSUPPORTED", message: "This host is shutting down" });
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
      if (!this.held) this.closeListener();
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
    this.retryAt = 0;
    this.failures = 0;
    if (next) {
      this.problem = null;
      if (this.graceTimer) clearTimeout(this.graceTimer);
      this.graceTimer = null;
    } else {
      this.reachedAt = null;
      this.lastSentAt = Number.NEGATIVE_INFINITY;
      if (this.timer) clearInterval(this.timer);
      this.timer = null;
    }
  }

  private drop(problem: string): void {
    this.replace(null);
    this.problem = problem;
    if (!this.disposed) this.scheduleClose();
  }

  private async step(): Promise<void> {
    const held = this.held;
    if (!held) return;
    if (this.now() >= held.expiresAt) {
      this.drop(EXPIRED);
      return;
    }
    // Only while the host sees work: nothing sent then is still out once an idle time can end.
    if (!this.deps.idle.observation().busy) return;
    if (this.now() < this.retryAt) return;
    if (held.verified && this.now() - this.lastSentAt < PING_EVERY_MS) return;
    const generation = this.generation;
    const controller = new AbortController();
    this.controller = controller;
    const startedAt = this.now();
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
      this.failures += 1;
      if (!held.verified && this.failures >= UNVERIFIED_TRIES) {
        this.drop(UNREACHED);
        return;
      }
      const delay = RETRY_BASE_MS * 2 ** (this.failures - 1) * (0.8 + Math.random() * 0.4);
      this.retryAt = this.now() + Math.min(delay, RETRY_MAX_MS);
      return;
    }
    this.failures = 0;
    this.retryAt = 0;
    held.verified = true;
    this.lastSentAt = startedAt;
    this.reachedAt = this.now();
  }

  /** One request through the URL, carrying a nonce only this listener knows to expect. */
  private async send(held: HeldUrl, signal: AbortSignal): Promise<Outcome> {
    const listener = this.listener;
    // Its port gone, the URL reaches nothing here.
    if (!listener) return { kind: "lost", problem: ELSEWHERE };
    if (this.now() >= held.expiresAt) return { kind: "lost", problem: EXPIRED };
    const nonce = crypto.randomBytes(16).toString("hex");
    listener.expect(nonce);
    const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
    const fetchFn = this.deps.fetch ?? globalThis.fetch.bind(globalThis);
    let status: number;
    try {
      const response = await fetchFn(keepAwakeRequestUrl(held.url, nonce), {
        method: "GET",
        redirect: "error",
        cache: "no-store",
        signal: AbortSignal.any([signal, timeout]),
      });
      status = response.status;
      await response.body?.cancel().catch(() => {});
    } catch {
      listener.take(nonce);
      return { kind: "retry" };
    }
    const arrived = listener.take(nonce);
    if (status >= 200 && status < 300) {
      return arrived ? { kind: "reached" } : { kind: "lost", problem: ELSEWHERE };
    }
    if (status === 401 || status === 403 || status === 410) {
      return { kind: "lost", problem: this.now() >= held.expiresAt ? EXPIRED : REFUSED };
    }
    if (status === 404) return { kind: "lost", problem: ELSEWHERE };
    // A 502 is the edge not reaching the port, perhaps for a moment; anything else may pass too.
    return { kind: "retry" };
  }
}
