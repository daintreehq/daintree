import type { z } from "zod";
import type {
  DecisionsHostRuntime,
  DecisionsHostRuntimeObservation,
} from "../../../shared/types/decisionsHosts.js";
import {
  boundedDetail,
  type DecisionsHostEntry,
  type DecisionsHostLink,
  type DecisionsHostsPort,
  type HostAcceptResult,
  type HostCallOutcome,
  type HostIdentityReport,
  type HostRequestResult,
  type OwnerStateAnnouncement,
} from "../../types/decisionsHosts.js";
import {
  DecisionsLinkMethod,
  EnrollHostPayloadSchema,
  HostAcceptResultSchema,
  HostRequestResultSchema,
  HostRuntimePayloadSchema,
  HostStatusResultSchema,
  OwnerStatePayloadSchema,
  type EnrollHostPayload,
} from "./linkMethods.js";

/** Long enough for a Host to open its key file, a keychain prompt included. */
export const HOST_STATUS_TIMEOUT_MS = 75_000;
/** Making keys can wait on the Host's keychain, which has its own 60 s deadline. */
export const HOST_REQUEST_TIMEOUT_MS = 75_000;
/** Sealing the identity waits on the same keychain. */
export const HOST_ACCEPT_TIMEOUT_MS = 75_000;
export const OWNER_STATE_TIMEOUT_MS = 75_000;

export interface DecisionsHostSession {
  readonly isOpen: boolean;
  call(method: string, payload: unknown, options?: { timeoutMs?: number }): Promise<unknown>;
  onClose(listener: () => void): () => void;
  registerCallHandler<S extends z.ZodType>(
    method: string,
    schema: S,
    handler: (payload: z.infer<S>) => unknown
  ): () => void;
}

export interface DecisionsHostsClientDeps {
  /** Every host in the host list, by the id and name this Shell knows it by. */
  hosts(): DecisionsHostEntry[];
  /** The host's current session, or null while it has none. Never dials. */
  sessionFor(hostId: string): DecisionsHostSession | null;
  onSessionOpened(listener: (hostId: string, session: DecisionsHostSession) => void): () => void;
  onHostsChanged(listener: () => void): () => void;
  hold(hostId: string): () => void;
  /**
   * Whether Decisions is on here, and as which owner (#16022), as the setting
   * reads now; null while this computer holds no owner identity, so nothing
   * is announced.
   */
  ownerState(): OwnerStateAnnouncement | null;
  now?: () => number;
}

interface HostReport {
  session: DecisionsHostSession;
  runtime: DecisionsHostRuntime;
  at: number;
}

function codeOf(error: unknown): unknown {
  return (error as { code?: unknown } | null)?.code;
}

function failureOf<T>(error: unknown): HostCallOutcome<T> {
  switch (codeOf(error)) {
    case "UNSUPPORTED":
      return { ok: false, failure: "needs-update" };
    case "HOST_DISCONNECTED":
      return { ok: false, failure: "disconnected" };
    case "OUTCOME_UNKNOWN":
      return { ok: false, failure: "outcome-unknown" };
    // A Host that knows the method but not this step reads it as malformed.
    case "VALIDATION":
      return { ok: false, failure: "needs-update" };
  }
  const message = (error as { message?: unknown } | null)?.message;
  const detail = boundedDetail(typeof message === "string" ? message : undefined);
  return detail === undefined
    ? { ok: false, failure: "failed" }
    : { ok: false, failure: "failed", detail };
}

/**
 * One session to a Host, as Decisions enrolls through it. What goes out is
 * checked against the method's payload schema, and nothing the Host answers
 * is trusted until it has been read against the result's.
 */
class HostLink implements DecisionsHostLink {
  constructor(
    private readonly hostId: string,
    private readonly session: DecisionsHostSession,
    private readonly holdHost: (hostId: string) => () => void
  ) {}

  get isOpen(): boolean {
    return this.session.isOpen;
  }

  onClose(listener: () => void): () => void {
    return this.session.onClose(listener);
  }

  hold(): () => void {
    return this.holdHost(this.hostId);
  }

  async status(): Promise<HostCallOutcome<HostIdentityReport>> {
    const answered = await this.call(
      { step: "status" },
      HostStatusResultSchema,
      HOST_STATUS_TIMEOUT_MS
    );
    return answered.ok ? { ok: true, value: answered.value.identity } : answered;
  }

  request(input: {
    attempt: string;
    label: string;
    replace?: string;
  }): Promise<HostCallOutcome<HostRequestResult>> {
    return this.call(
      {
        step: "request",
        attempt: input.attempt,
        label: input.label,
        ...(input.replace !== undefined ? { replace: input.replace } : {}),
      },
      HostRequestResultSchema,
      HOST_REQUEST_TIMEOUT_MS
    );
  }

  accept(input: { attempt: string; response: string }): Promise<HostCallOutcome<HostAcceptResult>> {
    return this.call(
      { step: "accept", attempt: input.attempt, response: input.response },
      HostAcceptResultSchema,
      HOST_ACCEPT_TIMEOUT_MS
    );
  }

