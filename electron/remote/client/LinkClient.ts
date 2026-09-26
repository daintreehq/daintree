import {
  compareHandshake,
  type HandshakeMismatch,
  type HostHandshakeInfo,
} from "../../../shared/types/remoteHosts.js";
import { formatErrorMessage } from "../../../shared/utils/errorMessage.js";
import { Lane } from "../link/frames.js";
import {
  ControlKind,
  type LinkClientInfo,
  type LinkMessage,
  type RejectMessage,
  type WelcomeMessage,
} from "../link/messages.js";
import { LinkSession, type LinkSessionOptions } from "../link/session.js";
import { TransportError, type LinkTransport, type LinkTransportConnection } from "./transport.js";

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
      handshake: HostHandshakeInfo;
      hostName: string;
      sessionId: string;
    }
  | {
      status: "unreachable";
      lastSeenAt: number | null;
      detail: string | null;
      /** Epoch ms of the next attempt. */
      retryAt: number;
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
  transport: LinkTransport;
  handshake: HostHandshakeInfo;
  client: LinkClientInfo;
  session?: Omit<LinkSessionOptions, "role">;
  backoff?: { initialMs?: number; maxMs?: number; jitter?: number };
  random?: () => number;
  now?: () => number;
}

const SHORT_SESSION_MS = 5_000;

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
  private lastSeenAt: number | null = null;
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
    this.setState({ status: "connecting", attempt: this.attempt });
    const abort = new AbortController();
    this.attemptAbort = abort;

    let connection: LinkTransportConnection;
    try {
      connection = await this.options.transport.open(abort.signal);
    } catch (err) {
      if (this.attemptAbort === abort) this.attemptAbort = null;
      if (stale()) return;
      this.fail(err instanceof TransportError ? err.detail : formatErrorMessage(err, "failed"));
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
      if (mismatch) {
        session.close("version mismatch");
        await this.release(connection);
        this.mismatch(mismatch, outcome.welcome.handshake, null);
        return;
      }
      this.established(session, connection, outcome.welcome);
      return;
    }

    await this.release(connection);
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
    welcome: WelcomeMessage
  ): void {
    if (session.isClosed) {
      void this.release(connection);
      this.fail(session.closedWith?.reason ?? "closed");
      return;
    }
    this.current = session;
    this.sessionId = welcome.sessionId;
    this.failures = 0;
    this.attempt = 0;
    this.lastSeenAt = this.now();
    const establishedAt = this.now();
    const connected = (rttMs: number | null): LinkClientState => ({
      status: "connected",
      rttMs,
      handshake: welcome.handshake,
      hostName: welcome.hostName,
      sessionId: welcome.sessionId,
    });
    this.setState(connected(null));
    session.onRtt((rtt) => {
      if (this.current === session) {
        this.lastSeenAt = this.now();
        this.setState(connected(rtt));
      }
    });
    session.onClose((info) => {
      if (this.current !== session) return;
      this.current = null;
      this.lastSeenAt = Math.max(this.lastSeenAt ?? 0, session.lastReceivedAt);
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
    this.setState({
      status: "version-mismatch",
      mismatch,
      local: this.options.handshake,
      remote,
      observed: observed ? { workingAgents: observed.workingAgents, at: this.now() } : null,
    });
  }

  private fail(detail: string | null): void {
    this.failures++;
    const { initialMs = 500, maxMs = 30_000, jitter = 0.3 } = this.options.backoff ?? {};
    const base = Math.min(maxMs, initialMs * 2 ** Math.min(this.failures - 1, 30));
    const delay = Math.max(0, Math.round(base * (1 - jitter * this.random())));
    this.setState({
      status: "unreachable",
      lastSeenAt: this.lastSeenAt,
      detail,
      retryAt: this.now() + delay,
    });
    this.clearRetry();
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      if (this.running) void this.connect();
    }, delay);
    this.retryTimer.unref?.();
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
