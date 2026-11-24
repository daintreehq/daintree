import { describe, expect, it } from "vitest";
import type { DecisionQuestionAttachment } from "@shared/types/decisionsQuestion";
import {
  canRetryImage,
  comparePairFrom,
  imageName,
  reviewedDigests,
  unreviewedAttachments,
  unshownImages,
} from "../decisionQuestionImageModel";

function image(
  attachmentId: string,
  role: DecisionQuestionAttachment["role"],
  sha256: string
): DecisionQuestionAttachment {
  return { attachmentId, role, alt: null, mime: "image/png", size: 10, sha256 };
}

const B1 = image("attach_0001", "before", "1".repeat(64));
const A1 = image("attach_0002", "after", "2".repeat(64));
const R1 = image("attach_0003", "reference", "3".repeat(64));
const B2 = image("attach_0004", "before", "4".repeat(64));
const A2 = image("attach_0005", "after", "5".repeat(64));

describe("imageName", () => {
  it("names an image by its role and place, or its place alone with no role", () => {
    expect(imageName(B1, 0)).toBe("Before image 1");
    expect(imageName(image("attach_0009", "other", "9".repeat(64)), 2)).toBe("Image 3");
  });
});

describe("comparePairFrom", () => {
  const images = [B1, A1, R1, B2, A2];

  it("puts the image on screen on its own side, beside the first of the other role", () => {
    expect(comparePairFrom(images, 3)).toEqual({ before: 3, after: 1 });
    expect(comparePairFrom(images, 4)).toEqual({ before: 0, after: 4 });
  });

  it("starts from the first before and after when the image on screen has neither role", () => {
    expect(comparePairFrom(images, 2)).toEqual({ before: 0, after: 1 });
  });

  it("has nothing to compare without both roles", () => {
    expect(comparePairFrom([B1, B2, R1], 0)).toBeNull();
    expect(comparePairFrom([A1, R1], 0)).toBeNull();
  });
});

describe("reviewed images", () => {
  it("lists the digests of the images seen, in the question's order, once per image", () => {
    // Two images with the same bytes share a digest; each counts on its own.
    const twin = image("attach_0006", "other", B1.sha256);
    const images = [B1, A1, twin, R1];
    const reviewed = {
      [twin.attachmentId]: twin.sha256,
      [B1.attachmentId]: B1.sha256,
      [R1.attachmentId]: R1.sha256,
    };

    expect(reviewedDigests(images, reviewed)).toEqual([B1.sha256, B1.sha256, R1.sha256]);
    expect(unreviewedAttachments(images, reviewed)).toEqual([A1]);
  });

  it("doesn't count an image seen under another digest than the question now lists", () => {
    const reviewed = { [B1.attachmentId]: "0".repeat(64) };

    expect(reviewedDigests([B1], reviewed)).toEqual([]);
    expect(unreviewedAttachments([B1], reviewed)).toEqual([B1]);
  });
});

describe("canRetryImage", () => {
  it("offers a retry for what may come back, never for a failed check", () => {
    expect(canRetryImage("fetch-failed")).toBe(true);
    expect(canRetryImage("timed-out")).toBe(true);
    expect(canRetryImage("not-running")).toBe(true);
    // A Remote Host's image comes back with its link (#17230).
    expect(canRetryImage("host-not-connected")).toBe(true);
    expect(canRetryImage("failed")).toBe(true);
    for (const verdict of [
      "size-mismatch",
      "decrypt-failed",
      "digest-mismatch",
      "type-mismatch",
      "not-found",
      "unreadable",
      "off",
    ] as const) {
      expect(canRetryImage(verdict), verdict).toBe(false);
    }
  });
});

describe("unshownImages", () => {
  it("lists each failed load by the digest the question lists it under, and nothing still coming or shown", () => {
    const B2 = image("attach_0003", "before", "3".repeat(64));
    expect(
      unshownImages([B1, A1, B2], {
        [B1.attachmentId]: { status: "failed", failure: "digest-mismatch" },
        [A1.attachmentId]: { status: "ready", url: "blob:a1" },
        [B2.attachmentId]: { status: "loading" },
      })
    ).toEqual({ [B1.attachmentId]: B1.sha256 });
    // An image the loads don't know of yet is still coming, not failed.
    expect(unshownImages([B1], {})).toEqual({});
  });
});
