import type {
  LaneWake,
  LaneWakeCheck,
  LaneWakeOutcome,
} from "../../services/mcp-server/terminalNotify.js";
import type {
  AssistantMessagingPolicy,
  LaneEnrollment,
  LaneRef,
  MessagingShell,
} from "./AssistantMessagingPolicy.js";

/** Where a wake's outcome is recorded: the exchange it announces. */
export interface LaneWakeSink {
  /** Durably reserves the one attempt; false means the exchange may not be sent. */
  beforeType(): boolean;
  report(outcome: LaneWakeOutcome): void;
}

export interface LaneWakeRequest {
  lane: LaneRef;
  /** The enrollment generation the exchange was admitted under. */
  generation: string;
  /** The Shell that sent it, from the authenticated session, never the payload. */
  shell: MessagingShell;
  /** The exchange's opaque handle, typed into the lane as is. */
  exchangeId: string;
  /** A receiving lane's new message (the default), or the hub's own exchange having moved. */
  kind?: LaneWake["kind"];
  sink: LaneWakeSink;
}

export interface AssistantLaneWakerDeps {
  policy: Pick<AssistantMessagingPolicy, "checkLane" | "getEnrollment">;
  /** Whether `shell` may type into `projectId` under its drive lease right now. */
  shellDrives(projectId: string, shell: MessagingShell): boolean;
  /** The pane's notice line; the only writer that types into it. */
  queue(
    lane: { helpSessionId: string; terminalId: string; projectId: string },
    wake: LaneWake
  ): void;
}

/**
 * Tells an enrolled lane that an admitted exchange is waiting (#13333). It
 * never launches or resumes an assistant: a lane that isn't running when the
 * wake is due is unavailable, and the message waits in its inbox.
 */
export class AssistantLaneWaker {
  constructor(private readonly deps: AssistantLaneWakerDeps) {}

  /** Call once, after the exchange was created; a resend that found it existing never wakes again. */
  wake(request: LaneWakeRequest): void {
    const first = this.check(request, null);
    if (first.enrollment === null) {
      report(request.sink, first.check);
      return;
    }
    const pinned = first.enrollment;
    this.deps.queue(
      {
        helpSessionId: pinned.sessionId,
        terminalId: pinned.terminalId,
        projectId: pinned.projectId,
      },
      {
        id: request.exchangeId,
        ...(request.kind === undefined ? {} : { kind: request.kind }),
        recheck: () => this.check(request, pinned).check,
        beforeType: () => request.sink.beforeType(),
        report: (outcome) => request.sink.report(outcome),
      }
    );
  }

  /**
   * Enrollment, its generation, the pause switch and the drive lease, as they
   * stand now. Link calls skip the dispatcher's lease gate, so it is read here.
   */
  private check(
    request: LaneWakeRequest,
    pinned: LaneEnrollment | null
  ): { check: LaneWakeCheck; enrollment: LaneEnrollment | null } {
    const shell = this.currentShell(request, pinned);
    const result = this.deps.policy.checkLane({
      lane: request.lane,
      generation: request.generation,
      shell,
      kind: "wake",
    });
    if (!result.ok && result.reason !== "paused") {
      return { check: { kind: "unavailable", reason: result.reason }, enrollment: null };
    }
    // Paused is checked last, so the lane passed everything else: it waits.
    const enrollment = result.ok ? result.enrollment : this.deps.policy.getEnrollment(request.lane);
    if (enrollment === null || enrollment.generation !== request.generation) {
      return { check: { kind: "unavailable", reason: "not-enrolled" }, enrollment: null };
    }
    if (
      pinned !== null &&
      (enrollment.sessionId !== pinned.sessionId ||
        enrollment.terminalId !== pinned.terminalId ||
        enrollment.launchGeneration !== pinned.launchGeneration)
    ) {
      return { check: { kind: "unavailable", reason: "relaunched" }, enrollment: null };
    }
    if (!result.ok) return { check: { kind: "held", reason: "paused" }, enrollment };
    if (!this.deps.shellDrives(enrollment.projectId, shell)) {
      return { check: { kind: "held", reason: "driven-elsewhere" }, enrollment };
    }
    return { check: { kind: "ready" }, enrollment };
  }

  /**
   * The Shell a queued wake answers to now. A remote Shell's enrollment moves
   * to its newer link session when it proves the same sender there
   * (`AssistantMessagingPolicy.bindSender`); a wake queued before that follows
   * it, still under the generation and run it was pinned to.
   */
  private currentShell(request: LaneWakeRequest, pinned: LaneEnrollment | null): MessagingShell {
    if (request.shell.kind !== "remote" || pinned?.sender === undefined) return request.shell;
    const now = this.deps.policy.getEnrollment(request.lane);
    if (
      now !== null &&
      now.enrolledBy.kind === "remote" &&
      now.generation === request.generation &&
      now.sender === pinned.sender
    ) {
      return now.enrolledBy;
    }
    return request.shell;
  }
}

function report(sink: LaneWakeSink, check: LaneWakeCheck): void {
  if (check.kind === "ready") return;
  try {
    sink.report(check);
  } catch (err) {
    console.error("[AssistantLaneWaker] recording a wake outcome failed:", err);
  }
}
