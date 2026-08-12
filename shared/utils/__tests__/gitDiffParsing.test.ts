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

      expect(isBinaryDiffOutput(withoutNewline)).toBe(true);
      expect(isBinaryDiffOutput(withoutNewline)).toBe(isBinaryDiffOutput(withNewline));
    });

    it("is insensitive to CRLF line endings", () => {
      const lf = `${header("logo.png")}\nBinary files a/logo.png and b/logo.png differ\n`;

      expect(isBinaryDiffOutput(lf.replace(/\n/g, "\r\n"))).toBe(true);
      expect(isBinaryDiffOutput(lf.replace(/\n/g, "\r\n"))).toBe(isBinaryDiffOutput(lf));
    });

    it.each([
      ["U+2028 line separator", "\u2028"],
      ["U+2029 paragraph separator", "\u2029"],
    ])("classifies a marker whose path contains a %s", (_label, char) => {
      // Legal in a path, but ECMAScript line terminators: a `.`-based pattern
      // refuses to match them and would silently miss a real binary file.
      const path = `assets/ic${char}on.png`;

      expect(isBinaryDiffOutput(`Binary files /dev/null and b/${path} differ`)).toBe(true);
    });

    it("classifies a marker followed by a further diff record", () => {
      // A pathspec can select more than one file, so the marker is not always
      // the last record in the output.
      const diff = `${header("logo.png")}
Binary files a/logo.png and b/logo.png differ
${header("notes.md")}
@@ -1 +1 @@
-old
+new
`;

      expect(isBinaryDiffOutput(diff)).toBe(true);
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
@@ -1,2 +1,3 @@
 # Notes
+Git prints Binary files a/x and b/x differ when it skips a blob.
`;

      expect(isBinaryDiffOutput(diff)).toBe(false);
    });

    it("does not classify the marker regardless of which hunk prefix carries it", () => {
      const marker = "Binary files a/x and b/x differ";

      for (const prefix of ["+", "-", " ", "\\"]) {
        expect(isBinaryDiffOutput(`@@ -1 +1 @@\n${prefix}${marker}\n`)).toBe(false);
      }
    });

    it.each([
      ["a bare carriage return", "\r"],
      ["a U+2028 line separator", "\u2028"],
      ["a U+2029 paragraph separator", "\u2029"],
    ])("does not treat %s inside a hunk line as a record boundary", (_label, char) => {
      // Git frames patch records with \n alone. ECMAScript also counts these
      // three as line terminators, so a multiline-anchored pattern would let
      // marker-shaped content masquerade as metadata.
      const diff = `@@ -0,0 +1 @@\n+intro${char}Binary files a/x and b/x differ\n`;

      expect(isBinaryDiffOutput(diff)).toBe(false);
    });

    it("distinguishes a marker-shaped line only by its position after a newline", () => {
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
      ["a marker with an empty middle", "Binary files  differ"],
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
