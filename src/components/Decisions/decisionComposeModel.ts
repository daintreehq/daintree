import type {
  AnswerDecisionQuestionPayload,
  DecisionQuestionContent,
} from "@shared/types/decisionsQuestion";
import type { ReviewedImages } from "@/store/decisionsImageReviewStore";

/**
 * What an answer to one question needs, and whether a draft can be sent
 * (#17102): the phone's own rules (`app/src/domain/compose.ts` in
 * daintreehq/decisions), narrowed to an answer. A correction, a follow-up,
 * dictation and photos are the phone's alone for now. Pure, so the composer's
 * button and the check at the moment of Send never disagree.
 */

/** The protocol's answer text limit, in UTF-8 bytes (`LIMITS.answerTextBytes`). */
export const ANSWER_TEXT_BYTES = 16 * 1024;

export interface ComposeShape {
  /** The question's options are offered as a single choice. */
  hasOptions: boolean;
  /** A text field is offered: the answer itself, or a note beside a choice. */
  textAllowed: boolean;
  /** The text is the answer itself (no options), not a note beside a choice. */
  textIsAnswer: boolean;
  /** Either a choice or words answer it. */
  mixed: boolean;
  approval: boolean;
  /** What the choice is called. */
  legend: "Your decision" | "Choose one";
  sendLabel: "Send decision" | "Send answer";
}

type ShapedQuestion = Pick<DecisionQuestionContent, "kind" | "options" | "allowText">;

export function composeShape(question: ShapedQuestion): ComposeShape {
  const hasOptions = question.options.length > 0 && question.kind !== "text";
  const approval = question.kind === "approval";
  return {
    hasOptions,
    textAllowed: !hasOptions || question.allowText,
    textIsAnswer: !hasOptions,
    mixed: question.kind === "mixed" && hasOptions,
    approval,
    legend: approval ? "Your decision" : "Choose one",
    sendLabel: approval ? "Send decision" : "Send answer",
  };
}

export function textBytes(text: string): number {
  return new TextEncoder().encode(text).length;
}

/** The images the person has opened at full size, each under the digest the question lists for it. */
export function reviewedDigests(
  attachments: DecisionQuestionContent["attachments"],
  reviewed: ReviewedImages
): string[] {
  return attachments
    .filter((attachment) => reviewed[attachment.attachmentId] === attachment.sha256)
    .map((attachment) => attachment.sha256);
}

export interface ComposeInput {
  shape: ComposeShape;
  /** The chosen option's id, or null. */
  selected: string | null;
  text: string;
  attachments: DecisionQuestionContent["attachments"];
  reviewed: ReviewedImages;
  /** The question moved past the revision this draft was written against. */
  stale: boolean;
  /** The question can no longer take an answer: answered elsewhere, expired, withdrawn. */
  closed: boolean;
}

export interface ComposeVerdict {
  canSend: boolean;
  /** One short reason Send waits, shown beside it; null when nothing is missing or it can't be sent at all. */
  hint: string | null;
  /** Bytes over the protocol's answer limit; 0 within it. */
  textOver: number;
  /** Images still to be opened before an approval can be sent. */
  remainingImages: number;
}

export function composeVerdict(input: ComposeInput): ComposeVerdict {
  const { shape } = input;
  const textOver = Math.max(0, textBytes(input.text) - ANSWER_TEXT_BYTES);
  const hasChoice = shape.hasOptions && input.selected !== null;
  const hasText = shape.textAllowed && input.text.trim().length > 0;
  const hasAnswer = shape.hasOptions ? hasChoice || (shape.mixed && hasText) : hasText;
  // An approval decides on the images it was asked with, so each is seen first, as on the phone.
  const remainingImages = shape.approval
    ? input.attachments.length - reviewedDigests(input.attachments, input.reviewed).length
    : 0;

  let hint: string | null = null;
  if (input.closed) hint = null;
  else if (input.stale) hint = "Review the updated question";
  else if (remainingImages > 0)
    hint =
      remainingImages === 1
        ? "Open the remaining image"
        : `Open the remaining ${remainingImages.toLocaleString()} images`;
  else if (!hasAnswer)
    hint = shape.mixed
      ? "Choose an option or write an answer"
      : shape.hasOptions
        ? "Choose an option"
        : "Write an answer";
  else if (textOver > 0) hint = `Shorten your answer by ${formatBytes(textOver)}`;

  const canSend =
    !input.closed && !input.stale && remainingImages === 0 && hasAnswer && textOver === 0;
  return { canSend, hint, textOver, remainingImages };
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n.toLocaleString()} ${n === 1 ? "byte" : "bytes"}`;
  return `${(n / 1024).toFixed(1)} KB`;
}

export interface AnswerDraft {
  /** The revision the person read when they started this answer: what it is signed against. */
  revision: number;
  selected: string | null;
  text: string;
}

/** What goes to main for this computer to sign: what the person chose and wrote, as the phone sends it. */
export function answerPayload(
  question: DecisionQuestionContent,
  draft: AnswerDraft,
  reviewed: ReviewedImages,
  answerId: string
): AnswerDecisionQuestionPayload {
  const shape = composeShape(question);
  const text = shape.textAllowed && draft.text.trim().length > 0 ? draft.text : undefined;
  return {
    reference: question.reference,
    answerId,
    expectedRevision: draft.revision,
    selectedOptionIds: shape.hasOptions && draft.selected !== null ? [draft.selected] : [],
    ...(text !== undefined ? { text } : {}),
    ...(shape.approval ? { explicitApproval: true } : {}),
    reviewedAttachmentDigests: reviewedDigests(question.attachments, reviewed),
  };
}
