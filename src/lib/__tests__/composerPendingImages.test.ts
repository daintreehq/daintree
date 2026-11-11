import { beforeEach, describe, expect, it } from "vitest";
import {
  _resetPendingComposerImagesForTesting,
  imageRangesIn,
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

  it("leaves out an image the text doesn't name after the one before it", () => {
    expect(imageRangesIn("/b.png then /a.png", ["/a.png", "/b.png", "/c.png"])).toEqual([
      { from: 12, to: 18, filePath: "/a.png" },
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

  it("drops images whose draft changed before the composer showed it", () => {
    setPendingComposerImages("p:t1", pending);
    expect(takePendingComposerImages("p:t1", "/a.png and more")).toBeNull();
    expect(takePendingComposerImages("p:t1", "/a.png")).toBeNull();
  });
});
