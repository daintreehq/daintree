import { randomUUID } from "node:crypto";
import { assistantSlotKey, isValidAssistantSlot } from "../../../shared/config/assistantSlots.js";
import type { HostId } from "../../../shared/types/remoteHosts.js";
import type {
  HelpSessionEndedEvent,
  RunningLane,
  RunningLaneSession,
} from "../../services/HelpSessionService.js";

/**
 * The Shell a lane answers to. A remote Shell is the link session this host
 * issued it; a resume keeps it by presenting that session's secret. The client
 * id a Shell claims is not proof of identity, so it never appears here. A
 * lane's enrollment also records the sender credential that session proved
 * (`LaneEnrollment.sender`), which alone moves consent to a later session.
 */
export type MessagingShell = { kind: "local" } | { kind: "remote"; linkSessionId: string };

/** A project's assistant slot. */
export interface LaneRef {
  projectId: string;
  slot: number;
}

export interface LaneEnrollment {
  projectId: string;
  slot: number;
  /** Fresh on every enrollment, so anything addressed to an earlier one is refused. */
  generation: string;
  /** The help session and PTY run the consent was given to. */
  sessionId: string;
  terminalId: string;
  launchGeneration: number;
  enrolledBy: MessagingShell;
  enrolledAt: number;
  /**
   * The assistant sender the enrolling Shell proved on its link session, once
   * it has. Consent follows that Shell rather than one connection: when the
   * session ends the enrollment waits, and the same sender authenticating a
   * later session takes it over with the same generation. Unproven, the
   * enrollment ends with its session.
   */
  sender?: string;
}

/**
 * What a check is for. Pause stops `admit` and `wake`; `reply` (to an exchange
 * already in flight) and `inspect` pass through it. `inspect` alone doesn't
 * need the assistant to be running.
 */
export type MessagingRequestKind = "admit" | "wake" | "reply" | "inspect";

export type MessagingDenial =
  | "unsupported-platform"
  | "invalid-lane"
  | "not-enrolled"
  | "stale-generation"
  | "unavailable"
  | "wrong-shell"
  | "hub-taken"
  | "host-disabled"
  | "no-hub"
  | "paused";

/**
 * Why a lane's enrollment ended without the person turning it off: its session
 * was revoked, displaced or relaunched, its run stopped some other way, or the
 * remote Shell that enrolled it is gone for good.
 */
export type EnrollmentEndReason = "revoked" | "displaced" | "relaunched" | "stopped" | "shell-gone";

export interface EnrollmentEnded {
  reason: EnrollmentEndReason;
  at: number;
  enrolledBy: MessagingShell;
}

export type EnrollmentResult =
  { ok: true; enrollment: LaneEnrollment } | { ok: false; reason: MessagingDenial };

export interface LaneCheck {
  lane: LaneRef;
  generation: string;
  shell: MessagingShell;
  kind: MessagingRequestKind;
}

export interface HostCheck {
  hostId: HostId;
  kind: MessagingRequestKind;
}

export interface AssistantMessagingPolicyDeps {
  /** The help session a lane is running right now; never launches one. */
  getRunningLaneSession(projectId: string, slot: number): RunningLaneSession | null;
  /** Every lane with a running assistant on this machine, enrolled or not. */
  listRunningLanes?(): RunningLane[];
  /**
   * Whether a running assistant was started through a view of `linkSessionId`:
   * its session is pinned to that link session's endpoint. Absent, nothing
   * started remotely can be enrolled without the person's toggle.
   */
  startedThrough?(running: RunningLaneSession, linkSessionId: string): boolean;
  /** Which incarnation of a PTY is running under its id, or null when none is. */
  getLiveGeneration(terminalId: string): number | null;
  /** This Shell's per-host opt-in. */
  isHostMessagingEnabled(hostId: HostId): boolean;
  onSessionEnded(listener: (event: HelpSessionEndedEvent) => void): () => void;
  platform?: NodeJS.Platform;
  now?: () => number;
  newGeneration?: () => string;
}

const PAUSE_EXEMPT: ReadonlySet<MessagingRequestKind> = new Set(["reply", "inspect"]);

function sameShell(a: MessagingShell, b: MessagingShell): boolean {
  if (a.kind === "local" || b.kind === "local") return a.kind === b.kind;
  return a.linkSessionId === b.linkSessionId;
}

