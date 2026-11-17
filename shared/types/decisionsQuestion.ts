import type { DecisionDeliveryStatus, DecisionsRequirement } from "./decisions.js";

/** One question of a pane, asked by id (#17097). */
export interface GetDecisionQuestionPayload {
  terminalId: string;
  questionId: string;
}

/**
 * Part of one image of a pane's question, asked by its attachment id and
 * where the part starts (#17100). An image comes in parts small enough to
 * cross a Remote Host's link, which carries at most 16 MiB in one message.
 */
export interface GetDecisionQuestionImagePayload {
  terminalId: string;
  questionId: string;
  attachmentId: string;
  offset: number;
}

/** The questions of a pane whose opening lines a list needs (#17097). */
export interface GetDecisionQuestionSummariesPayload {
  terminalId: string;
  questionIds: string[];
}

/** A person withdrawing one of a pane's questions from that pane's view (#17099). */
export interface CancelDecisionQuestionPayload {
  terminalId: string;
  questionId: string;
}

/**
 * A person's cancel. `cancelled`: the store records it cancelled, either
 * dropped here because it was never sent or already withdrawn.
 * `cancelling`: the withdrawal is committed and goes to the relay, and the
 * question is cancelled once the relay confirms it. `refused`: it isn't
 * waiting any more (answered, expired, or never published), or the store
 * holds no such question for this pane. `off` and `not-running` as for a read.
 */
export type DecisionQuestionCancelResult =
  | { result: "cancelled" }
  | { result: "cancelling" }
  | { result: "refused"; reason: DecisionQuestionCancelRefusal }
  | { result: "off" }
  | { result: "not-running" };

export type DecisionQuestionCancelRefusal = "answered" | "expired" | "publish-failed" | "not-found";

/** The question's state in the local store: the library's `LocalStatus`. */
export type DecisionQuestionStatus =
  | "queued"
  | "open"
  | "proxy-answered"
  | "human-answered"
  | "cancelled"
  | "expired"
  | "publish-failed";

/** An image the question was published with, as its content describes it. The bytes aren't read here. */
export interface DecisionQuestionAttachment {
  attachmentId: string;
  role: "before" | "after" | "reference" | "other";
  alt: string | null;
  mime: "image/png" | "image/jpeg" | "image/webp";
  /** Bytes of the image itself. */
  size: number;
  /** SHA-256 (hex) of the image itself: what it is checked against, and what an approval names it by. */
  sha256: string;
}

/** An image a person attached to an answer or a follow-up from their phone. */
export interface DecisionThreadImage {
  attachmentId: string;
  alt: string | null;
  mime: "image/png" | "image/jpeg" | "image/webp";
  size: number;
}

/**
 * One answer stored for the question, opened. `person` is a human on a
 * paired device, `model` the proxy model. `unreadable` when its content
 * couldn't be opened here: the choices, text and images are then empty.
 */
export interface DecisionThreadAnswer {
  type: "answer";
  entryId: string;
  revision: number;
  from: "person" | "model";
  /** Replaces an earlier answer. */
  correction: boolean;
  /** A person confirming the model's answer. */
  confirmsModel: boolean;
  /** Chosen options by id, with the label they had when chosen. */
  choices: { id: string; label: string | null }[];
  text: string | null;
  /** Why a person corrected an earlier answer. */
  reason: string | null;
  images: DecisionThreadImage[];
  sentAt: string;
  unreadable: boolean;
}

/** The question expired unanswered. */
export interface DecisionThreadExpiry {
  type: "expired";
  entryId: string;
  sentAt: string;
}

/**
 * A follow-up message on the question's thread, from the person or the
 * agent. A follow-up never answers the question. `deliveryStatus` is how far
 * a person's message has got into the pane; null for the agent's own.
 */
export interface DecisionThreadMessage {
  type: "message";
  messageId: string;
  from: "person" | "agent";
  text: string | null;
  images: DecisionThreadImage[];
  expectsReply: boolean;
  sentAt: string;
  deliveryStatus:
    "received" | "terminal-delivered" | "needs-attention" | "delivery-uncertain" | null;
  unreadable: boolean;
}

