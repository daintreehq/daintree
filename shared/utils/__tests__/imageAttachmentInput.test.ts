import { describe, it, expect } from "vitest";
import { isImageAttachmentPath, splitImageInputSegments } from "../imageAttachmentInput.js";

describe("isImageAttachmentPath", () => {
  it("accepts absolute local image paths, spaces and Unicode included", () => {
    expect(isImageAttachmentPath("/Users/me/shot.png")).toBe(true);
    expect(isImageAttachmentPath("/Users/me/Screenshot 2026-09-25 at 10.00.00.png")).toBe(true);
    expect(isImageAttachmentPath("/tmp/café/图像.JPEG")).toBe(true);
    expect(isImageAttachmentPath("C:\\Users\\me\\shot.png")).toBe(true);
    expect(isImageAttachmentPath("D:/shots/shot.heic")).toBe(true);
  });

  it("refuses non-images, relative paths and remote spellings", () => {
    expect(isImageAttachmentPath("/Users/me/notes.txt")).toBe(false);
    expect(isImageAttachmentPath("shot.png")).toBe(false);
    expect(isImageAttachmentPath("./shot.png")).toBe(false);
    expect(isImageAttachmentPath("@shot.png")).toBe(false);
    expect(isImageAttachmentPath("\\\\server\\share\\shot.png")).toBe(false);
    expect(isImageAttachmentPath("//server/share/shot.png")).toBe(false);
    expect(isImageAttachmentPath("https://example.com/shot.png")).toBe(false);
    expect(isImageAttachmentPath("")).toBe(false);
  });

  it("refuses control characters and surrounding whitespace", () => {
    expect(isImageAttachmentPath("/tmp/a\nb.png")).toBe(false);
    expect(isImageAttachmentPath("/tmp/a\x1bb.png")).toBe(false);
    expect(isImageAttachmentPath("/tmp/a\tb.png")).toBe(false);
    expect(isImageAttachmentPath("/tmp/a.png ")).toBe(false);
  });
});

describe("splitImageInputSegments", () => {
  it("keeps text and images in their original order", () => {
    expect(
      splitImageInputSegments("look /a/one.png then /a/two.png please", [
        "/a/one.png",
        "/a/two.png",
      ])
    ).toEqual([
      { kind: "text", text: "look " },
      { kind: "image", path: "/a/one.png" },
      { kind: "text", text: " then " },
      { kind: "image", path: "/a/two.png" },
      { kind: "text", text: " please" },
    ]);
  });

  it("handles paths with spaces and adjacent images", () => {
    const shot = "/Users/me/Screen Shot 1.png";
    expect(splitImageInputSegments(`${shot} ${shot} `, [shot, shot])).toEqual([
      { kind: "image", path: shot },
      { kind: "text", text: " " },
      { kind: "image", path: shot },
      { kind: "text", text: " " },
    ]);
  });

  it("only matches on token boundaries", () => {
    expect(splitImageInputSegments("see /x/a/one.png", ["/a/one.png"])).toEqual([
      { kind: "text", text: "see /x/a/one.png" },
    ]);
    expect(splitImageInputSegments("see /x/a/one.png /a/one.png", ["/a/one.png"])).toEqual([
      { kind: "text", text: "see /x/a/one.png " },
      { kind: "image", path: "/a/one.png" },
    ]);
  });

  it("treats punctuation as a boundary only where the path ends", () => {
    expect(splitImageInputSegments("see /tmp/a.png.backup /tmp/a.png.", ["/tmp/a.png"])).toEqual([
      { kind: "text", text: "see /tmp/a.png.backup " },
      { kind: "image", path: "/tmp/a.png" },
      { kind: "text", text: "." },
    ]);
  });

  it("finds a quoted path", () => {
    expect(splitImageInputSegments('the file "/a/one.png" here', ["/a/one.png"])).toEqual([
      { kind: "text", text: 'the file "' },
      { kind: "image", path: "/a/one.png" },
      { kind: "text", text: '" here' },
    ]);
  });

  it("splits Windows paths the same way", () => {
    const shot = "C:\\Users\\me\\Screen Shot.png";
    expect(splitImageInputSegments(`look ${shot}`, [shot])).toEqual([
      { kind: "text", text: "look " },
      { kind: "image", path: shot },
    ]);
  });

  it("skips paths that are not in the text", () => {
    expect(splitImageInputSegments("just text", ["/a/gone.png"])).toEqual([
      { kind: "text", text: "just text" },
    ]);
    expect(splitImageInputSegments("", ["/a/gone.png"])).toEqual([]);
  });

  it("searches forward only, so order is never reversed", () => {
    expect(splitImageInputSegments("/a/two.png /a/one.png", ["/a/one.png", "/a/two.png"])).toEqual([
      { kind: "text", text: "/a/two.png " },
      { kind: "image", path: "/a/one.png" },
    ]);
  });
});