function isValidShell(shell: unknown): shell is MessagingShell {
  if (!shell || typeof shell !== "object") return false;
  const candidate = shell as { kind?: unknown; linkSessionId?: unknown };
  if (candidate.kind === "local") return true;
  return (
    candidate.kind === "remote" &&
    typeof candidate.linkSessionId === "string" &&
    candidate.linkSessionId.length > 0
  );
}

function copyEnrollment(enrollment: LaneEnrollment): LaneEnrollment {
  return { ...enrollment, enrolledBy: { ...enrollment.enrolledBy } };
}

/** A remote Shell's enrollments moved from one of its link sessions to a later one. */
export interface SessionRebind {
  from: string;
  to: string;
}

function endReasonFor(reason: HelpSessionEndedEvent["reason"]): EnrollmentEndReason {
  switch (reason) {
    case "revoked":
    case "displaced":
    case "relaunched":
      return reason;
    default:
      return "stopped";
  }
}

function laneKey(lane: LaneRef): string | null {
  if (!lane || typeof lane.projectId !== "string" || lane.projectId.length === 0) return null;
  if (!isValidAssistantSlot(lane.slot)) return null;
  return assistantSlotKey(lane.projectId, lane.slot);
}

/**
 * The one place cross-host assistant messaging asks before it admits or
 * delivers anything. Holds which lanes a person enrolled, which Shell enrolled
 * each, this Shell's hub, and a machine-wide pause. Everything but the per-host
 * opt-in (which lives on the host list) is in memory: an app restart ends every
 * enrollment and clears the pause.
 *
 * Enrolling never launches an assistant. A lane whose assistant isn't running
 * can't be enrolled, and one that stops running is unavailable until its
 * enrollment ends with the run.
 */
export class AssistantMessagingPolicy {
  private readonly enrollments = new Map<string, LaneEnrollment>();
  /** Enrollments that ended without being withdrawn, kept until the lane is enrolled again. */
  private readonly ended = new Map<string, EnrollmentEnded>();
  private readonly changeListeners = new Set<() => void>();
  /** Live link sessions and the sender each proved; gone with the session. */
  private readonly sessionSenders = new Map<string, string>();
  private revision = 0;
  private paused = false;
  private readonly platform: NodeJS.Platform;
  private readonly now: () => number;
  private readonly newGeneration: () => string;
  private unsubscribe: (() => void) | null;

  constructor(private readonly deps: AssistantMessagingPolicyDeps) {
    this.platform = deps.platform ?? process.platform;
    this.now = deps.now ?? Date.now;
    this.newGeneration = deps.newGeneration ?? randomUUID;
    this.unsubscribe = deps.onSessionEnded((event) => this.handleSessionEnded(event));
  }

  private get supported(): boolean {
    return this.platform !== "win32";
  }

  /** Whether messaging can reach a lane on this machine at all. */
  isSupported(): boolean {
    return this.supported;
  }

  enroll(lane: LaneRef, shell: MessagingShell): EnrollmentResult {
    if (!this.supported) return { ok: false, reason: "unsupported-platform" };
    const key = laneKey(lane);
    if (key === null || !isValidShell(shell)) return { ok: false, reason: "invalid-lane" };
    const existing = this.current(key);
    // A Shell that's away can't keep the lane from one that's here: enrolling
    // below replaces its waiting consent, and only once nothing else refuses.
    if (existing && !sameShell(existing.enrolledBy, shell) && !this.waiting(existing)) {
      return { ok: false, reason: "wrong-shell" };
    }
    if (shell.kind === "local") {
      const hub = this.getHub();
      if (hub && laneKey(hub) !== key) return { ok: false, reason: "hub-taken" };
    }
    const running = this.deps.getRunningLaneSession(lane.projectId, lane.slot);
    const launchGeneration = running ? this.deps.getLiveGeneration(running.terminalId) : null;
    if (!running || launchGeneration === null) return { ok: false, reason: "unavailable" };
    const enrollment: LaneEnrollment = {
      projectId: lane.projectId,
      slot: lane.slot,
      generation: this.newGeneration(),
      sessionId: running.sessionId,
      terminalId: running.terminalId,
      launchGeneration,
      enrolledBy:
        shell.kind === "local"
          ? { kind: "local" }
          : { kind: "remote", linkSessionId: shell.linkSessionId },
      enrolledAt: this.now(),
    };
    const sender =
      shell.kind === "remote" ? this.sessionSenders.get(shell.linkSessionId) : undefined;
    if (sender !== undefined) enrollment.sender = sender;
    this.enrollments.set(key, enrollment);
    this.ended.delete(key);
    this.changed();
    return { ok: true, enrollment: copyEnrollment(enrollment) };
  }

