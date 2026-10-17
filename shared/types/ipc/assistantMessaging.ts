/**
 * Why a lane stopped accepting messages without the person turning it off: its
 * session was revoked, displaced or relaunched, its run stopped some other way,
 * or the remote Shell that enrolled it disconnected for good.
 */
export type AssistantMessagingEndReason =
  "revoked" | "displaced" | "relaunched" | "stopped" | "shell-gone";

/** An assistant lane of the project the asking view shows. */
export interface AssistantMessagingLaneRef {
  projectId: string;
  slot: number;
}

/** One assistant lane, as the view asking sees it. */
export interface AssistantMessagingLaneState {
  /** Messages from assistants on other machines reach this lane. */
  enrolled: boolean;
  /** Enrolled by another Shell: this view can see it but can't turn it off. */
  enrolledElsewhere: boolean;
  /** How the last enrollment ended, until the lane is enrolled again. */
  ended: { reason: AssistantMessagingEndReason; at: number } | null;
}

/** The messaging controls for the machine a view's assistants run on. */
export interface AssistantMessagingState {
  /** False on Windows and until a host exists: the controls stay hidden. */
  available: boolean;
  /** New messages and wakes are held; replies and inspection still pass. */
  paused: boolean;
  /** Only the machine running the assistants pauses them; a remote window sees the pause. */
  canPause: boolean;
  lane: AssistantMessagingLaneState;
  /** Increases on every change, so a read a newer push overtook can be dropped. */
  revision: number;
}

export type AssistantMessagingEnrollDenial =
  "unavailable" | "unsupported" | "wrong-shell" | "not-running";

export interface AssistantMessagingEnrollResult {
  state: AssistantMessagingState;
  /** Why the change was refused, or null when the lane is now as asked. */
  refusal: AssistantMessagingEnrollDenial | null;
}

/** Pushed after any change; the view reads its own state again. */
export interface AssistantMessagingChangedEvent {
  revision: number;
}
