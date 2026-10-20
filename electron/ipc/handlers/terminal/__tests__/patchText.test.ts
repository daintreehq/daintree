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

  it("does not read an added '++ b/' content line as a header", () => {
    const patch = [
      "diff --git a/real.md b/real.md",
      "index 1111111..2222222 100644",
      "--- a/real.md",
      "+++ b/real.md",
      "@@ -1 +1 @@",
      "-original",
      "+++ b/fake.md",
      "",
    ].join("\n");
    expect(parsePatchModifiedFiles(patch)).toEqual(["real.md"]);
    expect(parsePatchModifiedFiles(toCrlf(patch))).toEqual(["real.md"]);
  });

  it("does not read a removed '-- a/' line and added '++ b/' line pair as a header", () => {
    const patch = [
      "--- a/real.md",
      "+++ b/real.md",
      "@@ -1,3 +1,3 @@",
      " keep",
      "--- a/other.md",
      "+++ b/fake.md",
      " keep",
      "--- a/next.md",
      "+++ b/next.md",
      "@@ -1 +1 @@",
      "-a",
      "+b",
      "",
    ].join("\n");
    expect(parsePatchModifiedFiles(patch)).toEqual(["real.md", "next.md"]);
  });

  it("counts lines with omitted counts, empty context lines and no-newline markers", () => {
    const patch = [
      "--- a/a.md",
      "+++ b/a.md",
      "@@ -1,3 +1,3 @@",
      " one",
      "",
      "-two",
      "\\ No newline at end of file",
      "+++ b/fake.md",
      "\\ No newline at end of file",
      "--- a/b.md",
      "+++ b/b.md",
      "@@ -1 +1 @@",
      "-x",
      "+y",
      "",
    ].join("\n");
    expect(parsePatchModifiedFiles(patch)).toEqual(["a.md", "b.md"]);
  });

  it("decodes git's C-quoted paths", () => {
    const patch = [
      'diff --git "a/\\346\\227\\245\\346\\234\\254\\350\\252\\236.txt" "b/\\346\\227\\245\\346\\234\\254\\350\\252\\236.txt"',
      "index 1111111..2222222 100644",
      '--- "a/\\346\\227\\245\\346\\234\\254\\350\\252\\236.txt"',
      '+++ "b/\\346\\227\\245\\346\\234\\254\\350\\252\\236.txt"',
      "@@ -1 +1 @@",
      "-a",
      "+b",
      'diff --git "a/tab\\there" "b/tab\\there"',
      '--- "a/tab\\there"',
      '+++ "b/tab\\there"',
      "@@ -1 +1 @@",
      "-a",
      "+b",
      'diff --git "a/say \\"hi\\"\\\\caf\\303\\251.md" "b/say \\"hi\\"\\\\caf\\303\\251.md"',
      '--- "a/say \\"hi\\"\\\\caf\\303\\251.md"',
      '+++ "b/say \\"hi\\"\\\\caf\\303\\251.md"',
      "@@ -1 +1 @@",
      "-a",
      "+b",
      "",
    ].join("\n");
    expect(parsePatchModifiedFiles(patch)).toEqual([
      "日本語.txt",
      "tab\there",
      'say "hi"\\café.md',
    ]);
    expect(parsePatchModifiedFiles(toCrlf(patch))).toEqual([
      "日本語.txt",
      "tab\there",
      'say "hi"\\café.md',
    ]);
  });

  it("drops the tab git appends after a quoted path containing a space", () => {
    const patch =
      '--- "a/\\346\\227\\245 \\350\\252\\236.txt"\t\n+++ "b/\\346\\227\\245 \\350\\252\\236.txt"\t\n@@ -1 +1 @@\n-a\n+b\n';
    expect(parsePatchModifiedFiles(patch)).toEqual(["日 語.txt"]);
    expect(parsePatchModifiedFiles(toCrlf(patch))).toEqual(["日 語.txt"]);
  });

  it("lists new files and rename destinations", () => {
    const patch = [
      "diff --git a/new.md b/new.md",
      "new file mode 100644",
      "--- /dev/null",
      "+++ b/new.md",
      "@@ -0,0 +1,2 @@",
      "+--- a/x",
      "+++ b/y",
      "diff --git a/old.md b/moved.md",
      "similarity index 80%",
      "rename from old.md",
      "rename to moved.md",
      "--- a/old.md",
      "+++ b/moved.md",
      "@@ -1 +1 @@",
      "-a",
      "+b",
      "",
    ].join("\n");
    expect(parsePatchModifiedFiles(patch)).toEqual(["new.md", "moved.md"]);
  });

  it("ignores a '+++' header with no '---' header before it", () => {
    expect(parsePatchModifiedFiles("+++ b/orphan.md\n@@ -1 +1 @@\n-a\n+b\n")).toEqual([]);
  });

  it("skips a quoted path whose bytes are not UTF-8", () => {
    const patch = '--- "a/\\377.md"\n+++ "b/\\377.md"\n@@ -1 +1 @@\n-a\n+b\n';
    expect(parsePatchModifiedFiles(patch)).toEqual([]);
  });

  it("skips a quoted header it cannot decode rather than inventing a path", () => {
    const patch =
      '--- "a/x\\q"\n+++ "b/x\\q"\n@@ -1 +1 @@\n-a\n+b\n--- a/ok.md\n+++ b/ok.md\n@@ -1 +1 @@\n-a\n+b\n';
    expect(parsePatchModifiedFiles(patch)).toEqual(["ok.md"]);
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
