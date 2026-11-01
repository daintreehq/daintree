import type { Duplex } from "node:stream";
import {
  compareHandshake,
  isBlockingMismatch,
  type HandshakeMismatch,
  type HostHandshakeInfo,
  type HostPreviousEnd,
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
import { LinkSession, type LinkCloseInfo, type LinkSessionOptions } from "../link/session.js";
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
  | {
      status: "connecting";
      attempt: number;
      /** See {@link LinkClient.restartAnnounced}. */
      restarting?: true;
    }
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
       * we saw, not why: a slow host reads quiet, and the link stays up until
       * its transport closes or the idle ceiling gives up.
       */
      quietSince: number | null;
    }
  | {
      status: "unreachable";
      lastSeenAt: number | null;
      detail: string | null;
      /** ssh reached the host and found no Daintree listening there in Host mode. */
      hostModeOff?: true;
      /** See {@link LinkClient.restartAnnounced}. */
      restarting?: true;
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
  /**
   * The host's process is not the one that served this link's previous
   * session: it restarted, and nothing it ran before is still running. False
   * whenever either WELCOME didn't say, as an older host's doesn't.
   */
  hostRestarted: boolean;
  /**
   * How the host's previous process ended, as the host recorded it, when it
   * restarted and the record says it ended uncleanly. Absent for a planned
   * restart, and from a host before it.
   */
  previousEnd?: HostPreviousEnd;
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
  /** How long a session that outlived a sleep has to answer after the wake before it is redialled. */
  wakeProbeMs?: number;
  /**
   * When the host was last heard from by any link before this one (the
   * registry's record), so a link made after a release or at launch still
   * reads a restart as one.
   */
  lastSeenAt?: () => number | null;
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

/** Past the 5 s ping and its answer: long enough that one is overdue. */
const QUIET_AFTER_MS = 7_000;
/** How long after a host was last heard from a "host mode off" still reads as a restart. */
const HOST_RESTART_GRACE_MS = 2 * 60_000;
/**
 * Longest wait between dials while the host is restarting by its own say:
 * short enough that it is picked back up within a couple of seconds of
 * listening again, for no longer than the restart grace.
 */
const RESTART_RETRY_MS = 1_000;
const QUIET_CHECK_MS = 1_000;
/**
 * Long enough for a link that survived the sleep to answer a ping once the
 * network is back; one that didn't is redialled well before the idle timeout.
 */
const WAKE_PROBE_MS = 5_000;
/** Longest a stop waits for its GOODBYE to leave before letting go of the transport. */
const GOODBYE_WAIT_MS = 2_000;

/** Settles once the socket has closed, or after `GOODBYE_WAIT_MS` whatever happens. */
function socketClosed(socket: Duplex): Promise<void> {
  if (socket.destroyed) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      socket.off("close", done);
      resolve();
    };
    const timer = setTimeout(done, GOODBYE_WAIT_MS);
    timer.unref?.();
    socket.once("close", done);
  });
}

type HandshakeOutcome =
  | { kind: "welcome"; welcome: WelcomeMessage }
  | { kind: "reject"; reject: RejectMessage }
  | { kind: "closed"; reason: string };

/**
 * A failed handshake that knowledge gone stale would explain: the host
 * refused the token (it relaunched with a new one), or the link closed with
 * no word from the host (nothing listens on that socket any more). A host
 * that answered otherwise (busy, shutting down, another build) said so itself.
 */
function staleKnowledgeMayExplain(outcome: HandshakeOutcome, session: LinkSession): boolean {
  if (outcome.kind === "reject") return outcome.reject.reason === "unauthorized";
  return outcome.kind === "closed" && session.closedWith?.by !== "remote";
}

