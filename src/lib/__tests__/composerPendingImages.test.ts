import { beforeEach, describe, expect, it } from "vitest";
import {
  _resetPendingComposerImagesForTesting,
  imageRangesIn,
  restoreChange,
  setPendingComposerImages,
  takePendingComposerImages,
} from "../composerPendingImages";

beforeEach(() => _resetPendingComposerImagesForTesting());

describe("imageRangesIn", () => {
  it("finds each image in order, one mention apiece", () => {
    const text = "/a.png beside /b.png, then /a.png again";
    expect(imageRangesIn(text, ["/a.png", "/b.png", "/a.png"])).toEqual([
      { from: 0, to: 6, filePath: "/a.png" },
      { from: 14, to: 20, filePath: "/b.png" },
      { from: 27, to: 33, filePath: "/a.png" },
    ]);
  });

  it("leaves out an image the text doesn't name after the one before it, and goes on", () => {
    const text = "/b.png then /a.png and /d.png";
    expect(imageRangesIn(text, ["/a.png", "/b.png", "/c.png", "/d.png"])).toEqual([
      { from: 12, to: 18, filePath: "/a.png" },
      { from: 23, to: 29, filePath: "/d.png" },
    ]);
  });

  it("finds nothing for an empty path", () => {
    expect(imageRangesIn("text", [""])).toEqual([]);
  });
});

describe("pending composer images", () => {
  const pending = {
    draft: "/a.png",
    before: "",
    change: { from: 0, to: 0, insert: "/a.png" },
    images: [{ from: 0, to: 6, filePath: "/a.png" }],
  };

  it("hands the images to the composer showing their draft, once", () => {
    setPendingComposerImages("p:t1", pending);
    expect(takePendingComposerImages("p:t2", "/a.png")).toBeNull();
    expect(takePendingComposerImages("p:t1", "/a.png")).toEqual(pending);
    expect(takePendingComposerImages("p:t1", "/a.png")).toBeNull();
  });

  it("hands them to a draft that was only added to before the composer showed it", () => {
    setPendingComposerImages("p:t1", pending);
    expect(takePendingComposerImages("p:t1", "/a.png and the logs")).toEqual(pending);
  });

  it("drops images whose text changed before the composer showed it", () => {
    setPendingComposerImages("p:t1", pending);
    expect(takePendingComposerImages("p:t1", "see /a.png")).toBeNull();
    expect(takePendingComposerImages("p:t1", "/a.png")).toBeNull();
  });

  it("keeps only the latest write's images", () => {
    const later = { ...pending, draft: "/b.png", images: [{ from: 0, to: 6, filePath: "/b.png" }] };
    setPendingComposerImages("p:t1", pending);
    setPendingComposerImages("p:t1", later);
    expect(takePendingComposerImages("p:t1", "/b.png")).toEqual(later);
  });
});

describe("restoreChange", () => {
  const apply = (text: string, changes: { from: number; to: number; insert: string }[]) =>
    [...changes]
      .sort((a, b) => b.from - a.from)
      .reduce((doc, c) => doc.slice(0, c.from) + c.insert + doc.slice(c.to), text);

  const prepended = {
    draft: "held\n\nmine",
    before: "mine",
    change: { from: 0, to: 0, insert: "held\n\n" },
    images: [],
  };
  const replaced = {
    draft: "held",
    before: "  ",
    change: { from: 0, to: 2, insert: "held" },
    images: [],
  };

  it("is the restore itself while nothing was added", () => {
    expect(restoreChange(prepended, prepended.draft)).toEqual([prepended.change]);
  });

  it.each([
    ["prepended to", prepended],
    ["replacing", replaced],
  ])("brings the draft it was %s up to one added to since", (_how, pending) => {
    const draft = `${pending.draft} and the logs`;
    expect(apply(pending.before, restoreChange(pending, draft))).toBe(draft);
  });

  it("leaves the draft it went over in place, adding around it", () => {
    expect(restoreChange(prepended, "held\n\nmine and the logs")).toEqual([
      { from: 0, to: 0, insert: "held\n\n" },
      { from: 4, to: 4, insert: " and the logs" },
    ]);
  });
});
