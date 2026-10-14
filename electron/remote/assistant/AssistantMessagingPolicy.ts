import { randomUUID } from "node:crypto";
import { assistantSlotKey, isValidAssistantSlot } from "../../../shared/config/assistantSlots.js";
import type { HostId } from "../../../shared/types/remoteHosts.js";
import type {
  HelpSessionEndedEvent,
  RunningLaneSession,
} from "../../services/HelpSessionService.js";

/**
 * The Shell a lane answers to. A remote Shell is the link session this host
 * issued it: a fresh connection never inherits consent given over another,
 * and a resume keeps it only by presenting that session's secret. The client
 * id a Shell claims is not proof of identity, so it never appears here.
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

  enroll(lane: LaneRef, shell: MessagingShell): EnrollmentResult {
    if (!this.supported) return { ok: false, reason: "unsupported-platform" };
    const key = laneKey(lane);
    if (key === null || !isValidShell(shell)) return { ok: false, reason: "invalid-lane" };
    const existing = this.current(key);
    if (existing && !sameShell(existing.enrolledBy, shell)) {
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
    this.enrollments.set(key, enrollment);
    this.ended.delete(key);
    this.changed();
    return { ok: true, enrollment: copyEnrollment(enrollment) };
  }

  /** Withdraw consent. Only the Shell that enrolled the lane, naming the current generation. */
  unenroll(lane: LaneRef, shell: MessagingShell, generation: string): boolean {
    const key = laneKey(lane);
    if (key === null) return false;
    const existing = this.current(key);
    if (!existing || existing.generation !== generation) return false;
    if (!sameShell(existing.enrolledBy, shell)) return false;
    this.enrollments.delete(key);
    this.ended.delete(key);
    this.changed();
    return true;
  }

  /** Ends every enrollment a remote Shell made, once its link session is gone for good. */
  releaseLinkSession(linkSessionId: string): void {
    let released = false;
    for (const [key, enrollment] of this.enrollments) {
      const by = enrollment.enrolledBy;
      if (by.kind === "remote" && by.linkSessionId === linkSessionId) {
        this.end(key, enrollment, "shell-gone", false);
        released = true;
      }
    }
    if (released) this.changed();
  }

  /** Ends every remote Shell's enrollments: this host stopped listening, so none can resume. */
  releaseRemoteShells(): void {
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
