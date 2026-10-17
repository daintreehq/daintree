import {
  compareHandshake,
  isBlockingMismatch,
  type HandshakeMismatch,
  type HostHandshakeInfo,
} from "../../../shared/types/remoteHosts.js";
import { formatErrorMessage } from "../../../shared/utils/errorMessage.js";
import { createLogger } from "../../utils/logger.js";
import { Lane } from "../link/frames.js";
import {
  ControlKind,
  type LinkClientInfo,
  type LinkMessage,
  type RejectMessage,
  type WelcomeMessage,
} from "../link/messages.js";
import { LinkSession, type LinkSessionOptions } from "../link/session.js";
import {
  HostModeOffError,
  SshAccessError,
  UnusableConnectionError,
  TransportError,
  type LinkTransport,
  type LinkTransportConnection,
} from "./transport.js";

const logger = createLogger("main:LinkClient");

/**
 * Keeps one host's link up: opens the transport, authenticates with HELLO,
 * and reconnects with capped, jittered exponential backoff, presenting the
 * previous session id so the host can resume it. A version mismatch stops
 * retrying and is reported with both handshakes; an unreachable host is
 * reported with what was observed (ssh's stderr, the rejection, the close
 * reason) and when the host was last heard from.
 */

export type LinkClientState =
  | { status: "disconnected" }
  | { status: "connecting"; attempt: number }
  | {
      status: "connected";
      rttMs: number | null;
      /** When the reply behind `rttMs` arrived; null until the first ping answers. */
      rttSampledAt: number | null;
      handshake: HostHandshakeInfo;
      hostName: string;
      sessionId: string;
      /** The host runs a different version or commit; the link is up best effort. */
      buildMismatch: HandshakeMismatch | null;
      /**
       * When the last frame from the host arrived, once nothing has for a
       * while (a ping and its answer are overdue); null while it answers. What
       * we saw, not why: the link stays up until the idle timeout gives up.
       */
      quietSince: number | null;
    }
  | {
      status: "unreachable";
      lastSeenAt: number | null;
      detail: string | null;
      /** ssh reached the host and found no Daintree listening there in Host mode. */
      hostModeOff?: true;
      /**
       * Epoch ms of the next attempt; null when retrying can't help (ssh
       * couldn't log in, Host mode is off there) and the link waits for
       * {@link LinkClient.retryNow}.
       */
      retryAt: number | null;
    }
  | {
      status: "version-mismatch";
      mismatch: HandshakeMismatch;
      local: HostHandshakeInfo;
      remote: HostHandshakeInfo;
      /**
       * What the host said its agents were doing when it refused us, and
       * when; null when it didn't say (a host before this, or a refusal that
       * came as a welcome).
       */
      observed: { workingAgents: number | null; at: number } | null;
    };

export interface LinkSessionEstablished {
  session: LinkSession;
  sessionId: string;
  hostName: string;
  /** True when the host resumed the previous session rather than starting a new one. */
  resumed: boolean;
}

export interface LinkClientOptions {
  /** The registry id of the host this link is to; it tags the link's log lines. */
  hostId?: string;
  transport: LinkTransport;
  handshake: HostHandshakeInfo;
  client: LinkClientInfo;
  session?: Omit<LinkSessionOptions, "role">;
  backoff?: { initialMs?: number; maxMs?: number; jitter?: number };
  random?: () => number;
  now?: () => number;
  /** Silence from the host, in ms, before the link is reported quiet; 0 never reports it. */
  quietAfterMs?: number;
}

const SHORT_SESSION_MS = 5_000;

/**
 * A failure's detail with what changes on every attempt taken out (the
 * per-attempt forward socket's nonce, a Chromium log line's pid and time), so
 * the same failure repeating is recognised as the same.
 */
