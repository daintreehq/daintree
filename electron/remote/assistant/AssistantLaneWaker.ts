import type {
  LaneWake,
  LaneWakeCheck,
  LaneWakeOutcome,
} from "../../services/mcp-server/terminalNotify.js";
import {
  OPEN_LANE_GENERATION,
  type AssistantMessagingPolicy,
  type LaneRef,
  type MessagingShell,
  type OpenRun,
} from "./AssistantMessagingPolicy.js";

/** The run a wake was pinned to: one that replaces it is not who the wake was for. */
interface PinnedRun {
  projectId: string;
  sessionId: string;
  terminalId: string;
  launchGeneration: number;
}

/** Where a wake's outcome is recorded: the exchange it announces. */
export interface LaneWakeSink {
  /** Durably reserves the one attempt; false means the exchange may not be sent. */
  beforeType(): boolean;
  report(outcome: LaneWakeOutcome): void;
}

export interface LaneWakeRequest {
  lane: LaneRef;
  /**
   * The generation the exchange was admitted under: the lane's open address
   * for a remote Shell's message, or the enrollment it went to.
   */
  generation: string;
  /** The Shell that sent it, from the authenticated session, never the payload. */
  shell: MessagingShell;
  /** The exchange's opaque handle, typed into the lane as is. */
  exchangeId: string;
  /** A receiving lane's new message (the default), or the caller's own exchange having moved. */
  kind?: LaneWake["kind"];
  /**
   * The one run of this machine's own the wake is for: the assistant that sent
   * an exchange that moved (#13468). It was admitted when it was sent, so only
   * that run still running and the pause decide; a replacement never hears it.
   */
  run?: OpenRun;
  sink: LaneWakeSink;
}

export interface AssistantLaneWakerDeps {
  policy: Pick<AssistantMessagingPolicy, "checkLane" | "getEnrollment" | "checkOpen" | "isPaused">;
  /** Whether `shell` may type into `projectId` under its drive lease right now. */
  shellDrives(projectId: string, shell: MessagingShell): boolean;
  /** The pane's notice line; the only writer that types into it. */
  queue(
    lane: { helpSessionId: string; terminalId: string; projectId: string },
    wake: LaneWake
  ): void;
}

/**
 * Tells a lane that an admitted exchange is waiting (#13333). It never
 * launches or resumes an assistant: a lane that isn't running when the wake
 * is due is unavailable, and the message waits in its inbox.
 */
export class AssistantLaneWaker {
  constructor(private readonly deps: AssistantLaneWakerDeps) {}

