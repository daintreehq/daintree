import type {
  DecisionQuestionAttachment,
  DecisionQuestionImageResult,
  DecisionQuestionImageUnavailable,
} from "@shared/types/decisionsQuestion";
import type { ReviewedImages } from "@/store/decisionsImageReviewStore";

/**
 * What the Decisions question view says about a question's images (#17100):
 * their roles, why one can't be shown, which pair compares, and which of
 * them a person has actually seen at full size.
 */

/**
 * Why an image isn't on screen: what its read answered, `failed` when the
 * read itself broke, or `undecodable` when it passed every check but this
 * view couldn't draw it.
 */
export type QuestionImageFailure =
  | DecisionQuestionImageUnavailable
  | Exclude<DecisionQuestionImageResult["result"], "read" | "unavailable">
  | "failed"
  | "undecodable";

export type QuestionImageLoad =
  | { status: "loading" }
  | { status: "ready"; url: string }
  | { status: "failed"; failure: QuestionImageFailure };

const ROLE_LABEL: Record<DecisionQuestionAttachment["role"], string | null> = {
  before: "Before",
  after: "After",
  reference: "Reference",
  other: null,
};

/** The role the agent gave an image, as a label; null for an image with no particular role. */
export function imageRoleLabel(role: DecisionQuestionAttachment["role"]): string | null {
  return ROLE_LABEL[role];
}

/** An image by its role and place among the question's, "Before image 1", or "Image 3" with no role. */
export function imageName(attachment: DecisionQuestionAttachment, index: number): string {
  const place = (index + 1).toLocaleString();
  const role = imageRoleLabel(attachment.role);
  return role === null ? `Image ${place}` : `${role} image ${place}`;
}

const FAILURE_TEXT: Record<QuestionImageFailure, string> = {
  "key-unavailable": "This computer doesn't hold the key this image was encrypted with.",
  "fetch-failed": "The relay didn't serve this image. It may be past its retention.",
  "size-mismatch": "This image isn't the size the question declares, so it isn't shown.",
  "decrypt-failed": "This image didn't open with the question's key, so it isn't shown.",
  "digest-mismatch": "This image doesn't match its digest, so it isn't shown.",
  "type-mismatch": "This image isn't the type the question declares, so it isn't shown.",
  "timed-out": "Fetching this image took too long.",
  off: "Decisions is off on the computer that owns this terminal.",
  "not-running": "Decisions isn't connected to its relay right now.",
  "host-not-connected": "The Remote Host that asked this question isn't connected right now.",
  "not-found": "This image is no longer kept for this question.",
  unreadable: "This question couldn't be opened on this computer.",
  failed: "This image couldn't be read.",
  undecodable: "This image matches its digest but couldn't be drawn.",
};

export function imageFailureText(failure: QuestionImageFailure): string {
  return FAILURE_TEXT[failure];
}

/**
 * Whether reading again could show it. A check that failed (size, binding,
 * digest, type) is a verdict on what the relay holds, and stands.
 */
export function canRetryImage(failure: QuestionImageFailure): boolean {
  switch (failure) {
    case "key-unavailable":
    case "fetch-failed":
    case "timed-out":
    case "not-running":
    case "host-not-connected":
    case "failed":
      return true;
    default:
      return false;
  }
}

/** "2 of 4" for an image among the question's. */
export function imagePositionText(index: number, count: number): string {
  return `${(index + 1).toLocaleString()} of ${count.toLocaleString()}`;
}

/** The indexes of the question's images with a role, in the order the question lists them. */
export function indexesWithRole(
  attachments: readonly DecisionQuestionAttachment[],
  role: "before" | "after"
): number[] {
  return attachments.flatMap((attachment, index) => (attachment.role === role ? [index] : []));
}

/**
 * The before and after to compare, starting from the image on screen: that
 * image on its own side, and the first image of the other role. Roles say
 * nothing about which before goes with which after, so the rest are chosen,
 * never paired by position. Null when the question lacks either role.
 */
export function comparePairFrom(
  attachments: readonly DecisionQuestionAttachment[],
  index: number
): { before: number; after: number } | null {
  const befores = indexesWithRole(attachments, "before");
  const afters = indexesWithRole(attachments, "after");
  const [firstBefore] = befores;
  const [firstAfter] = afters;
  if (firstBefore === undefined || firstAfter === undefined) return null;
  const role = attachments[index]?.role;
  return {
    before: role === "before" ? index : firstBefore,
    after: role === "after" ? index : firstAfter,
  };
}

function wasReviewed(attachment: DecisionQuestionAttachment, reviewed: ReviewedImages): boolean {
  return reviewed[attachment.attachmentId] === attachment.sha256;
}

/**
 * The digests of the images a person has seen, in the question's order, one
 * per image: two images with the same bytes count twice, as an answer's
 * `reviewed_attachment_digests` lists them.
 */
export function reviewedDigests(
  attachments: readonly DecisionQuestionAttachment[],
  reviewed: ReviewedImages
): string[] {
  return attachments.flatMap((attachment) =>
    wasReviewed(attachment, reviewed) ? [attachment.sha256] : []
  );
}

/** The images a person hasn't yet seen at full size: an approval waits until there are none. */
export function unreviewedAttachments(
  attachments: readonly DecisionQuestionAttachment[],
  reviewed: ReviewedImages
): DecisionQuestionAttachment[] {
  return attachments.filter((attachment) => !wasReviewed(attachment, reviewed));
}

/**
 * The images this view couldn't show, as they stand: each failed load, by the
 * digest the question lists it under. A retry takes one off until it fails again.
 */
export function unshownImages(
  attachments: readonly DecisionQuestionAttachment[],
  loads: Readonly<Record<string, QuestionImageLoad>>
): Readonly<Record<string, string>> {
  return Object.fromEntries(
    attachments.flatMap((attachment) =>
      loads[attachment.attachmentId]?.status === "failed"
        ? [[attachment.attachmentId, attachment.sha256]]
        : []
    )
  );
}
