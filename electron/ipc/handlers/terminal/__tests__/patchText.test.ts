import { describe, expect, it, vi } from "vitest";
import {
  applyPatchToleratingTransportCrlf,
  parsePatchModifiedFiles,
  stripTransportCrlf,
} from "../patchText.js";

const LF_PATCH = [
  "diff --git a/src/app.ts b/src/app.ts",
  "index 0000000..1111111 100644",
  "--- a/src/app.ts",
  "+++ b/src/app.ts",
  "@@ -1,3 +1,3 @@",
  " line1",
  "-line2",
  "+LINE2",
  " line3",
  "",
].join("\n");

const toCrlf = (text: string) => text.replace(/\n/g, "\r\n");

// What `git diff` prints for a file committed with CRLF content: the CR rides
// on content lines only, never on git's own header lines.
const CRLF_CONTENT_PATCH = [
  "diff --git a/win.txt b/win.txt",
  "--- a/win.txt",
  "+++ b/win.txt",
  "@@ -1,2 +1,2 @@",
  " keep\r",
  "-old\r",
  "+new\r",
  "",
].join("\n");

describe("parsePatchModifiedFiles", () => {
  it("returns clean names from a CRLF patch", () => {
    expect(parsePatchModifiedFiles(toCrlf(LF_PATCH))).toEqual(["src/app.ts"]);
  });

  it("drops the tab git appends to a path containing a space", () => {
    const patch = "--- /dev/null\n+++ b/docs/with space.md\t\n@@ -0,0 +1 @@\n+x\n";
    expect(parsePatchModifiedFiles(patch)).toEqual(["docs/with space.md"]);
    expect(parsePatchModifiedFiles(toCrlf(patch))).toEqual(["docs/with space.md"]);
  });

  it("lists every file of a multi-file patch and skips deletions", () => {
    const patch = [
      "--- a/a.ts",
      "+++ b/a.ts",
      "@@ -1 +1 @@",
      "-a",
      "+b",
      "--- a/gone.ts",
      "+++ /dev/null",
      "@@ -1 +0,0 @@",
      "-x",
      "",
    ].join("\r\n");
    expect(parsePatchModifiedFiles(patch)).toEqual(["a.ts"]);
  });

  it("does not read an added '++ ' content line as a header", () => {
    const patch = "--- a/x.md\n+++ b/x.md\n@@ -1 +1 @@\n-a\n+++ not/a/header\n";
    expect(parsePatchModifiedFiles(patch)).toEqual(["x.md"]);
  });
});

describe("stripTransportCrlf", () => {
  it("returns null for an LF patch", () => {
    expect(stripTransportCrlf(LF_PATCH)).toBeNull();
  });

  it("returns null when only content lines carry a CR", () => {
    expect(stripTransportCrlf(CRLF_CONTENT_PATCH)).toBeNull();
  });

  it("restores an LF patch from one converted to CRLF in transit", () => {
    expect(stripTransportCrlf(toCrlf(LF_PATCH))).toBe(LF_PATCH);
  });

  it("removes only the transport CR from a content line that had its own", () => {
    expect(stripTransportCrlf(toCrlf(CRLF_CONTENT_PATCH))).toBe(CRLF_CONTENT_PATCH);
  });

  it("returns null for a patch mixing a transported section with an untouched one", () => {
    // Stripping here would also take the CRs off the CRLF file being added.
    expect(stripTransportCrlf(toCrlf(LF_PATCH) + CRLF_CONTENT_PATCH)).toBeNull();
  });

  it("keeps a file's own final CR before the no-newline marker", () => {
    const finalCr = [
      "diff --git a/win.txt b/win.txt",
      "--- a/win.txt",
      "+++ b/win.txt",
      "@@ -1 +1 @@",
      "-old",
      "+new\r",
      "\\ No newline at end of file",
      "",
    ].join("\n");
    expect(stripTransportCrlf(finalCr)).toBeNull();
  });

  it("strips a trailing CR on a final line with no newline", () => {
    const transported = toCrlf(LF_PATCH).replace(/\r\n$/, "\r");
    expect(stripTransportCrlf(transported)).toBe(LF_PATCH.replace(/\n$/, ""));
  });
});

describe("applyPatchToleratingTransportCrlf", () => {
  it("applies the patch as written when that succeeds", async () => {
    const apply = vi.fn(async () => {});
    await applyPatchToleratingTransportCrlf(toCrlf(LF_PATCH), apply);
    expect(apply).toHaveBeenCalledTimes(1);
    expect(apply).toHaveBeenCalledWith(toCrlf(LF_PATCH));
  });

  it("retries a transport-CRLF patch with LF line endings after a failure", async () => {
    const apply = vi.fn(async (content: string) => {
      if (content.includes("\r")) throw new Error("patch does not apply");
    });
    await applyPatchToleratingTransportCrlf(toCrlf(LF_PATCH), apply);
    expect(apply).toHaveBeenCalledTimes(2);
    expect(apply).toHaveBeenLastCalledWith(LF_PATCH);
  });

  it("does not retry a patch with no transport CRLF", async () => {
    const failure = new Error("patch does not apply");
    const apply = vi.fn(async () => {
      throw failure;
    });
    await expect(applyPatchToleratingTransportCrlf(CRLF_CONTENT_PATCH, apply)).rejects.toBe(
      failure
    );
    expect(apply).toHaveBeenCalledTimes(1);
  });

  it("reports the original error when the retry also fails", async () => {
    const original = new Error("first: patch does not apply");
    const apply = vi
      .fn<(content: string) => Promise<void>>()
      .mockRejectedValueOnce(original)
      .mockRejectedValueOnce(new Error("second"));
    await expect(applyPatchToleratingTransportCrlf(toCrlf(LF_PATCH), apply)).rejects.toBe(original);
    expect(apply).toHaveBeenCalledTimes(2);
  });
});