export class LinkClient {
  private state: LinkClientState = { status: "disconnected" };
  private running = false;
  private failures = 0;
  private attempt = 0;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private attemptAbort: AbortController | null = null;
  /** The next dial asks the host for everything again: a person's Retry. */
  private dialFresh = false;
  private connection: LinkTransportConnection | null = null;
  private current: LinkSession | null = null;
  private sessionId: string | null = null;
  /** The secret the last WELCOME carried, presented with `sessionId` to resume. */
  private resumeSecret: string | null = null;
  /** The host process the last WELCOME named, if it named one. */
  private hostLaunchId: string | null = null;
  private lastSeenAt: number | null = null;
  /** The last dial found no Host mode there while that still read as a restart. */
  private restartSeen = false;
  /**
   * When the host said it was shutting down (closing the last session, or
   * refusing a HELLO) since the link was last up; null when it hasn't. Not
   * moved by later refusals, so the restart it starts has one deadline.
   */
  private shutdownHeardAt: number | null = null;
  private restartExpiry: ReturnType<typeof setTimeout> | null = null;
  /** What the last logged failure said, so a host down for hours logs once, not every retry. */
  private lastLoggedFailure: string | null = null;
  private generation = 0;
  private readonly releasing = new Set<Promise<void>>();
  private readonly released = new WeakMap<LinkTransportConnection, Promise<void>>();
  /** A stop's GOODBYE on its way out, which letting go of the connection waits for. */
  private readonly goodbyes = new WeakMap<LinkTransportConnection, Promise<void>>();
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

  /**
   * The host was heard from moments before its last answer said no Daintree
   * is listening there, and the link hasn't connected since: what a restart
   * looks like, though nothing here can say that it is one.
   */
  get restarting(): boolean {
    return this.restartSeen || this.restartAnnounced;
  }