  /**
   * Enroll for `shell` a lane it just started, with nobody at the lane's
   * screen to click: only the run with help session `sessionId`, and only while
   * no other Shell holds the lane, not even one that's away. Checked and taken
   * in one step, so neither can change between them. The person's own toggle
   * keeps `enroll`'s rules.
   */
  enrollStarted(
    lane: LaneRef,
    shell: MessagingShell,
    sessionId: string
  ): EnrollmentResult | { ok: false; reason: "occupied" | "wrong-session" } {
    const key = laneKey(lane);
    if (key === null || !isValidShell(shell)) return { ok: false, reason: "invalid-lane" };
    const existing = this.current(key);
    if (existing && !sameShell(existing.enrolledBy, shell)) {
      return { ok: false, reason: "occupied" };
    }
    const running = this.deps.getRunningLaneSession(lane.projectId, lane.slot);
    if (!running) return { ok: false, reason: "unavailable" };
    // Knowing a session id proves nothing: the run has to have come through
    // one of this Shell's own views. (A relaunch in place during start-up keeps
    // its session and view, and is still the lane this Shell opened.)
    if (
      running.sessionId !== sessionId ||
      shell.kind !== "remote" ||
      this.deps.startedThrough?.(running, shell.linkSessionId) !== true
    ) {
      return { ok: false, reason: "wrong-session" };
    }
    if (existing && existing.sessionId === sessionId) {
      return { ok: true, enrollment: copyEnrollment(existing) };
    }
    return this.enroll(lane, shell);
  }

  /**
   * Withdraw consent, naming the current generation. Only the Shell that
   * enrolled the lane, except while that Shell is away: anyone with a view of
   * the lane may then turn it off, since withdrawing never gives access.
   */
  unenroll(lane: LaneRef, shell: MessagingShell, generation: string): boolean {
    const key = laneKey(lane);
    if (key === null) return false;
    const existing = this.current(key);
    if (!existing || existing.generation !== generation) return false;
    if (!sameShell(existing.enrolledBy, shell) && !this.waiting(existing)) return false;
    this.enrollments.delete(key);
    this.ended.delete(key);
    this.changed();
    return true;
  }

  /**
   * A link session proved which Shell's assistant sender it carries. Its
   * enrollments record that sender, and those the same sender made over an
   * earlier session move to this one, keeping their generation: a Shell that
   * restarted, slept past the resume window or let an idle link go comes back
   * to the lanes it enrolled. Another sender's never move.
   */
  bindSender(linkSessionId: string, senderId: string): SessionRebind[] {
    if (linkSessionId.length === 0 || senderId.length === 0) return [];
    // A session proves one sender for its whole life, resumes included.
    const proven = this.sessionSenders.get(linkSessionId);
    if (proven !== undefined && proven !== senderId) return [];
    this.sessionSenders.set(linkSessionId, senderId);
    const rebinds = new Map<string, string>();
    let changed = false;
    for (const enrollment of this.enrollments.values()) {
      const by = enrollment.enrolledBy;
      if (by.kind !== "remote") continue;
      if (by.linkSessionId === linkSessionId) {
        if (enrollment.sender === undefined) {
          enrollment.sender = senderId;
          changed = true;
        }
        continue;
      }
      if (enrollment.sender !== senderId) continue;
      rebinds.set(by.linkSessionId, linkSessionId);
      enrollment.enrolledBy = { kind: "remote", linkSessionId };
      changed = true;
    }
    if (changed) this.changed();
    return [...rebinds].map(([from, to]) => ({ from, to }));
  }

  /** The sender a live link session proved, if it has. */
  sessionSender(linkSessionId: string): string | undefined {
    return this.sessionSenders.get(linkSessionId);
  }

