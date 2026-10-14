import { isValidAssistantSlot } from "../../../shared/config/assistantSlots.js";
import type {
  AssistantMessagingEnrollDenial,
  AssistantMessagingEnrollResult,
  AssistantMessagingLaneRef,
  AssistantMessagingState,
} from "../../../shared/types/ipc/assistantMessaging.js";
import {
  sameShell,
  type LaneRef,
  type MessagingDenial,
  type MessagingShell,
} from "../../remote/assistant/AssistantMessagingPolicy.js";
import { getRemoteService } from "../../remote/runtime.js";
import { defineIpcNamespace, op } from "../define.js";
import type { IpcContext } from "../types.js";
import { ASSISTANT_MESSAGING_METHOD_CHANNELS } from "./assistantMessaging.preload.js";

/**
 * The Shell a request speaks for, from the connection it arrived on and never
 * from its body: a remote view is the link session this host issued its Shell,
 * a window of this machine is this machine.
 */
function shellFor(ctx: IpcContext): MessagingShell | null {
  if (ctx.endpoint.kind === "remote-view") {
    const linkSessionId = ctx.endpoint.linkSessionId;
    return linkSessionId ? { kind: "remote", linkSessionId } : null;
  }
  return ctx.senderWindow ? { kind: "local" } : null;
}

/** A lane of the project this view shows; any other lane isn't the caller's to see or change. */
function laneFor(ctx: IpcContext, input: unknown): LaneRef | null {
  if (!input || typeof input !== "object") return null;
  const { projectId, slot } = input as Partial<AssistantMessagingLaneRef>;
  if (typeof projectId !== "string" || projectId.length === 0) return null;
  if (!isValidAssistantSlot(slot)) return null;
  if (ctx.projectId !== projectId) return null;
  return { projectId, slot };
}

function isAvailable(shell: MessagingShell | null): shell is MessagingShell {
  if (process.platform === "win32" || shell === null) return false;
  const surface = getRemoteService("assistantMessagingSurface");
  if (!surface || !getRemoteService("assistantMessagingPolicy")) return false;
  // A remote view's host exists by definition; this machine's own windows wait for one.
  return shell.kind === "remote" || surface.hasHosts();
}

function readState(ctx: IpcContext, lane: LaneRef | null): AssistantMessagingState {
  const policy = getRemoteService("assistantMessagingPolicy");
  const shell = shellFor(ctx);
  const revision = getRemoteService("assistantMessagingSurface")?.revision() ?? 0;
  const empty = { enrolled: false, enrolledElsewhere: false, ended: null };
  if (!policy || !isAvailable(shell)) {
    return { available: false, paused: false, canPause: false, lane: empty, revision };
  }
  const enrollment = lane ? policy.getEnrollment(lane) : null;
  const ended = lane ? policy.getEnded(lane) : null;
  const mine = enrollment !== null && sameShell(enrollment.enrolledBy, shell);
  return {
    available: true,
    paused: policy.isPaused(),
    canPause: shell.kind === "local",
    lane: {
      enrolled: mine,
      enrolledElsewhere: enrollment !== null && !mine,
      // Another Shell's lapsed consent is that Shell's to hear about.
      ended:
        ended && sameShell(ended.enrolledBy, shell) ? { reason: ended.reason, at: ended.at } : null,
    },
    revision,
  };
}

function denialFor(reason: MessagingDenial): AssistantMessagingEnrollDenial {
  switch (reason) {
    case "unsupported-platform":
      return "unsupported";
    case "hub-taken":
      return "hub-taken";
    case "wrong-shell":
      return "wrong-shell";
    case "unavailable":
      return "not-running";
    default:
      return "unavailable";
  }
}

async function handleGetState(
  ctx: IpcContext,
  input: AssistantMessagingLaneRef
): Promise<AssistantMessagingState> {
  return readState(ctx, laneFor(ctx, input));
}

async function handleSetLaneEnrolled(
  ctx: IpcContext,
  input: AssistantMessagingLaneRef & { enrolled: boolean }
): Promise<AssistantMessagingEnrollResult> {
  const lane = laneFor(ctx, input);
  const shell = shellFor(ctx);
  const policy = getRemoteService("assistantMessagingPolicy");
  const done = (): AssistantMessagingEnrollResult => ({
    state: readState(ctx, lane),
    refusal: null,
  });
  const refuse = (refusal: AssistantMessagingEnrollDenial): AssistantMessagingEnrollResult => ({
    state: readState(ctx, lane),
    refusal,
  });
  if (!policy || lane === null || typeof input?.enrolled !== "boolean" || !isAvailable(shell)) {
    return refuse("unavailable");
  }
  const existing = policy.getEnrollment(lane);
  if (!input.enrolled) {
    if (existing === null) return done();
    if (!sameShell(existing.enrolledBy, shell)) return refuse("wrong-shell");
    policy.unenroll(lane, shell, existing.generation);
    return done();
  }
  // Already on for this Shell: a fresh enrollment would only invalidate its generation.
  if (existing !== null && sameShell(existing.enrolledBy, shell)) return done();
  // A Shell's hub is never moved from another lane behind the person's back.
  const result = policy.enroll(lane, shell);
  return result.ok ? done() : refuse(denialFor(result.reason));
}

async function handleSetPaused(ctx: IpcContext, paused: boolean): Promise<boolean> {
  const policy = getRemoteService("assistantMessagingPolicy");
  const shell = shellFor(ctx);
  // A remote Shell sees the host's pause but never lifts or sets it.
  if (!policy || typeof paused !== "boolean" || !isAvailable(shell) || shell.kind !== "local") {
    return policy?.isPaused() ?? false;
  }
  policy.setPaused(paused);
  return policy.isPaused();
}

export const assistantMessagingNamespace = defineIpcNamespace({
  name: "assistantMessaging",
  ops: {
    getState: op(ASSISTANT_MESSAGING_METHOD_CHANNELS.getState, handleGetState, {
      withContext: true,
    }),
    setLaneEnrolled: op(
      ASSISTANT_MESSAGING_METHOD_CHANNELS.setLaneEnrolled,
      handleSetLaneEnrolled,
      { withContext: true }
    ),
    setPaused: op(ASSISTANT_MESSAGING_METHOD_CHANNELS.setPaused, handleSetPaused, {
      withContext: true,
    }),
  },
});

export function registerAssistantMessagingHandlers(): () => void {
  return assistantMessagingNamespace.register();
}