  private async call<S extends z.ZodType>(
    payload: EnrollHostPayload,
    result: S,
    timeoutMs: number
  ): Promise<HostCallOutcome<z.infer<S>>> {
    // Checked here too: a payload the Host would refuse never goes out.
    const sent = EnrollHostPayloadSchema.parse(payload);
    if (!this.session.isOpen) return { ok: false, failure: "disconnected" };
    let raw: unknown;
    try {
      raw = await this.session.call(DecisionsLinkMethod.ENROLL_HOST, sent, { timeoutMs });
    } catch (error) {
      return failureOf(error);
    }
    const parsed = result.safeParse(raw);
    return parsed.success
      ? { ok: true, value: parsed.data as z.infer<S> }
      : { ok: false, failure: "unexpected-answer" };
  }
}

/**
 * Shell side of enrolling Hosts as Decisions devices (#16021): the port
 * Decisions reaches its Hosts through. Each session gets one link, so a
 * reconnect is a new link and never the old one again.
 */
export class DecisionsHostsClient implements DecisionsHostsPort {
  private readonly links = new WeakMap<DecisionsHostSession, HostLink>();
  private readonly wired = new WeakSet<DecisionsHostSession>();
  private readonly reports = new Map<string, HostReport>();
  /** Counts each Host's announcements, so an answer to an older one can't replace a newer one's. */
  private readonly announced = new Map<string, number>();
  private readonly listeners = new Set<() => void>();
  private readonly now: () => number;

  constructor(private readonly deps: DecisionsHostsClientDeps) {
    this.now = deps.now ?? Date.now;
  }

  /**
   * Begins announcing this computer's Decisions to every Host as its link
   * comes up (#16022), and hearing what each reports back. Returns the stop.
   */
  start(): () => void {
    const offOpened = this.deps.onSessionOpened((hostId, session) => this.wire(hostId, session));
    for (const { hostId } of this.deps.hosts()) {
      const session = this.deps.sessionFor(hostId);
      if (session?.isOpen) this.wire(hostId, session);
    }
    return () => {
      offOpened();
      this.listeners.clear();
    };
  }

  hosts(): DecisionsHostEntry[] {
    return this.deps.hosts();
  }

  runtimeOf(hostId: string): DecisionsHostRuntimeObservation | null {
    const report = this.reports.get(hostId);
    if (!report) return null;
    const live = report.session.isOpen && this.deps.sessionFor(hostId) === report.session;
    return { runtime: report.runtime, at: report.at, live };
  }

  announceOwnerState(): void {
    for (const { hostId } of this.deps.hosts()) {
      const session = this.deps.sessionFor(hostId);
      if (session?.isOpen) void this.announce(hostId, session);
    }
  }

  linkFor(hostId: string): DecisionsHostLink | null {
    const session = this.deps.sessionFor(hostId);
    return session?.isOpen ? this.linkOf(hostId, session) : null;
  }

  onLinkOpened(listener: (hostId: string, link: DecisionsHostLink) => void): () => void {
    return this.deps.onSessionOpened((hostId, session) =>
      listener(hostId, this.linkOf(hostId, session))
    );
  }

  onHostsChanged(listener: () => void): () => void {
    const offHosts = this.deps.onHostsChanged(listener);
    this.listeners.add(listener);
    return () => {
      offHosts();
      this.listeners.delete(listener);
    };
  }

  private wire(hostId: string, session: DecisionsHostSession): void {
    if (this.wired.has(session)) return;
    this.wired.add(session);
    const offReport = session.registerCallHandler(
      DecisionsLinkMethod.HOST_RUNTIME,
      HostRuntimePayloadSchema,
      ({ runtime }) => {
        this.observe(hostId, session, runtime);
        return null;
      }
    );
    const offClose = session.onClose(() => {
      offReport();
      offClose();
      // What it said last stands, now as what it said before its link closed.
      if (this.reports.get(hostId)?.session === session) this.changed();
    });
    void this.announce(hostId, session);
  }

  /** Tells one Host whether Decisions is on here, and keeps what it answers it reports. */
  private async announce(hostId: string, session: DecisionsHostSession): Promise<void> {
    const state = this.deps.ownerState();
    if (state === null) return;
    const turn = (this.announced.get(hostId) ?? 0) + 1;
    this.announced.set(hostId, turn);
    let raw: unknown;
    try {
      raw = await session.call(DecisionsLinkMethod.OWNER_STATE, OwnerStatePayloadSchema.parse(state), {
        timeoutMs: OWNER_STATE_TIMEOUT_MS,
      });
    } catch {
      // A Host from before Hosts ran Decisions, or a link that went: nothing to keep.
      return;
    }
    if (this.announced.get(hostId) !== turn) return;
    const parsed = HostRuntimePayloadSchema.safeParse(raw);
    if (parsed.success) this.observe(hostId, session, parsed.data.runtime);
  }

  private observe(hostId: string, session: DecisionsHostSession, runtime: DecisionsHostRuntime): void {
    if (!session.isOpen) return;
    this.reports.set(hostId, { session, runtime, at: this.now() });
    this.changed();
  }

  private changed(): void {
    for (const listener of [...this.listeners]) {
      try {
        listener();
      } catch (err) {
        console.warn("[Decisions] A Hosts listener threw:", err);
      }
    }
  }

  private linkOf(hostId: string, session: DecisionsHostSession): HostLink {
    let link = this.links.get(session);
    if (!link) {
      link = new HostLink(hostId, session, this.deps.hold);
      this.links.set(session, link);
    }
    return link;
  }
}
