import { describe, it, expect } from "vitest";
import { parseEnvPaste } from "../parseEnvPaste";

describe("parseEnvPaste", () => {
  it("returns empty result for empty input", () => {
    const result = parseEnvPaste("");
    expect(result.pairs).toEqual([]);
    expect(result.errors).toEqual([]);
  });

  it("parses a simple KEY=VALUE", () => {
    const { pairs, errors } = parseEnvPaste("FOO=bar");
    expect(errors).toEqual([]);
    expect(pairs).toEqual([{ key: "FOO", value: "bar" }]);
  });

  it("parses multiple lines", () => {
    const { pairs, errors } = parseEnvPaste("A=1\nB=2\nC=3");
    expect(errors).toEqual([]);
    expect(pairs).toEqual([
      { key: "A", value: "1" },
      { key: "B", value: "2" },
      { key: "C", value: "3" },
    ]);
  });

  it("normalizes CRLF to LF", () => {
    const { pairs, errors } = parseEnvPaste("FOO=bar\r\nBAZ=qux\r\n");
    expect(errors).toEqual([]);
    expect(pairs).toEqual([
      { key: "FOO", value: "bar" },
      { key: "BAZ", value: "qux" },
    ]);
  });

  it("strips UTF-8 BOM from start of input", () => {
    const { pairs, errors } = parseEnvPaste("\uFEFFFOO=bar");
    expect(errors).toEqual([]);
    expect(pairs).toEqual([{ key: "FOO", value: "bar" }]);
  });

  it("skips blank and whitespace-only lines", () => {
    const { pairs, errors } = parseEnvPaste("\nFOO=bar\n   \n\nBAZ=qux\n");
    expect(errors).toEqual([]);
    expect(pairs).toEqual([
      { key: "FOO", value: "bar" },
      { key: "BAZ", value: "qux" },
    ]);
  });

  it("skips # comment lines", () => {
    const { pairs, errors } = parseEnvPaste("# comment\nFOO=bar\n  # indented comment\nBAZ=qux");
    expect(errors).toEqual([]);
    expect(pairs).toEqual([
      { key: "FOO", value: "bar" },
      { key: "BAZ", value: "qux" },
    ]);
  });

  it("accepts export prefix", () => {
    const { pairs, errors } = parseEnvPaste("export FOO=bar\nexport BAZ=qux");
    expect(errors).toEqual([]);
    expect(pairs).toEqual([
      { key: "FOO", value: "bar" },
      { key: "BAZ", value: "qux" },
    ]);
  });

  it("splits on the first '=' only", () => {
    const { pairs, errors } = parseEnvPaste("URL=https://example.com/?q=1&r=2");
    expect(errors).toEqual([]);
    expect(pairs).toEqual([{ key: "URL", value: "https://example.com/?q=1&r=2" }]);
  });

  it("strips double quotes and processes escape sequences", () => {
    const { pairs, errors } = parseEnvPaste(
      'FOO="hello\\nworld"\nBAR="tab\\there"\nBAZ="back\\\\slash"'
    );
    expect(errors).toEqual([]);
    expect(pairs).toEqual([
      { key: "FOO", value: "hello\nworld" },
      { key: "BAR", value: "tab\there" },
      { key: "BAZ", value: "back\\slash" },
    ]);
  });

  it("preserves escaped double quote inside double-quoted values", () => {
    const { pairs, errors } = parseEnvPaste('MSG="she said \\"hi\\""');
    expect(errors).toEqual([]);
    expect(pairs).toEqual([{ key: "MSG", value: 'she said "hi"' }]);
  });

  it("treats single-quoted values as literal (no escape processing)", () => {
    const { pairs, errors } = parseEnvPaste("FOO='hello\\nworld'");
    expect(errors).toEqual([]);
    expect(pairs).toEqual([{ key: "FOO", value: "hello\\nworld" }]);
  });

  it("strips inline comment when # is preceded by whitespace", () => {
    const { pairs, errors } = parseEnvPaste("FOO=bar # trailing comment");
    expect(errors).toEqual([]);
    expect(pairs).toEqual([{ key: "FOO", value: "bar" }]);
  });

  it("does NOT strip # when not preceded by whitespace", () => {
    const { pairs, errors } = parseEnvPaste("FOO=bar#notcomment");
    expect(errors).toEqual([]);
    expect(pairs).toEqual([{ key: "FOO", value: "bar#notcomment" }]);
  });

  it("does not strip inline comment from quoted values", () => {
    const { pairs, errors } = parseEnvPaste('FOO="bar # not a comment"');
    expect(errors).toEqual([]);
    expect(pairs).toEqual([{ key: "FOO", value: "bar # not a comment" }]);
  });

  it("allows empty value", () => {
    const { pairs, errors } = parseEnvPaste("FOO=");
    expect(errors).toEqual([]);
    expect(pairs).toEqual([{ key: "FOO", value: "" }]);
  });

  it("surfaces lines with no '=' as parse errors", () => {
    const { pairs, errors } = parseEnvPaste("FOO=bar\nNOT_A_PAIR\nBAZ=qux");
    expect(pairs).toEqual([
      { key: "FOO", value: "bar" },
      { key: "BAZ", value: "qux" },
    ]);
    expect(errors).toHaveLength(1);
    expect(errors[0]!.line).toBe(2);
    expect(errors[0]!.raw).toBe("NOT_A_PAIR");
  });

  it("surfaces invalid keys as parse errors", () => {
    const { pairs, errors } = parseEnvPaste("1INVALID=bad\nFOO-BAR=bad\nGOOD=ok");
    expect(pairs).toEqual([{ key: "GOOD", value: "ok" }]);
    expect(errors).toHaveLength(2);
    expect(errors.map((e) => e.line)).toEqual([1, 2]);
  });

  it("surfaces empty key after export prefix as parse error", () => {
    const { pairs, errors } = parseEnvPaste("export =value");
    expect(pairs).toEqual([]);
    expect(errors).toHaveLength(1);
    expect(errors[0]!.line).toBe(1);
  });

  it("surfaces unterminated double quote as parse error", () => {
    const { pairs, errors } = parseEnvPaste('FOO="unterminated');
    expect(pairs).toEqual([]);
    expect(errors).toHaveLength(1);
    expect(errors[0]!.reason).toMatch(/unterminated/i);
  });

  it("surfaces unterminated single quote as parse error", () => {
    const { pairs, errors } = parseEnvPaste("FOO='unterminated");
    expect(pairs).toEqual([]);
    expect(errors).toHaveLength(1);
  });

  it("uses absolute line numbers (not skipping blanks/comments)", () => {
    const input = ["# header", "", "FOO=bar", "", "NOT_A_PAIR", "BAZ=qux"].join("\n");
    const { pairs, errors } = parseEnvPaste(input);
    expect(pairs).toEqual([
      { key: "FOO", value: "bar" },
      { key: "BAZ", value: "qux" },
    ]);
    expect(errors).toHaveLength(1);
    expect(errors[0]!.line).toBe(5);
  });

  it("keeps duplicate keys in pairs list (UI resolves the merge strategy)", () => {
    const { pairs, errors } = parseEnvPaste("FOO=one\nFOO=two");
    expect(errors).toEqual([]);
    expect(pairs).toEqual([
      { key: "FOO", value: "one" },
      { key: "FOO", value: "two" },
    ]);
  });

  it("handles whitespace around key and value", () => {
    const { pairs, errors } = parseEnvPaste("  FOO = bar  ");
    expect(errors).toEqual([]);
    expect(pairs).toEqual([{ key: "FOO", value: "bar" }]);
  });

  it("returns zero pairs for comment-only input", () => {
    const { pairs, errors } = parseEnvPaste("# just a comment\n# and another");
    expect(pairs).toEqual([]);
    expect(errors).toEqual([]);
  });

  it("preserves unknown escape sequences (backslash stays)", () => {
    const { pairs, errors } = parseEnvPaste('RAW="keep \\q as-is"\nP="C:\\foo\\bar"');
    expect(errors).toEqual([]);
    expect(pairs).toEqual([
      { key: "RAW", value: "keep \\q as-is" },
      { key: "P", value: "C:\\foo\\bar" },
    ]);
  });

  it("allows trailing comment after a double-quoted value", () => {
    const { pairs, errors } = parseEnvPaste('FOO="bar" # from staging');
    expect(errors).toEqual([]);
    expect(pairs).toEqual([{ key: "FOO", value: "bar" }]);
  });

  it("allows trailing comment after a single-quoted value", () => {
    const { pairs, errors } = parseEnvPaste("FOO='bar' # note");
    expect(errors).toEqual([]);
    expect(pairs).toEqual([{ key: "FOO", value: "bar" }]);
  });

  it("rejects unquoted text after a closing quote", () => {
    const { pairs, errors } = parseEnvPaste('FOO="bar" trailing');
    expect(pairs).toEqual([]);
    expect(errors).toHaveLength(1);
    expect(errors[0]!.reason).toMatch(/after closing quote/i);
  });

  it("accepts lowercase and mixed-case keys", () => {
    const { pairs, errors } = parseEnvPaste("node_env=production\nMixedCase=ok");
    expect(errors).toEqual([]);
    expect(pairs).toEqual([
      { key: "node_env", value: "production" },
      { key: "MixedCase", value: "ok" },
    ]);
  });
});