export type DecisionThreadEntry =
  DecisionThreadAnswer | DecisionThreadExpiry | DecisionThreadMessage;

/** A question with its content opened, in memory, for the desktop to show. Never stored. */
export interface DecisionQuestionContent {
  questionId: string;
  alias: number;
  terminalId: string;
  question: string;
  /** The notes the agent gave with the question. */
  context: string | null;
  kind: "choice" | "approval" | "text" | "mixed";
  options: { id: string; label: string; description: string | null }[];
  /** A person may answer in their own words. */
  allowText: boolean;
  requirement: DecisionsRequirement;
  askedAt: string;
  /** ISO 8601 as recorded; null when the question never expires. */
  expiresAt: string | null;
  status: DecisionQuestionStatus;
  deliveryStatus: DecisionDeliveryStatus;
  attachments: DecisionQuestionAttachment[];
  /** Answers, expiry and follow-ups, in the order the relay recorded them. */
  thread: DecisionThreadEntry[];
}

/**
 * Reading a question. `off`: Decisions is off here, so nothing loaded.
 * `not-running`: no relay connection runs to open content with.
 * `not-found`: the store holds no such question for this pane.
 * `unreadable`: the store holds it, but its content can't be opened here.
 */
export type DecisionQuestionContentResult =
  | { result: "read"; question: DecisionQuestionContent }
  | { result: "off" }
  | { result: "not-running" }
  | { result: "not-found" }
  | { result: "unreadable" };

/** One question's opening line, or why there is none. */
export type DecisionQuestionSummary =
  | { questionId: string; result: "read"; line: string | null }
  | { questionId: string; result: "not-found" }
  | { questionId: string; result: "unreadable" };

/** The opening lines of a pane's questions, in the order they were asked for, each id once. */
export type DecisionQuestionSummariesResult =
  | { result: "read"; summaries: DecisionQuestionSummary[] }
  | { result: "off" }
  | { result: "not-running" };

/**
 * Why one of a question's images can't be shown, as checked in order:
 * `key-unavailable`, the key it was sealed under isn't held here;
 * `fetch-failed`, the relay didn't serve it (gone, past retention, unreachable);
 * `size-mismatch`, it isn't the size the question declares;
 * `decrypt-failed`, it doesn't open under the question's binding;
 * `digest-mismatch`, what opened doesn't hash to the question's digest;
 * `type-mismatch`, it isn't the PNG, JPEG or WebP image the question declares;
 * `timed-out`, fetching and checking it took too long.
 */
export type DecisionQuestionImageUnavailable =
  | "key-unavailable"
  | "fetch-failed"
  | "size-mismatch"
  | "decrypt-failed"
  | "digest-mismatch"
  | "type-mismatch"
  | "timed-out";

/** One of a question's images, opened and checked against its digest, in memory. Never stored. */
export interface DecisionQuestionImage {
  attachmentId: string;
  mime: DecisionQuestionAttachment["mime"];
  /** The digest the image was checked against. */
  sha256: string;
  /** Backed by a plain ArrayBuffer, as structured clone and the Remote Host link both deliver bytes. */
  bytes: Uint8Array<ArrayBuffer>;
}

/**
 * Part of one of a question's images: the whole image was opened and checked
 * against its digest for this read, and `bytes` are the part of it that
 * starts at `offset`, empty past its end.
 */
export interface DecisionQuestionImagePart extends DecisionQuestionImage {
  /** Bytes of the whole image. */
  size: number;
  offset: number;
}

/**
 * Reading one of a question's images. `not-found`: the store holds no such
 * question for this pane, or the question names no such image.
 * `unreadable`: the question's content can't be opened here.
 */
type DecisionQuestionImageRead<Read> =
  | Read
  | { result: "unavailable"; reason: DecisionQuestionImageUnavailable }
  | { result: "off" }
  | { result: "not-running" }
  | { result: "not-found" }
  | { result: "unreadable" };

