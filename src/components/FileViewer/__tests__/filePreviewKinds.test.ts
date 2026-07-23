import { describe, expect, it } from "vitest";
import {
  buildDaintreeFileUrl,
  isImageFilePath,
  isSvgFilePath,
  isUnsupportedVideoFilePath,
  isVideoFilePath,
} from "../filePreviewKinds";

describe("filePreviewKinds", () => {
  describe("isVideoFilePath", () => {
    it.each(["clip.mp4", "clip.m4v", "clip.webm", "clip.ogv", "CLIP.MP4", "a/b/c.demo.webm"])(
      "accepts %s",
      (path) => {
        expect(isVideoFilePath(path)).toBe(true);
      }
    );

    it.each([
      // Containers Chromium can't demux stay out so a <video> element is never
      // offered for a file it cannot play.
      "clip.mov",
      "clip.mkv",
      "clip.avi",
      "clip.wmv",
      // Lookalikes and non-videos. (A bare extensionless name like "mp4" is
      // NOT here: extensionOf treats it as its own extension, matching the
      // long-standing isImageFilePath("png") behavior.)
      "clip.mp4.txt",
      "clip",
      "photo.png",
      "notes.md",
    ])("rejects %s", (path) => {
      expect(isVideoFilePath(path)).toBe(false);
    });

    it("never overlaps the image classifier", () => {
      for (const path of ["clip.mp4", "clip.webm", "clip.m4v", "clip.ogv"]) {
        expect(isImageFilePath(path)).toBe(false);
        expect(isSvgFilePath(path)).toBe(false);
      }
    });
  });

  describe("isUnsupportedVideoFilePath", () => {
    it.each(["clip.mov", "clip.mkv", "clip.avi", "clip.wmv", "CLIP.MOV"])("accepts %s", (path) => {
      expect(isUnsupportedVideoFilePath(path)).toBe(true);
    });

    it("is disjoint from the playable set", () => {
      for (const path of ["clip.mp4", "clip.webm", "clip.m4v", "clip.ogv"]) {
        expect(isUnsupportedVideoFilePath(path)).toBe(false);
      }
    });
  });

  describe("buildDaintreeFileUrl", () => {
    it("encodes path and root as query params", () => {
      const url = buildDaintreeFileUrl("/a dir/clip.mp4", "/a dir");
      expect(url).toBe("daintree-file://load?path=%2Fa%20dir%2Fclip.mp4&root=%2Fa%20dir");
    });
  });
});