  /**
   * Whether the lane's enrollment is waiting for its Shell to come back: made
   * by a Shell whose sender was proven, over a session that has since ended.
   */
  isWaiting(lane: LaneRef): boolean {
    const key = laneKey(lane);
    const enrollment = key === null ? undefined : this.current(key);
    return enrollment !== undefined && this.waiting(enrollment);
  }

  /**
   * A remote Shell's link session is gone for good. Enrollments its sender
   * was proven on wait for that Shell's next session (see `bindSender`):
   * their lanes can still read and answer what already reached them, and
   * what they write to the hub waits in the outbox, but no message reaches
   * them until it is back. The rest end.
   */
  releaseLinkSession(linkSessionId: string): void {
    this.sessionSenders.delete(linkSessionId);
    let released = false;
    for (const [key, enrollment] of this.enrollments) {
      const by = enrollment.enrolledBy;
      if (by.kind === "remote" && by.linkSessionId === linkSessionId) {
        // Waiting now, which views show: the change is announced either way.
        if (enrollment.sender === undefined) this.end(key, enrollment, "shell-gone", false);
        released = true;
      }
    }
    if (released) this.changed();
  }

  /** Ends every remote Shell's enrollments: this host stopped listening, so none can resume. */
  releaseRemoteShells(): void {
    this.sessionSenders.clear();
    let released = false;
    for (const [key, enrollment] of this.enrollments) {
      if (enrollment.enrolledBy.kind !== "remote") continue;
      this.end(key, enrollment, "shell-gone", false);
      released = true;
    }
    if (released) this.changed();
  }

  getEnrollment(lane: LaneRef): LaneEnrollment | null {
    const key = laneKey(lane);
    const enrollment = key === null ? undefined : this.current(key);
    return enrollment ? copyEnrollment(enrollment) : null;
  }

  /**
   * Every enrollment still standing whose run hasn't been replaced, running or
   * not; only those `shell` made when one is named.
   */
  listEnrollments(shell?: MessagingShell): LaneEnrollment[] {
    if (shell !== undefined && !isValidShell(shell)) return [];
    const listed: LaneEnrollment[] = [];
    for (const key of [...this.enrollments.keys()]) {
      const enrollment = this.current(key);
      if (enrollment && (shell === undefined || sameShell(enrollment.enrolledBy, shell))) {
        listed.push(copyEnrollment(enrollment));
      }
    }
    return listed;
  }

  /** Every assistant running on this machine, enrolled or not; reports only. */
  listRunning(): RunningLane[] {
    return this.deps.listRunningLanes?.() ?? [];
  }

  /** The lane enrolled on this Shell itself, if any. */
  getHub(): LaneEnrollment | null {
    for (const [key, enrollment] of this.enrollments) {
      if (enrollment.enrolledBy.kind !== "local") continue;
      const hub = this.current(key);
      return hub ? copyEnrollment(hub) : null;
    }
    return null;
  }

  /**
   * Ends every enrollment whose run was replaced. A relaunch in place keeps
   * its session and terminal ids and emits no session event, so without this
   * it would only be noticed by the next read.
   */
  reconcile(): void {
    for (const key of [...this.enrollments.keys()]) this.current(key);
  }

  /** How the lane's last enrollment ended, while it hasn't been enrolled again. */
  getEnded(lane: LaneRef): EnrollmentEnded | null {
    const key = laneKey(lane);
    if (key === null) return null;
    this.current(key);
    const ended = this.ended.get(key);
    return ended ? { ...ended, enrolledBy: { ...ended.enrolledBy } } : null;
  }

  isPaused(): boolean {
    return this.paused;
  }

  setPaused(paused: boolean): void {
    const next = paused === true;
    if (next === this.paused) return;
    this.paused = next;
    this.changed();
  }

  /** Increases on every change a listener hears about. */
  getRevision(): number {
    return this.revision;
  }

  /** Called after enrollment, an ended enrollment or the pause changes. */
  onChange(listener: () => void): () => void {
    this.changeListeners.add(listener);
    return () => {
      this.changeListeners.delete(listener);
    };
  }

