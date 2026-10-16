import { isValidAssistantSlot } from "../../../shared/config/assistantSlots.js";
import type {
  AssistantExchangeCancelKind,
  AssistantExchangeDelivery,
  AssistantExchangeView,
} from "../../../shared/types/ipc/remoteHosts.js";
import type { JournalEntry } from "../exchange/AssistantExchangeJournal.js";
import { TERMINAL_EXCHANGE_STATES, type ExchangeRecord } from "../exchange/types.js";

/** The host's outcome code for a live exchange its sweep expired. */
const EXPIRED_OUTCOME = "expired";

function isLive(record: ExchangeRecord, now: number): boolean {
  return (
    !TERMINAL_EXCHANGE_STATES.has(record.state) &&
    record.tombstonedAt === null &&
    record.expiresAt > now
  );
}

/** The store's own test for "the other assistant may already be acting on it". */
function mayHaveDelivered(record: ExchangeRecord): boolean {
  const { delivery } = record;
  return (
    delivery.attemptedAt !== null ||
    delivery.ambiguousAt !== null ||
    delivery.acceptedAt !== null ||
    delivery.wakeTypedAt !== null ||
    delivery.inboxFetchedAt !== null ||
    delivery.replyReceivedAt !== null
  );
}

function describeDelivery(
  entry: JournalEntry,
  record: ExchangeRecord | null,
  now: number
): { delivery: AssistantExchangeDelivery; at: number | null } {
  if (record === null) {
    return { delivery: "unconfirmed", at: entry.lapsedAt ?? entry.unresolvedAt };
  }
  const { delivery } = record;
  // A reply settles delivery, and outlives the record's later expiry into a tombstone.
  if (delivery.replyReceivedAt !== null) {
    return { delivery: "reply-received", at: delivery.replyReceivedAt };
  }
  // Expired without a reply: whatever was seen before, the exchange never landed.
  if (
    record.outcome === EXPIRED_OUTCOME ||
    (!TERMINAL_EXCHANGE_STATES.has(record.state) && record.expiresAt <= now)
  ) {
    return { delivery: "unconfirmed", at: record.terminalAt ?? record.expiresAt };
  }
  // The lane fetching it answers an earlier attempt left ambiguous.
  if (delivery.inboxFetchedAt !== null) {
    return { delivery: "inbox-fetched", at: delivery.inboxFetchedAt };
  }
  if (delivery.ambiguousAt !== null) return { delivery: "unconfirmed", at: delivery.ambiguousAt };
  if (delivery.wakeTypedAt !== null) return { delivery: "wake-typed", at: delivery.wakeTypedAt };
  // An attempt with nothing after it may or may not have reached the lane.
  if (delivery.attemptedAt !== null) return { delivery: "unconfirmed", at: delivery.attemptedAt };
  // The host holding the record is what accepting it means.
  return { delivery: "accepted", at: delivery.acceptedAt ?? record.createdAt };
}

function cancelKind(
  record: ExchangeRecord | null,
  now: number
): AssistantExchangeCancelKind | null {
  if (record === null || !isLive(record, now)) return null;
  if (record.cancelRequestedAt !== null) return "requested";
  return mayHaveDelivered(record) ? "request" : "cancel";
}

/**
 * The receiving lane's id is `assistantSlotKey(projectId, slot)` on its host.
 * One that doesn't parse keeps its whole id as the project, with no session.
 */
export function parseReceiverLane(laneId: string): { projectId: string; slot: number | null } {
  const at = laneId.lastIndexOf("\u0000");
  if (at === -1) return { projectId: laneId, slot: null };
  const tail = laneId.slice(at + 1);
  const slot = /^\d{1,3}$/.test(tail) ? Number(tail) : NaN;
  return isValidAssistantSlot(slot)
    ? { projectId: laneId.slice(0, at), slot }
    : { projectId: laneId, slot: null };
}

/**
 * One journal entry as the Hosts overview shows it: the host's observed
 * state beside what this Shell saw of delivery, never a conclusion drawn from
 * either. Digests, sizes and the sender credential stay in main.
 */
export function toExchangeView(entry: JournalEntry, now: number): AssistantExchangeView {
  const { record } = entry;
  const delivery = describeDelivery(entry, record, now);
  return {
    // The journal's host, not the record's: on its own machine a receiver is "local".
    hostId: entry.hostId,
    messageId: entry.messageId,
    sentAt: entry.sentAt,
    updatedAt: record?.updatedAt ?? entry.updatedAt,
    state: record?.state ?? null,
    outcome: record?.outcome ?? null,
    delivery: delivery.delivery,
    deliveryAt: delivery.at,
    sendingLane: "hub",
    hopCount: 1,
    receiver: record ? parseReceiverLane(record.receiver.laneId) : null,
    contextId: record?.contextId ?? null,
    cancelRequestedAt: record?.cancelRequestedAt ?? null,
    terminalAt: record?.terminalAt ?? null,
    expiresAt: record && isLive(record, now) ? record.expiresAt : null,
    cancel: cancelKind(record, now),
  };
}

/** Newest send first. */
export function toExchangeViews(
  entries: readonly JournalEntry[],
  now: number
): AssistantExchangeView[] {
  return entries
    .map((entry) => toExchangeView(entry, now))
    .sort((a, b) => b.sentAt - a.sentAt || a.messageId.localeCompare(b.messageId));
}
