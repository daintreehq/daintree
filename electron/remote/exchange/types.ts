/**
 * The records of v0.44's assistant exchanges, retired with the inbox
 * (#13496): what a host still holds for the Shells that sent them, in the
 * shape those Shells read. A2A 1.0's task-state vocabulary, applied to the
 * exchange rather than the work: `completed` means a reply arrived, not that
 * anything in it is right.
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

/** Idempotency scope: one sender's own message ids never collide with another's. */
export interface ExchangeKey {
  senderId: string;
  messageId: string;
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