  /**
   * The host said it was shutting down, within a restart's grace: its own
   * word that it is going away, read as coming back for as long as that is
   * plausible. Unlike {@link restarting}, never inferred.
   */
  get restartAnnounced(): boolean {
    if (this.shutdownHeardAt === null) return false;
    const since = this.now() - this.shutdownHeardAt;
    return since >= 0 && since < HOST_RESTART_GRACE_MS;
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

  /**
   * Try now instead of waiting for the backoff (also leaves a version
   * mismatch). An attempt under way is left to finish, so asking for the link
   * while a slow host answers doesn't cut it off; `restart`, for a person's
   * Retry, abandons it and dials afresh.
   */
  retryNow(options: { restart?: boolean } = {}): void {
    if (!this.running || this.state.status === "connected") return;
    if (this.attemptAbort) {
      if (options.restart !== true) return;
      // The next generation below makes it stale: it lets go of what it opened.
      this.attemptAbort.abort();
      this.attemptAbort = null;
    }
    // Rather than trusting what earlier links learned about the host.
    if (options.restart === true) this.dialFresh = true;
    this.clearRetry();
    void this.connect();
  }

  /**
   * The machine just woke. A session that outlived the sleep has to answer
   * within the wake probe or is redialled, asking to resume; a retry the
   * backoff was holding goes now. An attempt under way is left to finish.
   */
  noteSystemResumed(): void {
    if (!this.running) return;
    if (this.current?.isOpen) {
      this.current.probe(this.options.wakeProbeMs ?? WAKE_PROBE_MS, "no answer after wake");
      return;
    }
    if (this.state.status === "unreachable" && this.state.retryAt !== null) this.retryNow();
  }

  async stop(): Promise<void> {
    this.running = false;
    this.generation++;
    this.clearRetry();
    this.attemptAbort?.abort();
    this.attemptAbort = null;
    const session = this.current;
    this.current = null;
    const connection = this.connection;
    if (session) this.closeForStop(session, connection);
    if (connection) void this.release(connection);
    await Promise.all([...this.releasing]);
    this.failures = 0;
    this.restartSeen = false;
    this.clearShutdown();
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
    this.setState(this.connecting(this.attempt));
    const abort = new AbortController();
    this.attemptAbort = abort;
    let fresh = this.dialFresh;
    this.dialFresh = false;

    // At most twice: a connection opened from what earlier links learned gets
    // one fresh dial, in this same attempt, when its handshake fails in a way
    // stale knowledge would explain.
    for (;;) {
      let connection: LinkTransportConnection;
      try {
        connection = await this.options.transport.open(abort.signal, {
          mayStart: !this.restartAnnounced,
          ...(fresh ? { fresh: true } : {}),
        });
      } catch (err) {
        if (this.attemptAbort === abort) this.attemptAbort = null;
        if (stale()) return;
        const hostModeOff = err instanceof HostModeOffError;
        // A host heard from moments ago that now says host mode is off is most
        // likely restarting: it removes host.json on the way down and writes it
        // again on the way up, so that window is worth retrying through. A time
        // ahead of the clock (it moved back) says nothing about a restart.
        const heard = this.lastHeard();
        const sinceHeard = heard === null ? null : this.now() - heard;
        const restarting =
          hostModeOff &&
          (this.restartAnnounced ||
            (sinceHeard !== null && sinceHeard >= 0 && sinceHeard < HOST_RESTART_GRACE_MS));
        this.restartSeen = restarting;
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
        await this.release(connection);
        return;
      }
      // Something is listening there again, whatever its handshake says.
      this.restartSeen = false;
      this.connection = connection;

      const session = new LinkSession(connection.socket, {
        ...this.options.session,
        role: "client",
      });
      // Past the transport, the signal reaches nothing: end the session the handshake waits on.
      const abandon = () => this.endAttempt(session, connection);
      abort.signal.addEventListener("abort", abandon, { once: true });
      const outcome = await this.handshake(session, connection.token);
      abort.signal.removeEventListener("abort", abandon);
      const refresh =
        !fresh && connection.remembered === true && staleKnowledgeMayExplain(outcome, session);
      // Held through the fresh dial, so a retryNow can't start another attempt beside it.
      if (!refresh && this.attemptAbort === abort) this.attemptAbort = null;
      if (stale()) {
        this.endAttempt(session, connection);
        await this.release(connection);
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

      // Heard before the release, which can take as long as a stalled transport:
      // the restart's grace runs from when the host said it.
      if (outcome.kind === "reject") {
        if (outcome.reject.reason === "shutting-down") this.heardShutdown();
      } else if (session.closedWith) {
        // A GOODBYE in place of the WELCOME, from a host already on its way down.
        this.noteClose(session.closedWith);
      }
      await this.release(connection);
      // Another attempt (a retryNow while this one was releasing) owns the link now.
      if (stale()) return;
      if (refresh) {
        logger.debug("Dialling the remote host afresh: what the last link learned didn't hold", {
          hostId: this.options.hostId ?? null,
          attempt: this.attempt,
          outcome: outcome.kind === "reject" ? outcome.reject.reason : "closed",
        });
        fresh = true;
        continue;
      }
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
      return;
    }
  }

  /**
   * End an attempt this link no longer wants. The host may already have
   * resumed the session its HELLO named, and takes a GOODBYE as the Shell
   * leaving for good: only a stop says one. An attempt given up for another
   * leaves the session parked for that one to resume (#15877).
   */
  private endAttempt(session: LinkSession, connection: LinkTransportConnection): void {
    if (this.running) session.drop("attempt abandoned");
    else this.closeForStop(session, connection);
  }

  /**
   * Close with the GOODBYE that ends the session on the host, watched before
   * it goes out: disposing the transport destroys its socket, and done at
   * once it can cut the GOODBYE off, so the host holds the session for a
   * resume nobody makes. {@link release} waits for it; the session itself
   * destroys the socket once its end grace is out.
   */
  private closeForStop(session: LinkSession, connection: LinkTransportConnection | null): void {
    if (connection && !session.isClosed) {
      this.goodbyes.set(connection, socketClosed(connection.socket));
    }
    session.close("client stopped");
  }

  private noteClose(info: LinkCloseInfo): void {
    if (info.by === "remote" && info.reason === "shutting-down") this.heardShutdown();
  }

  private heardShutdown(): void {
    if (this.shutdownHeardAt !== null) return;
    this.shutdownHeardAt = this.now();
    // Said now, not after a release that can take as long as a stalled transport.
    if (this.state.status === "connecting" && !this.state.restarting) {
      this.setState(this.connecting(this.state.attempt));
    }
    // A dial under way when the grace runs out would otherwise keep saying
    // restarting until it finishes, which a stalled transport makes 30 s.
    this.restartExpiry = setTimeout(() => {
      this.restartExpiry = null;
      const state = this.state;
      if ((state.status === "connecting" || state.status === "unreachable") && state.restarting) {
        const { restarting: _restarting, ...rest } = state;
        this.setState(rest);
      }
    }, HOST_RESTART_GRACE_MS);
    this.restartExpiry.unref?.();
  }

  private clearShutdown(): void {
    this.shutdownHeardAt = null;
    if (this.restartExpiry) clearTimeout(this.restartExpiry);
    this.restartExpiry = null;
  }

  /** When the host was last heard from, by this link or by one before it. */
  private lastHeard(): number | null {
    const recorded = this.options.lastSeenAt?.() ?? null;
    if (recorded === null) return this.lastSeenAt;
    return this.lastSeenAt === null ? recorded : Math.max(recorded, this.lastSeenAt);
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
          session.open({
            holdInbound: true,
            peerReadsFragments: message.body.messageFragments === true,
          });
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
            messageFragments: true,
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
      if (session.closedWith) this.noteClose(session.closedWith);
      void this.release(connection);
      this.fail(session.closedWith?.reason ?? "closed");
      return;
    }
    const previousSessionId = this.sessionId;
    const hostRestarted =
      !welcome.resumed &&
      this.hostLaunchId !== null &&
      welcome.hostLaunchId !== undefined &&
      welcome.hostLaunchId !== this.hostLaunchId;
    const link = { hostId: this.options.hostId ?? null, sessionId: welcome.sessionId };
    const accepted = {
      ...link,
      attempt: this.attempt,
      hostName: welcome.hostName,
      ...(buildMismatch ? { buildMismatch } : {}),
    };
    if (welcome.resumed) {
      logger.info("Remote host link resumed", accepted);
    } else if (hostRestarted) {
      // Its terminals went with the process that ran them.
      logger.info("Remote host restarted; the previous session ended with it", {
        ...accepted,
        previousSessionId,
        previousEnd: welcome.previousEnd ?? null,
      });
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
    this.restartSeen = false;
    this.clearShutdown();
    this.current = session;
    this.sessionId = welcome.sessionId;
    this.resumeSecret = welcome.resumeSecret ?? null;
    // A WELCOME that names no process leaves nothing to compare the next one with.
    this.hostLaunchId = welcome.hostLaunchId ?? null;
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
    // A stalled host keeps its link until the transport closes or the idle
    // ceiling passes; meanwhile it says nothing has arrived, so a keystroke
    // that goes nowhere isn't a mystery.
    const quietAfterMs = this.options.quietAfterMs ?? QUIET_AFTER_MS;
    // Time asleep isn't the host going quiet.
    const awakeSince = this.options.session?.awakeSince ?? ((since: number) => this.now() - since);
    const quietTimer =
      quietAfterMs > 0
        ? setInterval(
            () => {
              if (this.current !== session) return;
              const heard = session.lastReceivedAt;
              const next = awakeSince(heard) > quietAfterMs ? heard : null;
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
      this.noteClose(info);
      // Down from now: releasing the old forward can take as long as a stalled
      // transport does, and the link must not read as connected meanwhile.
      this.setState(this.connecting(this.attempt + 1));
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
      hostRestarted,
      ...(hostRestarted && welcome.previousEnd && { previousEnd: welcome.previousEnd }),
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

  /** Dispose a connection once, however many paths let go of it (a stop and the attempt it abandoned). */
  private release(connection: LinkTransportConnection): Promise<void> {
    if (this.connection === connection) this.connection = null;
    const pending = this.released.get(connection);
    if (pending) return pending;
    const goodbye = this.goodbyes.get(connection);
    const done = (goodbye ? goodbye.then(() => connection.dispose()) : connection.dispose()).catch(
      () => {}
    );
    this.released.set(connection, done);
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
    const announced = this.restartAnnounced;
    const base = Math.min(
      announced ? Math.min(maxMs, RESTART_RETRY_MS) : maxMs,
      initialMs * 2 ** Math.min(this.failures - 1, 30)
    );
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
      ...(announced && !options.parked ? { restarting: true as const } : {}),
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

  private connecting(attempt: number): LinkClientState {
    return {
      status: "connecting",
      attempt,
      ...(this.restartAnnounced ? { restarting: true as const } : {}),
    };
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
