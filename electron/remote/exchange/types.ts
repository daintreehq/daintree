/**
 * A2A 1.0's task-state vocabulary, applied to the exchange rather than the
 * work: `completed` means a reply arrived, not that anything in it is right.
 */
export const EXCHANGE_STATES = [
  "submitted",
  "working",
  "input-required",
  "completed",
  "canceled",
  "failed",
  "rejected",
] as const;

export type ExchangeState = (typeof EXCHANGE_STATES)[number];

export const TERMINAL_EXCHANGE_STATES: ReadonlySet<ExchangeState> = new Set([
  "completed",
  "canceled",
  "failed",
  "rejected",
]);

/** Delivery observations, each recorded the first time it is seen. */
export type DeliveryFact = "accepted" | "wake-typed" | "inbox-fetched" | "reply-received";

/** The authenticated Shell that sent the exchange. Never read from the payload. */
export interface SenderActor {
  kind: "sender";
  senderId: string;
}

export interface ExchangeReceiver {
  hostId: string;
  laneId: string;
  /** The policy's generation for the enrollment the exchange was admitted under. */
  enrollmentGeneration: string;
}

/** The receiving lane, as enrolled. A later enrollment generation is a different participant. */
export interface ReceiverActor extends ExchangeReceiver {
  kind: "receiver";
}

export type ExchangeActor = SenderActor | ReceiverActor;

/** Idempotency scope: one sender's own message ids never collide with another's. */
export interface ExchangeKey {
  senderId: string;
  messageId: string;
}

export interface CreateExchangeInput {
  messageId: string;
  contextId: string;
  referenceTaskIds: readonly string[];
  receiver: ExchangeReceiver;
  /** Hashed and measured, never stored. */
  body: string;
}

export interface ExchangeDelivery {
  /** Set before anything leaves; with no fact after it, the outcome is unknown. */
  attemptedAt: number | null;
  acceptedAt: number | null;
  wakeTypedAt: number | null;
  inboxFetchedAt: number | null;
  replyReceivedAt: number | null;
  ambiguousAt: number | null;
}

export interface ExchangeRecord {
  taskId: string;
  senderId: string;
  messageId: string;
  contextId: string;
  referenceTaskIds: string[];
  receiver: ExchangeReceiver;
  state: ExchangeState;
  outcome: string | null;
  bodyDigest: string;
  bodyBytes: number;
  replyDigest: string | null;
  replyBytes: number | null;
  delivery: ExchangeDelivery;
  cancelRequestedAt: number | null;
  createdAt: number;
  updatedAt: number;
  expiresAt: number;
  terminalAt: number | null;
  /** Set once the record has expired; it is kept only to refuse late resends. */
  tombstonedAt: number | null;
  revision: number;
}

export type CreateDisposition = "created" | "existing" | "tombstoned";

export interface CreateExchangeResult {
  disposition: CreateDisposition;
  record: ExchangeRecord;
}

export interface ExchangeChanges {
  records: ExchangeRecord[];
  /** Pass back as the next cursor. Local to this database; never comparable across hosts. */
  cursor: number;
  hasMore: boolean;
  /** The cursor predates purged records: `records` restarts from the beginning. */
  reset: boolean;
}

export interface ExchangeSweepResult {
  expired: number;
  purged: number;
  auditPurged: number;
  hasMore: boolean;
}