  /**
   * Host side: may `shell` reach this lane for `kind`? The caller derives
   * `shell` from the connection the request arrived on, never from its body.
   */
  checkLane(check: LaneCheck): EnrollmentResult {
    if (!this.supported) return { ok: false, reason: "unsupported-platform" };
    const key = laneKey(check.lane);
    if (key === null || !isValidShell(check.shell)) return { ok: false, reason: "invalid-lane" };
    const enrollment = this.current(key);
    if (!enrollment) return { ok: false, reason: "not-enrolled" };
    if (!sameShell(enrollment.enrolledBy, check.shell)) return { ok: false, reason: "wrong-shell" };
    if (enrollment.generation !== check.generation) {
      return { ok: false, reason: "stale-generation" };
    }
    return this.decide(enrollment, check.kind);
  }

  /** Shell side: may this Shell's hub message assistants on `hostId` for `kind`? */
  checkHost(check: HostCheck): EnrollmentResult {
    if (!this.supported) return { ok: false, reason: "unsupported-platform" };
    if (!this.deps.isHostMessagingEnabled(check.hostId)) {
      return { ok: false, reason: "host-disabled" };
    }
    const hub = this.getHub();
    if (!hub) return { ok: false, reason: "no-hub" };
    return this.decide(hub, check.kind);
  }

  dispose(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.changeListeners.clear();
    this.enrollments.clear();
    this.ended.clear();
    this.sessionSenders.clear();
    this.paused = false;
  }

  private decide(enrollment: LaneEnrollment, kind: MessagingRequestKind): EnrollmentResult {
    if (kind !== "inspect" && !this.isRunning(enrollment)) {
      return { ok: false, reason: "unavailable" };
    }
    if (this.paused && !PAUSE_EXEMPT.has(kind)) return { ok: false, reason: "paused" };
    return { ok: true, enrollment: copyEnrollment(enrollment) };
  }

  /**
   * The lane's enrollment, unless the run it was given to has been replaced.
   * A replacement ends it here even when no session event said so, so a
   * relaunch in place can't inherit consent given to its predecessor. A run
   * that merely isn't running right now keeps its enrollment.
   */
  private current(key: string): LaneEnrollment | undefined {
    const enrollment = this.enrollments.get(key);
    if (!enrollment) return undefined;
    const running = this.deps.getRunningLaneSession(enrollment.projectId, enrollment.slot);
    if (!running) return enrollment;
    const launchGeneration = this.deps.getLiveGeneration(running.terminalId);
    const replaced =
      running.sessionId !== enrollment.sessionId ||
      running.terminalId !== enrollment.terminalId ||
      (launchGeneration !== null && launchGeneration !== enrollment.launchGeneration);
    if (!replaced) return enrollment;
    this.end(key, enrollment, "relaunched");
    return undefined;
  }

  private waiting(enrollment: LaneEnrollment): boolean {
    const by = enrollment.enrolledBy;
    return (
      by.kind === "remote" &&
      enrollment.sender !== undefined &&
      this.sessionSenders.get(by.linkSessionId) !== enrollment.sender
    );
  }

  private isRunning(enrollment: LaneEnrollment): boolean {
    const running = this.deps.getRunningLaneSession(enrollment.projectId, enrollment.slot);
    return (
      running !== null &&
      running.sessionId === enrollment.sessionId &&
      running.terminalId === enrollment.terminalId &&
      this.deps.getLiveGeneration(running.terminalId) === enrollment.launchGeneration
    );
  }

  private handleSessionEnded(event: HelpSessionEndedEvent): void {
    const key = laneKey({ projectId: event.projectId, slot: event.slot });
    if (key === null) return;
    const enrollment = this.enrollments.get(key);
    if (enrollment && enrollment.sessionId === event.sessionId) {
      this.end(key, enrollment, endReasonFor(event.reason));
    }
  }

  private end(
    key: string,
    enrollment: LaneEnrollment,
    reason: EnrollmentEndReason,
    notify = true
  ): void {
    this.enrollments.delete(key);
    this.ended.set(key, { reason, at: this.now(), enrolledBy: { ...enrollment.enrolledBy } });
    if (notify) this.changed();
  }

  private changed(): void {
    this.revision += 1;
    for (const listener of [...this.changeListeners]) {
      try {
        listener();
      } catch {
        // A listener's failure must not stop the others or the policy change.
      }
    }
  }
}
