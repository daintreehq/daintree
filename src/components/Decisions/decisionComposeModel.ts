import { formatBytes } from "@/lib/formatBytes";
import type {
  AnswerDecisionQuestionPayload,
  DecisionQuestionContent,
} from "@shared/types/decisionsQuestion";
import type { ReviewedImages } from "@/store/decisionsImageReviewStore";
import { pluralize } from "@/lib/pluralize";
import { imageName } from "./decisionQuestionImageModel";

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

export interface AnswerDraft {
  /** The revision the person read when they started this answer: what it is signed against. */
  revision: number;
  /** The chosen option's id, or null. */
  selected: string | null;
  text: string;
}

type ComposedQuestion = ShapedQuestion & Pick<DecisionQuestionContent, "attachments">;

/** A question's images this view couldn't show, as it stands: attachment id to the digest it was listed under. */
export type UnshownImages = Readonly<Record<string, string>>;

export interface ComposeInput {
  question: ComposedQuestion;
  draft: AnswerDraft;
  reviewed: ReviewedImages;
  /** Images that failed to load or draw here, so they can't be opened until a retry shows them. */
  unshown: UnshownImages;
  /** The question moved past the revision this draft was written against. */
  stale: boolean;
  /** The question can no longer take an answer: answered elsewhere, expired, withdrawn. */
  closed: boolean;
}

export interface ComposeVerdict {
  canSend: boolean;
  /**
   * One short reason Send waits, shown beside it, or, once it would go, why the other choices
   * can't; null when nothing is missing or it can't be sent at all.
   */
  hint: string | null;
  /** Bytes over the protocol's answer limit; 0 within it. */
  textOver: number;
  /** Images still to be opened before an approval can be approved. */
  remainingImages: number;
  /** The options that wait on the images: an approval's, until each is opened. */
  blockedOptions: readonly string[];
}

type Option = ShapedQuestion["options"][number];

/**
 * The library's own Reject, offered when the agent names no options and by the design-review
 * gate. Only it goes without an image that couldn't be shown: an agent's own options may reuse
 * its id, and nothing says which of them approves.
 */
function isRejection(option: Option): boolean {
  return option.id === "reject" && option.label === "Reject";
}

type Attachment = DecisionQuestionContent["attachments"][number];

/** Which images couldn't be shown, by name, and so what can't be done here. */
function unshownText(
  question: ComposedQuestion,
  unshown: readonly Attachment[],
  rejectable: boolean
): string {
  const first = unshown[0]!;
  const name = imageName(first, question.attachments.indexOf(first));
  const which =
    unshown.length === 1
      ? `${name} couldn't be shown`
      : `${name} and ${pluralize(unshown.length - 1, "other image")} couldn't be shown`;
  return `${which}, so this can't be ${rejectable ? "approved" : "decided"} here`;
}

/** The draft's choice, while it is still one of the question's options. */
export function chosenOption(question: ShapedQuestion, draft: AnswerDraft): string | null {
  if (draft.selected === null || !composeShape(question).hasOptions) return null;
  return question.options.some((option) => option.id === draft.selected) ? draft.selected : null;
}

export function composeVerdict(input: ComposeInput): ComposeVerdict {
  const { question, draft } = input;
  const shape = composeShape(question);
  const textOver = Math.max(0, textBytes(draft.text) - ANSWER_TEXT_BYTES);
  const hasChoice = chosenOption(question, draft) !== null;
  const hasText = shape.textAllowed && draft.text.trim().length > 0;
  const hasAnswer = shape.hasOptions ? hasChoice || (shape.mixed && hasText) : hasText;
  // An approval decides on the images it was asked with, so each is seen first, as on the phone.
  const unreviewed = shape.approval
    ? question.attachments.filter(
        (attachment) => input.reviewed[attachment.attachmentId] !== attachment.sha256
      )
    : [];
  // A replaced image, listed under another digest, isn't the one that failed.
  const unshown = unreviewed.filter(
    (attachment) => input.unshown[attachment.attachmentId] === attachment.sha256
  );
  const remainingImages = unreviewed.length;
  // Every choice waits on an image that can still be opened, Reject included, as on the phone.
  // One that can't be opened holds back all but Reject, so the person can ask for new images.
  const toOpen = remainingImages - unshown.length;
  const blockedOptions = shape.hasOptions
    ? question.options
        .filter((option) => remainingImages > 0 && (toOpen > 0 || !isRejection(option)))
        .map((option) => option.id)
    : [];
  const chosen = chosenOption(question, draft);
  const waiting = chosen !== null ? blockedOptions.includes(chosen) : remainingImages > 0;
  const unshownHint =
    unshown.length > 0 ? unshownText(question, unshown, question.options.some(isRejection)) : null;

  let hint: string | null = null;
  if (input.closed) hint = null;
  else if (input.stale) hint = "Review the updated question";
  // Before the choice: its options stay unavailable until then.
  else if (toOpen > 0)
    hint =
      toOpen === 1
        ? "Open the remaining image to decide"
        : `Open the remaining ${pluralize(toOpen, "image")} to decide`;
  else if (unshownHint !== null && (waiting || !hasAnswer)) hint = unshownHint;
  else if (!hasAnswer)
    hint = shape.mixed
      ? "Choose an option or write an answer"
      : shape.hasOptions
        ? "Choose an option"
        : "Write an answer";
  else if (textOver > 0) hint = `Shorten your answer by ${formatTextExcess(textOver)}`;
  // Reject goes; the line still says why Approve doesn't.
  else hint = unshownHint;

  const canSend = !input.closed && !input.stale && !waiting && hasAnswer && textOver === 0;
  return { canSend, hint, textOver, remainingImages, blockedOptions };
}

/** Whether the question still takes an answer: waiting, and not past its expiry. */
export function isAnswerable(
  question: Pick<DecisionQuestionContent, "status" | "expiresAt">,
  nowMs: number
): boolean {
  if (question.status !== "open" && question.status !== "queued") return false;
  if (question.expiresAt === null) return true;
  const expires = Date.parse(question.expiresAt);
  return Number.isNaN(expires) || expires > nowMs;
}

export function formatTextExcess(bytes: number): string {
  return bytes < 1024 ? pluralize(bytes, "byte") : formatBytes(bytes);
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
  const chosen = chosenOption(question, draft);
  return {
    reference: question.reference,
    answerId,
    expectedRevision: draft.revision,
    selectedOptionIds: chosen !== null ? [chosen] : [],
    ...(text !== undefined ? { text } : {}),
    ...(shape.approval ? { explicitApproval: true } : {}),
    reviewedAttachmentDigests: reviewedDigests(question.attachments, reviewed),
  };
}
