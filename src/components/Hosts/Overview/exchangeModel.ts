import type {
  AssistantExchangeDelivery,
  AssistantExchangeState,
  AssistantExchangeView,
} from "@shared/types/ipc/remoteHosts";
import type { HostProjectRef } from "../hostProjects";

/** The host's states as it recorded them. `completed` means a reply arrived, nothing more. */
const STATE_LABEL: Record<AssistantExchangeState, string> = {
  submitted: "Submitted",
  working: "Working",
  "input-required": "Needs input",
  completed: "Completed",
  canceled: "Canceled",
  failed: "Failed",
  rejected: "Rejected",
};

const DELIVERY_LABEL: Record<AssistantExchangeDelivery, string> = {
  unconfirmed: "Couldn't confirm delivery",
  pending: "Not delivered",
  accepted: "Accepted by host",
  "wake-typed": "Lane woken",
  "inbox-fetched": "Read by lane",
  "reply-received": "Reply received",
};

/**
 * The state the host recorded, or null when it never answered the send. An
 * exchange its sweep expired is stored as failed; that says nothing about
 * delivery, so it reads as expired, and the delivery line says what is known.
 */
export function describeExchangeState(view: AssistantExchangeView): string | null {
  if (view.state === null) return null;
  if (view.state === "failed" && view.outcome === "expired") return "Expired";
  return STATE_LABEL[view.state];
}

export function describeExchangeDelivery(view: AssistantExchangeView): string {
  return DELIVERY_LABEL[view.delivery];
}

/**
 * "Session 2 · web-app": the receiving lane, with its project named from the
 * host's current project list when it is there. Null until the host answered.
 */
export function describeExchangeReceiver(
  view: AssistantExchangeView,
  projects: readonly HostProjectRef[] | null | undefined
): string | null {
  if (!view.receiver) return null;
  const session = view.receiver.slot === null ? "Assistant" : `Session ${view.receiver.slot + 1}`;
  const project = projects?.find((candidate) => candidate.id === view.receiver?.projectId);
  return project ? `${session} · ${project.name}` : session;
}

/** Enough of a conversation id to tell conversations apart; the full id is a hover away. */
export function shortConversationId(contextId: string): string {
  return contextId.length > 8 ? `${contextId.slice(0, 8)}…` : contextId;
}