  /** Call once, after the exchange was created; a resend that found it existing never wakes again. */
  wake(request: LaneWakeRequest): void {
    const first = this.check(request, null);
    if (first.run === null) {
      report(request.sink, first.check);
      return;
    }
    const pinned = first.run;
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

  private check(
    request: LaneWakeRequest,
    pinned: PinnedRun | null
  ): { check: LaneWakeCheck; run: PinnedRun | null } {
    if (request.run !== undefined) return this.checkRun(request.run);
    return request.generation === OPEN_LANE_GENERATION
      ? this.checkOpen(request, pinned)
      : this.checkEnrolled(request, pinned);
  }

  /**
   * The asker's own exchange moved: whether the run that sent it is the one
   * running now, and the pause. Neither the setting nor the run being turned
   * off to other machines stops it, as neither stops reading the exchange.
   */
  private checkRun(run: OpenRun): { check: LaneWakeCheck; run: PinnedRun | null } {
    const now = this.deps.policy.checkOpen(run, "reply");
    if (!now.ok) return { check: { kind: "unavailable", reason: now.reason }, run: null };
    if (!sameRun(now.run, run)) {
      return { check: { kind: "unavailable", reason: "relaunched" }, run: null };
    }
    if (this.deps.policy.isPaused()) return { check: { kind: "held", reason: "paused" }, run };
    return { check: { kind: "ready" }, run };
  }

  /**
   * A remote Shell's message to an open lane: whether the lane still takes
   * one, in the run the wake was pinned to, and the pause. Daintree types the
   * notice into its own assistant, not the sending Shell, so whoever drives
   * the project (someone at this machine's own window, say) doesn't hold it.
   */
  private checkOpen(
    request: LaneWakeRequest,
    pinned: PinnedRun | null
  ): { check: LaneWakeCheck; run: PinnedRun | null } {
    const result = this.deps.policy.checkOpen(request.lane, "wake");
    if (!result.ok && result.reason !== "paused") {
      return { check: { kind: "unavailable", reason: result.reason }, run: null };
    }
    // Paused is checked last, so the lane passed everything else: it waits.
    const held = result.ok ? result : this.deps.policy.checkOpen(request.lane, "inspect");
    if (!held.ok) return { check: { kind: "unavailable", reason: held.reason }, run: null };
    const run = held.run;
    if (pinned !== null && !sameRun(run, pinned)) {
      return { check: { kind: "unavailable", reason: "relaunched" }, run: null };
    }
    if (!result.ok) return { check: { kind: "held", reason: "paused" }, run };
    return { check: { kind: "ready" }, run };
  }

  /**
   * Enrollment, its generation, the pause switch and the drive lease, as they
   * stand now. Link calls skip the dispatcher's lease gate, so it is read here.
   */
  private checkEnrolled(
    request: LaneWakeRequest,
    pinned: PinnedRun | null
  ): { check: LaneWakeCheck; run: PinnedRun | null } {
    const shell = this.currentShell(request, pinned);
    const result = this.deps.policy.checkLane({
      lane: request.lane,
      generation: request.generation,
      shell,
      kind: "wake",
    });
    if (!result.ok && result.reason !== "paused") {
      return { check: { kind: "unavailable", reason: result.reason }, run: null };
    }
    // Paused is checked last, so the lane passed everything else: it waits.
    const enrollment = result.ok ? result.enrollment : this.deps.policy.getEnrollment(request.lane);
    if (enrollment === null || enrollment.generation !== request.generation) {
      return { check: { kind: "unavailable", reason: "not-enrolled" }, run: null };
    }
    if (pinned !== null && !sameRun(enrollment, pinned)) {
      return { check: { kind: "unavailable", reason: "relaunched" }, run: null };
    }
    if (!result.ok) return { check: { kind: "held", reason: "paused" }, run: enrollment };
    if (!this.deps.shellDrives(enrollment.projectId, shell)) {
      return { check: { kind: "held", reason: "driven-elsewhere" }, run: enrollment };
    }
    return { check: { kind: "ready" }, run: enrollment };
  }

  /**
   * The Shell a queued wake answers to now. A remote Shell's enrollment moves
   * to its newer link session when it proves the same sender there
   * (`AssistantMessagingPolicy.bindSender`); a wake queued before that follows
   * it, still under the generation and run it was pinned to.
   */
  private currentShell(request: LaneWakeRequest, pinned: PinnedRun | null): MessagingShell {
    if (request.shell.kind !== "remote" || pinned === null) return request.shell;
    const now = this.deps.policy.getEnrollment(request.lane);
    if (
      now !== null &&
      now.enrolledBy.kind === "remote" &&
      now.generation === request.generation &&
      now.sender !== undefined &&
      sameRun(now, pinned)
    ) {
      return now.enrolledBy;
    }
    return request.shell;
  }
}

function sameRun(a: PinnedRun, b: PinnedRun): boolean {
  return (
    a.sessionId === b.sessionId &&
    a.terminalId === b.terminalId &&
    a.launchGeneration === b.launchGeneration
  );
}

function report(sink: LaneWakeSink, check: LaneWakeCheck): void {
  if (check.kind === "ready") return;
  try {
    sink.report(check);
  } catch (err) {
    console.error("[AssistantLaneWaker] recording a wake outcome failed:", err);
  }
}
