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
  getLaunchGeneration(terminalId: string): number | null;
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
    const existing = this.enrollments.get(key);
    if (existing && !sameShell(existing.enrolledBy, shell)) {
      return { ok: false, reason: "wrong-shell" };
    }
    if (shell.kind === "local") {
      const hub = this.getHub();
      if (hub && laneKey(hub) !== key) return { ok: false, reason: "hub-taken" };
    }
    const running = this.deps.getRunningLaneSession(lane.projectId, lane.slot);
    const launchGeneration = running ? this.deps.getLaunchGeneration(running.terminalId) : null;
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
    return { ok: true, enrollment: copyEnrollment(enrollment) };
  }

  /** Withdraw consent. Only the Shell that enrolled the lane, naming the current generation. */
  unenroll(lane: LaneRef, shell: MessagingShell, generation: string): boolean {
    const key = laneKey(lane);
    if (key === null) return false;
    const existing = this.enrollments.get(key);
    if (!existing || existing.generation !== generation) return false;
    if (!sameShell(existing.enrolledBy, shell)) return false;
    this.enrollments.delete(key);
    return true;
  }

  /** Ends every enrollment a remote Shell made, once its link session is gone for good. */
  releaseShell(shell: MessagingShell): void {
    for (const [key, enrollment] of this.enrollments) {
      if (sameShell(enrollment.enrolledBy, shell)) this.enrollments.delete(key);
    }
  }

  getEnrollment(lane: LaneRef): LaneEnrollment | null {
    const key = laneKey(lane);
    const enrollment = key === null ? undefined : this.enrollments.get(key);
    return enrollment ? copyEnrollment(enrollment) : null;
  }

  /** The lane enrolled on this Shell itself, if any. */
  getHub(): LaneEnrollment | null {
    for (const enrollment of this.enrollments.values()) {
      if (enrollment.enrolledBy.kind === "local") return copyEnrollment(enrollment);
    }
    return null;
  }

  isPaused(): boolean {
    return this.paused;
  }

  setPaused(paused: boolean): void {
    this.paused = paused === true;
  }

  /**
   * Host side: may `shell` reach this lane for `kind`? The caller derives
   * `shell` from the connection the request arrived on, never from its body.
   */
  checkLane(check: LaneCheck): EnrollmentResult {
    if (!this.supported) return { ok: false, reason: "unsupported-platform" };
    const key = laneKey(check.lane);
    if (key === null || !isValidShell(check.shell)) return { ok: false, reason: "invalid-lane" };
    const enrollment = this.enrollments.get(key);
    if (!enrollment) return { ok: false, reason: "not-enrolled" };
    if (!sameShell(enrollment.enrolledBy, check.shell)) return { ok: false, reason: "wrong-shell" };
    if (enrollment.generation !== check.generation) {
      return { ok: false, reason: "stale-generation" };
    }
    return this.decide(key, enrollment, check.kind);
  }

  /** Shell side: may this Shell's hub message assistants on `hostId` for `kind`? */
  checkHost(check: HostCheck): EnrollmentResult {
    if (!this.supported) return { ok: false, reason: "unsupported-platform" };
    if (!this.deps.isHostMessagingEnabled(check.hostId)) {
      return { ok: false, reason: "host-disabled" };
    }
    const hub = this.getHub();
    if (!hub) return { ok: false, reason: "no-hub" };
    const key = laneKey(hub) as string;
    const decision = this.decide(key, this.enrollments.get(key) as LaneEnrollment, check.kind);
    if (!decision.ok && decision.reason === "not-enrolled") return { ok: false, reason: "no-hub" };
    return decision;
  }

  dispose(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.enrollments.clear();
    this.paused = false;
  }

  private decide(
    key: string,
    enrollment: LaneEnrollment,
    kind: MessagingRequestKind
  ): EnrollmentResult {
    if (kind !== "inspect") {
      const availability = this.availability(key, enrollment);
      if (availability !== null) return { ok: false, reason: availability };
    }
    if (this.paused && !PAUSE_EXEMPT.has(kind)) return { ok: false, reason: "paused" };
    return { ok: true, enrollment: copyEnrollment(enrollment) };
  }

  /**
   * Null when the enrolled run is the one running now. A run that was replaced
   * ends the enrollment here even if no session event said so, so a relaunch
   * in place can't inherit consent given to its predecessor.
   */
  private availability(key: string, enrollment: LaneEnrollment): MessagingDenial | null {
    const running = this.deps.getRunningLaneSession(enrollment.projectId, enrollment.slot);
    if (!running) return "unavailable";
    if (
      running.sessionId !== enrollment.sessionId ||
      running.terminalId !== enrollment.terminalId
    ) {
      this.enrollments.delete(key);
      return "not-enrolled";
    }
    const launchGeneration = this.deps.getLaunchGeneration(running.terminalId);
    if (launchGeneration === null) return "unavailable";
    if (launchGeneration !== enrollment.launchGeneration) {
      this.enrollments.delete(key);
      return "not-enrolled";
    }
    return null;
  }

  private handleSessionEnded(event: HelpSessionEndedEvent): void {
    const key = laneKey({ projectId: event.projectId, slot: event.slot });
    if (key === null) return;
    const enrollment = this.enrollments.get(key);
    if (enrollment && enrollment.sessionId === event.sessionId) this.enrollments.delete(key);
  }
}