/** One part of an image, as one read over IPC answers. */
export type DecisionQuestionImagePartResult = DecisionQuestionImageRead<{
  result: "read";
  part: DecisionQuestionImagePart;
}>;

/** A whole image, as the renderer's client assembles it from its parts. */
export type DecisionQuestionImageResult = DecisionQuestionImageRead<{
  result: "read";
  image: DecisionQuestionImage;
}>;

/**
 * One question this computer's Decisions holds, named wherever it is read
 * from (#17229): the machine that asked it, and the project, terminal and
 * question there. Any Daintree window on this computer may read it by this
 * reference, whatever project it shows and whether the terminal is still open.
 */
export interface DecisionQuestionReference {
  hostId: string;
  projectId: string;
  terminalId: string;
  questionId: string;
}

/**
 * Where a question stands, in exactly one place:
 * - `waiting`: for the person, because it is `open`, or because it was
 *   answered and the agent's latest follow-up expects a `reply`;
 * - `queued`: not yet sent to the relay; `send-failed`: it never could be;
 * - `to-type`: answered, or followed up by the person, and waiting to be typed in;
 * - `needs-attention`: an answer or a person's follow-up that delivery stopped
 *   on, as the list of answers needing attention shows it;
 * - `settled`: answered and typed in or marked handled, withdrawn, expired,
 *   or declined (reserved: nothing records a decline yet).
 */
export type DecisionQuestionStanding =
  | { kind: "waiting"; reason: "open" | "reply" }
  | { kind: "queued" }
  | { kind: "send-failed" }
  | { kind: "to-type" }
  | { kind: "needs-attention"; deliveryStatus: "needs-attention" | "delivery-uncertain" }
  | { kind: "settled"; outcome: "answered"; handled: boolean }
  | { kind: "settled"; outcome: "withdrawn" | "expired" | "declined" };

/**
 * A question as the list names it: who asked, where, when, and where it
 * stands. Never its words: they are read on demand by reference.
 */
export interface DecisionQuestionListItem {
  reference: DecisionQuestionReference;
  alias: number;
  /** The agent that asked (`claude`, `codex`, …). */
  agentKind: string;
  /** The project's name as it was when asked; null when the question carries none. */
  projectLabel: string | null;
  worktreeId: string;
  /** Where the worktree was on this computer when asked. */
  worktreeRoot: string;
  requirement: DecisionsRequirement;
  askedAt: string;
  /** ISO 8601 as recorded; null when the question never expires. */
  expiresAt: string | null;
  /**
   * When it was settled: the answer that settled it, or its expiry. Null
   * while it isn't settled, and for a withdrawal, which records no time.
   */
  settledAt: string | null;
  standing: DecisionQuestionStanding;
}

/**
 * Every question this computer's Decisions holds, oldest first. Empty while
 * Decisions is off or its store is closed. `revision` only rises, so a read
 * and a push can be ordered.
 */
export interface DecisionQuestionList {
  revision: number;
  questions: DecisionQuestionListItem[];
}

/** Open one question in the window's question view: a click on its desktop notification (#17232). */
export interface DecisionsOpenQuestionRequest {
  reference: DecisionQuestionReference;
}

/** One question read by its reference, from any window (#17229). */
export interface GetDecisionQuestionByReferencePayload {
  reference: DecisionQuestionReference;
}

/** Part of one image of a question, read by its reference. */
export interface GetDecisionQuestionImageByReferencePayload {
  reference: DecisionQuestionReference;
  attachmentId: string;
  offset: number;
}

/** The questions whose opening lines a list needs, by reference. */
export interface GetDecisionQuestionSummariesByReferencePayload {
  references: DecisionQuestionReference[];
}

/** A person withdrawing a question by its reference, from any window. */
export interface CancelDecisionQuestionByReferencePayload {
  reference: DecisionQuestionReference;
}
