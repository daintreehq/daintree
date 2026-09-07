import { describe, expect, it } from "vitest";
import {
  buildDaintreeFileUrl,
  buildDaintreePdfUrl,
  isAudioFilePath,
  isFileContentsCopyCandidate,
  isImageFilePath,
  isPdfFilePath,
  isSvgFilePath,
  isUnsupportedAudioFilePath,
  isUnsupportedVideoFilePath,
  isVideoFilePath,
} from "../filePreviewKinds";

describe("filePreviewKinds", () => {
  describe("isImageFilePath", () => {
    it.each([
      "photo.png",
      "photo.jpg",
      "photo.jpeg",
      "photo.gif",
      "photo.webp",
      "photo.bmp",
      "photo.ico",
      "icon.svg",
      // Chromium decodes and animates both natively; before #11426 they fell
      // through to the text path and reported "Binary file — cannot display".
      "photo.avif",
      "animation.apng",
      // Case is normalized before lookup, so a shouty extension still renders.
      "PHOTO.AVIF",
      "ANIMATION.APNG",
      "a/b/c.render.avif",
    ])("accepts %s", (path) => {
      expect(isImageFilePath(path)).toBe(true);
    });

    it.each([
      // Only the final extension counts — a lookalike suffix is still text.
      "photo.avif.txt",
      "animation.apng.txt",
      "notes.md",
      "clip.mp4",
      "archive.zip",
    ])("rejects %s", (path) => {
      expect(isImageFilePath(path)).toBe(false);
    });

    it("treats the new raster formats as <img> sources, not sanitized SVG", () => {
      // isSvgFilePath gates the read-as-text-and-sanitize branch; a raster
      // format landing there would be read as a string and rejected as binary.
      for (const path of ["photo.avif", "animation.apng"]) {
        expect(isSvgFilePath(path)).toBe(false);
        expect(isVideoFilePath(path)).toBe(false);
        expect(isUnsupportedVideoFilePath(path)).toBe(false);
      }
    });
  });

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

  describe("isAudioFilePath", () => {
    it.each([
      "track.mp3",
      "track.wav",
      "track.flac",
      "track.ogg",
      "track.oga",
      "track.opus",
      // m4a/aac ride the same proprietary-codec build that makes mp4 play.
      "track.m4a",
      "track.aac",
      "TRACK.MP3",
      "a/b/c.take 2.flac",
    ])("accepts %s", (path) => {
      expect(isAudioFilePath(path)).toBe(true);
    });

    it.each([
      "track.wma",
      "track.aiff",
      "track.mid",
      "track.mp3.txt",
      "track",
      "photo.png",
      "notes.md",
    ])("rejects %s", (path) => {
      expect(isAudioFilePath(path)).toBe(false);
    });

    it("claims .ogg while video keeps .ogv", () => {
      // The two Ogg spellings are split across the classifiers; overlapping
      // them would make the pane's branch order decide which player appears.
      expect(isAudioFilePath("sound.ogg")).toBe(true);
      expect(isVideoFilePath("sound.ogg")).toBe(false);
      expect(isVideoFilePath("clip.ogv")).toBe(true);
      expect(isAudioFilePath("clip.ogv")).toBe(false);
    });

    it("never overlaps the image or video classifiers", () => {
      for (const path of ["track.mp3", "track.flac", "track.m4a", "track.opus"]) {
        expect(isImageFilePath(path)).toBe(false);
        expect(isSvgFilePath(path)).toBe(false);
        expect(isVideoFilePath(path)).toBe(false);
      }
    });
  });

  describe("isUnsupportedAudioFilePath", () => {
    it.each([
      "track.wma",
      "track.aiff",
      "track.aif",
      "track.mid",
      "track.midi",
      "track.amr",
      "TRACK.WMA",
    ])("accepts %s", (path) => {
      expect(isUnsupportedAudioFilePath(path)).toBe(true);
    });

    it("is disjoint from the playable set in both directions", () => {
      // An extension in both sets would make the pane's branch order decide
      // between a working player and a "can't play" message.
      for (const path of ["track.mp3", "track.wav", "track.flac", "track.m4a", "track.aac"]) {
        expect(isUnsupportedAudioFilePath(path)).toBe(false);
      }
      for (const path of [
        "track.wma",
        "track.aiff",
        "track.aif",
        "track.mid",
        "track.midi",
        "track.amr",
      ]) {
        expect(isAudioFilePath(path)).toBe(false);
      }
    });

    it("does not overlap the unsupported video set", () => {
      // Both feed the same "can't play this format" branch, so an extension in
      // both would make the pane's copy depend on check order.
      for (const path of ["clip.mov", "clip.mkv", "clip.avi", "clip.wmv"]) {
        expect(isUnsupportedAudioFilePath(path)).toBe(false);
      }
    });
  });

  describe("isPdfFilePath", () => {
    it.each(["spec.pdf", "SPEC.PDF", "a/b/data.sheet.pdf", "/abs/path/report.Pdf"])(
      "accepts %s",
      (path) => {
        expect(isPdfFilePath(path)).toBe(true);
      }
    );

    it.each(["spec.pdf.txt", "spec", "notes.md", "photo.png", "clip.mp4"])("rejects %s", (path) => {
      expect(isPdfFilePath(path)).toBe(false);
    });

    it("is disjoint from every other preview classifier", () => {
      // A PDF must not also route to the image/video branches — the panes check
      // these in sequence, so an overlap would silently pick the wrong preview.
      expect(isImageFilePath("spec.pdf")).toBe(false);
      expect(isSvgFilePath("spec.pdf")).toBe(false);
      expect(isVideoFilePath("spec.pdf")).toBe(false);
      expect(isUnsupportedVideoFilePath("spec.pdf")).toBe(false);
      expect(isAudioFilePath("spec.pdf")).toBe(false);
      expect(isUnsupportedAudioFilePath("spec.pdf")).toBe(false);
    });
  });

  describe("buildDaintreeFileUrl", () => {
    it("encodes path and root as query params", () => {
      const url = buildDaintreeFileUrl("/a dir/clip.mp4", "/a dir");
      expect(url).toBe("daintree-file://load?path=%2Fa%20dir%2Fclip.mp4&root=%2Fa%20dir");
    });
  });

  describe("isFileContentsCopyCandidate", () => {
    it.each([
      "/repo/logo.png",
      "/repo/photo.JPEG",
      "/repo/icon.svg",
      "/repo/clip.mp4",
      "/repo/clip.mov",
      "/repo/track.mp3",
      "/repo/track.wma",
      "/repo/spec.pdf",
    ])("refuses %s", (filePath) => {
      expect(isFileContentsCopyCandidate(filePath)).toBe(false);
    });

    it.each([
      "/repo/index.ts",
      "/repo/README.md",
      "/repo/page.html",
      "/repo/Makefile",
      "/repo/.env",
    ])("offers %s", (filePath) => {
      expect(isFileContentsCopyCandidate(filePath)).toBe(true);
    });

    it("is optimistic for formats it doesn't recognise", () => {
      // The predicate runs before anything has read the file, so a positive is
      // only "nothing here rules it out". `files:read` is what actually rejects
      // a binary, and pinning that here stops a later change from quietly
      // promoting this to a completeness claim it can't make.
      expect(isFileContentsCopyCandidate("/repo/archive.zip")).toBe(true);
    });

    it("refuses every kind the two viewers classify as non-text", () => {
      // The gate must stay the exact complement of the preview classifiers: a
      // new media kind added there without being composed in here would offer
      // "copy contents" for a file the viewer never shows as text.
      const nonText = ["/a.png", "/a.svg", "/a.webm", "/a.mkv", "/a.flac", "/a.aiff", "/a.pdf"];
      for (const filePath of nonText) {
        const classified =
          isImageFilePath(filePath) ||
          isVideoFilePath(filePath) ||
          isUnsupportedVideoFilePath(filePath) ||
          isAudioFilePath(filePath) ||
          isUnsupportedAudioFilePath(filePath) ||
          isPdfFilePath(filePath);
        expect(classified).toBe(true);
        expect(isFileContentsCopyCandidate(filePath)).toBe(false);
      }
    });
  });

  describe("buildDaintreePdfUrl", () => {
    it("round-trips path and root through the query string", () => {
      const url = new URL(buildDaintreePdfUrl("/a dir/spec #1.pdf", "/a dir"));
      expect(url.protocol).toBe("daintree-pdf:");
      expect(url.searchParams.get("path")).toBe("/a dir/spec #1.pdf");
      expect(url.searchParams.get("root")).toBe("/a dir");
    });

    it("differs from the general file URL only by scheme", () => {
      // The PDF scheme is the only one allowed in frame-src, so routing a PDF
      // through daintree-file:// would make the iframe fail CSP. The rest of
      // the URL must stay identical so both resolve the same file.
      const pdf = new URL(buildDaintreePdfUrl("/repo/spec.pdf", "/repo"));
      const file = new URL(buildDaintreeFileUrl("/repo/spec.pdf", "/repo"));

      expect(pdf.protocol).not.toBe(file.protocol);
      expect(pdf.search).toBe(file.search);
    });
  });
});
