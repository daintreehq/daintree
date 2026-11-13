import { describe, expect, it } from "vitest";
import { defaultFileViewMode, fileOpenTarget } from "../fileViewPolicy";

describe("fileOpenTarget", () => {
  it.each([
    ["/repo/dist/report.html", "browser"],
    ["/repo/dist/page.htm", "browser"],
    ["/repo/assets/logo.png", "default-app"],
    ["/repo/assets/photo.JPG", "default-app"],
    ["/repo/media/demo.mp4", "default-app"],
    ["/repo/media/demo.mov", "default-app"],
    ["/repo/media/theme.mp3", "default-app"],
    ["/repo/media/theme.wma", "default-app"],
    ["/repo/docs/manual.pdf", "default-app"],
    // SVG is markup a person edits, and the OS default for it may be a browser
    // or an illustration app; the editor is the safe, useful answer.
    ["/repo/assets/icon.svg", "editor"],
    ["/repo/src/index.ts", "editor"],
    ["/repo/docs/spec.md", "editor"],
    // Never the OS default for an unknown or binary type: that handler may run it.
    ["/repo/bin/tool.exe", "editor"],
    ["/repo/build/blob.bin", "editor"],
  ])("aims %s at %s", (filePath, target) => {
    expect(fileOpenTarget(filePath)).toBe(target);
  });
});

describe("defaultFileViewMode", () => {
  it.each([
    ["/repo/docs/spec.md", "rendered"],
    ["/repo/docs/notes.markdown", "rendered"],
    // HTML in a repo is code opened to read (#12205).
    ["/repo/dist/report.html", "source"],
    ["/repo/src/index.ts", "source"],
    ["/repo/assets/logo.png", "source"],
  ])("opens %s in %s", (filePath, mode) => {
    expect(defaultFileViewMode(filePath)).toBe(mode);
  });
});