function failureShape(detail: string | null): string {
  if (detail === null) return "";
  return detail.replace(/\[\d+:\d+\/\d+\.\d+:/g, "[").replace(/\b[0-9a-f]{8,}\b/gi, "<id>");
}

/** Enough of a failure's detail to diagnose it: a probe's whole reply is remote text. */
const MAX_LOGGED_DETAIL_CHARS = 300;

function clipDetail(detail: string | null): string | null {
  if (detail === null || detail.length <= MAX_LOGGED_DETAIL_CHARS) return detail;
  return `${detail.slice(0, MAX_LOGGED_DETAIL_CHARS)}…`;
}

/** Past the 5 s ping and its answer: long enough that one is overdue, well short of the 20 s idle timeout. */
const QUIET_AFTER_MS = 7_000;
/** How long after a host was last heard from a "host mode off" still reads as a restart. */
const HOST_RESTART_GRACE_MS = 2 * 60_000;
const QUIET_CHECK_MS = 1_000;

type HandshakeOutcome =
  | { kind: "welcome"; welcome: WelcomeMessage }
  | { kind: "reject"; reject: RejectMessage }
  | { kind: "closed"; reason: string };

export class LinkClient {
  private state: LinkClientState = { status: "disconnected" };
  private running = false;
  private failures = 0;
  private attempt = 0;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private attemptAbort: AbortController | null = null;
  private connection: LinkTransportConnection | null = null;
  private current: LinkSession | null = null;
  private sessionId: string | null = null;
  /** The secret the last WELCOME carried, presented with `sessionId` to resume. */
  private resumeSecret: string | null = null;
  private lastSeenAt: number | null = null;
  /** What the last logged failure said, so a host down for hours logs once, not every retry. */
  private lastLoggedFailure: string | null = null;
  private generation = 0;
  private readonly releasing = new Set<Promise<void>>();
  private readonly stateListeners = new Set<(state: LinkClientState) => void>();
  private readonly sessionListeners = new Set<(established: LinkSessionEstablished) => void>();
  private readonly now: () => number;
  private readonly random: () => number;

  constructor(private readonly options: LinkClientOptions) {
    this.now = options.now ?? Date.now;
    this.random = options.random ?? Math.random;
  }

  getState(): LinkClientState {
    return this.state;
  }

  get session(): LinkSession | null {
    return this.current;
  }

  get lastSeen(): number | null {
    return this.lastSeenAt;
  }

  /** The session id the host last gave this link, kept while it is down so a resume can ask for it. */
  get lastSessionId(): string | null {
    return this.sessionId;
  }

  onStateChange(listener: (state: LinkClientState) => void): () => void {
    this.stateListeners.add(listener);
    return () => this.stateListeners.delete(listener);
  }

  /** Fires for every established session, new or resumed; register handlers here. */
  onSession(listener: (established: LinkSessionEstablished) => void): () => void {
    this.sessionListeners.add(listener);
    return () => this.sessionListeners.delete(listener);
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    void this.connect();
  }

  /** Try now instead of waiting for the backoff (also leaves a version mismatch). */
  retryNow(): void {
    if (!this.running || this.state.status === "connected" || this.attemptAbort) return;
    this.clearRetry();
    void this.connect();
  }

  async stop(): Promise<void> {
    this.running = false;
    this.generation++;
    this.clearRetry();
    this.attemptAbort?.abort();
    this.attemptAbort = null;
    const session = this.current;
    this.current = null;
    session?.close("client stopped");
    const connection = this.connection;
    if (connection) void this.release(connection);
    await Promise.all([...this.releasing]);
    this.failures = 0;
    this.setState({ status: "disconnected" });
  }

  private async connect(): Promise<void> {
    const generation = ++this.generation;
    const stale = () => generation !== this.generation || !this.running;
    this.attempt++;
    const dial = {
      hostId: this.options.hostId ?? null,
      attempt: this.attempt,
      previousSessionId: this.sessionId,
    };
    // Only the first dial of a run: the retries after it log only when what they see changes.
    if (this.attempt === 1) logger.info("Dialling remote host", dial);
    else logger.debug("Dialling remote host", dial);
    this.setState({ status: "connecting", attempt: this.attempt });
    const abort = new AbortController();
    this.attemptAbort = abort;

    let connection: LinkTransportConnection;
    try {
      connection = await this.options.transport.open(abort.signal);
    } catch (err) {
      if (this.attemptAbort === abort) this.attemptAbort = null;
      if (stale()) return;
      const hostModeOff = err instanceof HostModeOffError;
      // A host heard from moments ago that now says host mode is off is most
      // likely restarting: it removes host.json on the way down and writes it
      // again on the way up, so that window is worth retrying through.
      const restarting =
        hostModeOff &&
        this.lastSeenAt !== null &&
        this.now() - this.lastSeenAt < HOST_RESTART_GRACE_MS;
      this.fail(err instanceof TransportError ? err.detail : formatErrorMessage(err, "failed"), {
        hostModeOff,
        // Otherwise nothing a later attempt does differently would change these.
        parked:
          (hostModeOff && !restarting) ||
          err instanceof SshAccessError ||
          err instanceof UnusableConnectionError,
        // The transport's own words for what failed; its detail is often null.
        ...(err instanceof TransportError ? { failure: err.message } : {}),
      });
      return;
    }
    if (stale()) {
      await connection.dispose().catch(() => {});
      return;
    }
    this.connection = connection;

    const session = new LinkSession(connection.socket, { ...this.options.session, role: "client" });
    const outcome = await this.handshake(session, connection.token);
    if (this.attemptAbort === abort) this.attemptAbort = null;
    if (stale()) {
      session.close("client stopped");
      await connection.dispose().catch(() => {});
      return;
    }

    if (outcome.kind === "welcome") {
      const mismatch = compareHandshake(this.options.handshake, outcome.welcome.handshake);
      if (mismatch && isBlockingMismatch(mismatch)) {
        session.close("version mismatch");
        await this.release(connection);
        if (stale()) return;
        this.mismatch(mismatch, outcome.welcome.handshake, null);
        return;
      }
      this.established(session, connection, outcome.welcome, mismatch);
      return;
    }

    await this.release(connection);
    // Another attempt (a retryNow while this one was releasing) owns the link now.
    if (stale()) return;
    if (outcome.kind === "reject") {
      const { reject } = outcome;
      const mismatch = reject.handshake
        ? compareHandshake(this.options.handshake, reject.handshake)
        : null;
      if (mismatch && reject.handshake) {
        this.mismatch(mismatch, reject.handshake, reject.observed ?? null);
        return;
      }
      this.fail(
        `Host refused the connection: ${reject.reason}${reject.detail ? ` (${reject.detail})` : ""}`
      );
      return;
    }
    this.fail(outcome.reason);
  }

  private handshake(session: LinkSession, token: string): Promise<HandshakeOutcome> {
    return new Promise((resolve) => {
      let done = false;
      const settle = (outcome: HandshakeOutcome) => {
        if (done) return;
        done = true;
        resolve(outcome);
      };
      session.onHandshake((message: LinkMessage) => {
        if (message.lane !== Lane.CONTROL) return;
        if (message.kind === ControlKind.WELCOME) {
          // Open synchronously so frames that follow WELCOME in the same read
          // are accepted, not treated as pre-handshake traffic. They are held
          // until the session listeners have attached their handlers.
          session.open({ holdInbound: true });
          settle({ kind: "welcome", welcome: message.body });
        } else if (message.kind === ControlKind.REJECT) {
          settle({ kind: "reject", reject: message.body });
          session.close("rejected");
        }
      });
      session.onClose((info) => settle({ kind: "closed", reason: info.reason }));
      try {
        session.post({
          lane: Lane.CONTROL,
          kind: ControlKind.HELLO,
          body: {
            handshake: this.options.handshake,
            token,
            client: this.options.client,
            resumeSessionId: this.sessionId,
            resumeSecret: this.sessionId === null ? null : this.resumeSecret,
          },
        });
      } catch (err) {
        session.close("invalid hello");
        settle({ kind: "closed", reason: formatErrorMessage(err, "invalid hello") });
      }
    });
  }

  private established(
    session: LinkSession,
    connection: LinkTransportConnection,
    welcome: WelcomeMessage,
    buildMismatch: HandshakeMismatch | null
  ): void {
    if (session.isClosed) {
      void this.release(connection);
      this.fail(session.closedWith?.reason ?? "closed");
      return;
    }
    const previousSessionId = this.sessionId;
    const link = { hostId: this.options.hostId ?? null, sessionId: welcome.sessionId };
    const accepted = {
      ...link,
      attempt: this.attempt,
      hostName: welcome.hostName,
      ...(buildMismatch ? { buildMismatch } : {}),
    };
    if (welcome.resumed) {
      logger.info("Remote host link resumed", accepted);
    } else if (previousSessionId !== null) {
      // The host gave up the session this Shell asked for: everything open on it is gone.
      logger.info("Remote host started a new session; the previous one was not resumed", {
        ...accepted,
        previousSessionId,
      });
    } else {
      logger.info("Remote host link established", accepted);
    }
    this.lastLoggedFailure = null;
    this.current = session;
    this.sessionId = welcome.sessionId;
    this.resumeSecret = welcome.resumeSecret ?? null;
    this.failures = 0;
    this.attempt = 0;
    this.lastSeenAt = this.now();
    const establishedAt = this.now();
    let rttMs: number | null = null;
    let rttSampledAt: number | null = null;
    let quietSince: number | null = null;
    const connected = (): LinkClientState => ({
      status: "connected",
      rttMs,
      rttSampledAt,
      handshake: welcome.handshake,
      hostName: welcome.hostName,
      sessionId: welcome.sessionId,
      buildMismatch,
      quietSince,
    });
    this.setState(connected());
    session.onRtt((rtt) => {
      if (this.current === session) {
        this.lastSeenAt = this.now();
        rttMs = rtt;
        rttSampledAt = this.now();
        quietSince = null;
        this.setState(connected());
      }
    });
    // A stalled link only closes at the idle timeout; until then it says
    // nothing has arrived, so a keystroke that goes nowhere isn't a mystery.
    const quietAfterMs = this.options.quietAfterMs ?? QUIET_AFTER_MS;
    const quietTimer =
      quietAfterMs > 0
        ? setInterval(
            () => {
              if (this.current !== session) return;
              const heard = session.lastReceivedAt;
              const next = this.now() - heard > quietAfterMs ? heard : null;
              if (next === quietSince) return;
              quietSince = next;
              this.setState(connected());
            },
            Math.max(10, Math.min(QUIET_CHECK_MS, Math.floor(quietAfterMs / 4)))
          )
        : null;
    quietTimer?.unref?.();
    session.onClose((info) => {
      if (quietTimer) clearInterval(quietTimer);
      // Before the guard: stop() lets go of the session before closing it.
      logger.info("Remote host link closed", {
        ...link,
        reason: info.reason,
        by: info.by,
        upMs: this.now() - establishedAt,
      });
      if (this.current !== session) return;
      this.current = null;
      // Before the state below: whoever hears it records when the host was last seen.
      this.lastSeenAt = Math.max(this.lastSeenAt ?? 0, session.lastReceivedAt);
      // Down from now: releasing the old forward can take as long as a stalled
      // transport does, and the link must not read as connected meanwhile.
      this.setState({ status: "connecting", attempt: this.attempt + 1 });
      const generation = this.generation;
      // Release the old forward before the next attempt sets up a new one.
      void this.release(connection).then(() => {
        if (!this.running || generation !== this.generation) return;
        // Reconnect straight away after a session that had been up for a
        // while; one that dies right after the handshake goes through backoff
        // so a host that accepts and immediately drops us isn't hammered.
        if (this.now() - establishedAt < SHORT_SESSION_MS) this.fail(info.reason);
        else void this.connect();
      });
    });
    const established: LinkSessionEstablished = {
      session,
      sessionId: welcome.sessionId,
      hostName: welcome.hostName,
      resumed: welcome.resumed,
    };
    for (const listener of this.sessionListeners) {
      try {
        listener(established);
      } catch {
        // A failing subscriber must not break the link.
      }
    }
    session.releaseInbound();
  }

  private release(connection: LinkTransportConnection): Promise<void> {
    if (this.connection === connection) this.connection = null;
    const done = connection.dispose().catch(() => {});
    this.releasing.add(done);
    void done.finally(() => this.releasing.delete(done));
    return done;
  }

  private mismatch(
    mismatch: HandshakeMismatch,
    remote: HostHandshakeInfo,
    observed: { workingAgents: number | null } | null
  ): void {
    this.failures = 0;
    this.logFailure(
      "Remote host runs a different build; not connecting",
      `mismatch:${mismatch.kind}:${mismatch.remote}`,
      {
        mismatchKind: mismatch.kind,
        local: mismatch.local,
        remote: mismatch.remote,
      }
    );
    this.setState({
      status: "version-mismatch",
      mismatch,
      local: this.options.handshake,
      remote,
      observed: observed ? { workingAgents: observed.workingAgents, at: this.now() } : null,
    });
  }

  private fail(
    detail: string | null,
    options: { hostModeOff?: boolean; parked?: boolean; failure?: string } = {}
  ): void {
    this.failures++;
    const { initialMs = 500, maxMs = 30_000, jitter = 0.3 } = this.options.backoff ?? {};
    const base = Math.min(maxMs, initialMs * 2 ** Math.min(this.failures - 1, 30));
    const delay = Math.max(0, Math.round(base * (1 - jitter * this.random())));
    const retry = options.parked ? "stopped" : "scheduled";
    const signature = [
      options.failure ?? "",
      failureShape(detail),
      options.hostModeOff ? "host-mode-off" : "",
      retry,
    ].join("|");
    this.logFailure("Remote host unreachable", signature, {
      ...(options.failure ? { failure: options.failure } : {}),
      detail: clipDetail(detail),
      ...(options.hostModeOff ? { hostModeOff: true } : {}),
      ...(options.parked ? { stoppedRetrying: true } : { retryInMs: delay }),
    });
    this.clearRetry();
    this.setState({
      status: "unreachable",
      lastSeenAt: this.lastSeenAt,
      detail,
      ...(options.hostModeOff ? { hostModeOff: true as const } : {}),
      retryAt: options.parked ? null : this.now() + delay,
    });
    if (options.parked) return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      if (this.running) void this.connect();
    }, delay);
    this.retryTimer.unref?.();
  }

  /** Info when what went wrong changed since the last one logged, debug while it repeats. */
  private logFailure(message: string, signature: string, context: Record<string, unknown>): void {
    const line = {
      hostId: this.options.hostId ?? null,
      // Zero after a session that dropped soon after its handshake: no dial failed.
      ...(this.attempt > 0 ? { attempt: this.attempt } : {}),
      previousSessionId: this.sessionId,
      ...context,
    };
    if (signature === this.lastLoggedFailure) {
      logger.debug(message, line);
      return;
    }
    this.lastLoggedFailure = signature;
    logger.info(message, line);
  }

  private clearRetry(): void {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
  }

  private setState(state: LinkClientState): void {
    this.state = state;
    for (const listener of this.stateListeners) {
      try {
        listener(state);
      } catch {
        // Ignore subscriber failures.
      }
    }
  }
}
