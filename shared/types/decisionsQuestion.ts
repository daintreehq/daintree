import type { DecisionDeliveryStatus, DecisionsRequirement } from "./decisions.js";

/** One question of a pane, asked by id (#17097). */
export interface GetDecisionQuestionPayload {
  terminalId: string;
  questionId: string;
}

/** The questions of a pane whose opening lines a list needs (#17097). */
export interface GetDecisionQuestionSummariesPayload {
  terminalId: string;
  questionIds: string[];
}

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
    | "received"
    | "terminal-delivered"
    | "needs-attention"
    | "delivery-uncertain"
    | null;
  unreadable: boolean;
}

export type DecisionThreadEntry =
  | DecisionThreadAnswer
  | DecisionThreadExpiry
  | DecisionThreadMessage;

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
