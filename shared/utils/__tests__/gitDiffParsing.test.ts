import { describe, expect, it } from "vitest";
import { isBinaryDiffOutput } from "../gitDiffParsing.js";

const header = (path: string) => `diff --git a/${path} b/${path}\nindex 1a2b3c4..5d6e7f8 100644`;

describe("isBinaryDiffOutput", () => {
  describe("genuine binary markers", () => {
    it.each([
      ["modified", "Binary files a/logo.png and b/logo.png differ"],
      ["added", "Binary files /dev/null and b/logo.png differ"],
      ["deleted", "Binary files a/logo.png and /dev/null differ"],
    ])("classifies the %s form", (_form, marker) => {
      expect(isBinaryDiffOutput(`${header("logo.png")}\n${marker}\n`)).toBe(true);
    });

    it("classifies a marker that ends the output with no trailing newline", () => {
      const withNewline = `${header("logo.png")}\nBinary files a/logo.png and b/logo.png differ\n`;
      const withoutNewline = withNewline.trimEnd();

      expect(isBinaryDiffOutput(withoutNewline)).toBe(isBinaryDiffOutput(withNewline));
      expect(isBinaryDiffOutput(withoutNewline)).toBe(true);
    });

    it("is insensitive to CRLF line endings", () => {
      const lf = `${header("logo.png")}\nBinary files a/logo.png and b/logo.png differ\n`;

      expect(isBinaryDiffOutput(lf.replace(/\n/g, "\r\n"))).toBe(isBinaryDiffOutput(lf));
    });

    it("does not assume the a/ and b/ path prefixes", () => {
      // --no-prefix, custom --src-prefix/--dst-prefix, and diff.mnemonicPrefix
      // all re-render these tokens.
      const noPrefix = "Binary files logo.png and logo.png differ";
      const mnemonic = "Binary files i/logo.png and w/logo.png differ";

      expect(isBinaryDiffOutput(noPrefix)).toBe(true);
      expect(isBinaryDiffOutput(mnemonic)).toBe(true);
    });

    it("classifies a marker whose own filenames contain the word differ", () => {
      const path = "docs/how files differ.md";

      expect(isBinaryDiffOutput(`Binary files a/${path} and b/${path} differ`)).toBe(true);
    });

    it("classifies a quoted path emitted under core.quotePath", () => {
      expect(isBinaryDiffOutput('Binary files "a/caf\\303\\251.png" and /dev/null differ')).toBe(
        true
      );
    });
  });

  describe("marker-shaped text content", () => {
    it("does not classify an added line quoting the marker", () => {
      const diff = `${header("README.md")}
--- a/README.md
+++ b/README.md
@@ -1,3 +1,4 @@
 # Notes
+Git prints Binary files a/x and b/x differ when it skips a blob.
 Nothing else changed.
`;

      expect(isBinaryDiffOutput(diff)).toBe(false);
    });

    it("does not classify the marker regardless of which hunk prefix carries it", () => {
      const marker = "Binary files a/x and b/x differ";

      for (const prefix of ["+", "-", " ", "\\"]) {
        expect(isBinaryDiffOutput(`@@ -1 +1 @@\n${prefix}${marker}\n`)).toBe(false);
      }
    });

    it("distinguishes a marker-shaped line only by its column-zero position", () => {
      const marker = "Binary files a/x and b/x differ";

      expect(isBinaryDiffOutput(`@@ -1 +1 @@\n+${marker}`)).toBe(false);
      expect(isBinaryDiffOutput(`@@ -1 +1 @@\n${marker}`)).toBe(true);
    });

    it("does not classify a file whose name is itself the marker", () => {
      const path = "Binary files a/x and b/x differ";

      expect(isBinaryDiffOutput(`${header(path)}\n--- a/${path}\n+++ b/${path}\n`)).toBe(false);
    });
  });

  describe("non-markers", () => {
    it.each([
      ["empty output", ""],
      ["whitespace only", "\n\n"],
      ["the no-newline sentinel", "@@ -1 +1 @@\n-old\n\\ No newline at end of file\n"],
      ["a plain text diff", `${header("a.ts")}\n@@ -1 +1 @@\n-old\n+new\n`],
      ["trailing content after differ", "Binary files a/x and b/x differ later"],
      ["a marker with no paths", "Binary files  differ"],
      ["a lowercase marker", "binary files a/x and b/x differ"],
    ])("rejects %s", (_label, input) => {
      expect(isBinaryDiffOutput(input)).toBe(false);
    });

    it("leaves --binary payloads to the caller that opts into them", () => {
      // No call site passes --binary, so this form is deliberately out of scope.
      // Recognising it is a decision a future --binary caller must make.
      const literalPatch = "GIT binary patch\nliteral 1234\nzcmZ?wbhEHb\n";

      expect(isBinaryDiffOutput(literalPatch)).toBe(false);
    });
  });

  it("holds no match state across repeated calls", () => {
    const marker = "Binary files a/x and b/x differ";

    const results = [marker, marker, marker].map((d) => isBinaryDiffOutput(d));

    expect(results).toEqual([true, true, true]);
  });
});
