import { describe, expect, it } from "vitest";
import {
  ansiToPlainText,
  MAX_LINE_CHARS,
  MAX_LINE_RUNS,
  lineText,
  paletteColor,
  parseAnsi,
  AnsiParser,
  PLAIN_STYLE,
} from "../kitAnsi";

function styled(text: string) {
  return parseAnsi(text).lines.map((line) =>
    line.segments.map((segment) => ({ text: segment.text, style: segment.style }))
  );
}

describe("kitAnsi", () => {
  it("reads SGR colours as the theme's terminal tokens", () => {
    const [line] = styled("\x1b[31mred\x1b[0m plain");
    expect(line![0]!.text).toBe("red");
    expect(line![0]!.style.fg).toContain("--theme-terminal-red");
    expect(line![1]!.style).toBe(PLAIN_STYLE);
  });

  it("draws bold basic colours bright, as xterm does", () => {
    const [line] = styled("\x1b[1;32mok");
    expect(line![0]!.style.bold).toBe(true);
    expect(line![0]!.style.fg).toContain("--theme-terminal-bright-green");
  });

  it("reads 256-colour and truecolor, in semicolon and colon forms", () => {
    expect(styled("\x1b[38;5;208mx")[0]![0]!.style.fg).toBe(paletteColor(208));
    expect(styled("\x1b[38;2;10;20;30mx")[0]![0]!.style.fg).toBe("rgb(10, 20, 30)");
    expect(styled("\x1b[38:2::10:20:30mx")[0]![0]!.style.fg).toBe("rgb(10, 20, 30)");
    expect(styled("\x1b[48;5;1mx")[0]![0]!.style.bg).toContain("--theme-terminal-red");
  });

  it("keeps decorations and reverse video", () => {
    const style = styled("\x1b[2;3;4;7;9mx")[0]![0]!.style;
    expect(style).toMatchObject({
      dim: true,
      italic: true,
      underline: true,
      inverse: true,
      strike: true,
    });
    expect(styled("\x1b[7mx\x1b[27my")[0]![1]!.style).toBe(PLAIN_STYLE);
  });

  it("drops underline colour without misreading its arguments", () => {
    const style = styled("\x1b[4;58;2;255;0;0;31mx")[0]![0]!.style;
    expect(style).toMatchObject({ underline: true, dim: false, italic: false });
    expect(style.fg).toContain("terminal-red");
    expect(styled("\x1b[58;5;3;1mx")[0]![0]!.style).toMatchObject({ bold: true, italic: false });
    expect(styled("\x1b[4:3mx")[0]![0]!.style.underline).toBe(true);
    expect(styled("\x1b[4m\x1b[4:0mx")[0]![0]!.style).toBe(PLAIN_STYLE);
  });

  it("clears a decoration however many times it was set", () => {
    const [line] = styled("\x1b[1m\x1b[1mA\x1b[22mB");
    expect(line![1]!.text).toBe("B");
    expect(line![1]!.style).toBe(PLAIN_STYLE);
  });

  it("collapses carriage-return rewrites and erase-in-line", () => {
    expect(ansiToPlainText("progress 10%\rprogress 50%\rdone\x1b[K")).toBe("done");
    expect(ansiToPlainText("abcdef\rXY")).toBe("XYcdef");
    expect(ansiToPlainText("abc\r\x1b[2Kz")).toBe("z");
    expect(ansiToPlainText("one\r\ntwo")).toBe("one\ntwo");
  });

  it("rewrites earlier lines after a cursor up", () => {
    expect(ansiToPlainText("a 1\nb 1\n\x1b[2A\x1b[2Ka 2\n\x1b[2Kb 2\n")).toBe("a 2\nb 2");
  });

  it("links OSC 8 hyperlinks, with BEL or ST terminators", () => {
    const [line] = styled("see \x1b]8;;https://example.com\x07docs\x1b]8;;\x1b\\ now");
    expect(line!.map((segment) => [segment.text, segment.style.link])).toEqual([
      ["see ", null],
      ["docs", "https://example.com"],
      [" now", null],
    ]);
  });

  it("holds an escape split across writes until it completes", () => {
    const parser = new AnsiParser();
    parser.write("a\x1b[3");
    parser.write("1mb");
    expect(lineText(parser.lines[0]!)).toBe("ab");
    expect(parser.lines[0]!.segments[1]!.style.fg).toContain("terminal-red");
  });

  it("ignores other escapes and control bytes", () => {
    expect(ansiToPlainText("\x1b[?25lhi\x1b]0;title\x07\x07\x1b(B!")).toBe("hi!");
  });

  it("drops the oldest lines past its cap, not counting the cursor's empty line", () => {
    const parser = parseAnsi("1\n2\n3\n4", 2);
    expect(parser.lines.map(lineText)).toEqual(["3", "4"]);
    expect(parser.dropped).toBe(2);
    expect(parseAnsi("a\n", 1).lines.map(lineText)).toEqual(["a"]);
    expect(parseAnsi("a\nb\n", 2).lines.map(lineText)).toEqual(["a", "b"]);
  });

  it("trims a long log in batches and keeps line numbering", () => {
    const parser = new AnsiParser(100);
    for (let chunk = 0; chunk < 50; chunk++) {
      parser.write(
        Array.from({ length: 1000 }, (_, i) => `line ${chunk * 1000 + i}`).join("\n") + "\n"
      );
    }
    const { lines, dropped } = parser.snapshot();
    expect(lines).toHaveLength(100);
    expect(dropped).toBe(49_900);
    expect(lineText(lines[0]!)).toBe("line 49900");
  });

  it("ignores writes once the cursor moves up past the kept lines", () => {
    expect(parseAnsi("a\nb\nc\x1b[2A\rX", 2).lines.map(lineText)).toEqual(["b", "c"]);
    expect(parseAnsi("a\nb\nc\x1b[2A\rX").lines.map(lineText)).toEqual(["X", "b", "c"]);
  });

  it("bounds cursor moves, line length and runs per line", () => {
    expect(() => parseAnsi("\x1b[999999999CX\x1b[99999CY")).not.toThrow();
    expect(parseAnsi("\x1b[99999CX").lines[0]!.length).toBe(0);
    expect(parseAnsi("\x1b[16000CX").lines[0]!.length).toBe(16_001);
    expect(parseAnsi("\x1b[-5CX\x1b[1.5CY").lines.map(lineText)).toEqual(["XY"]);
    expect(parseAnsi("x".repeat(MAX_LINE_CHARS + 50)).lines[0]!.length).toBe(MAX_LINE_CHARS);
    const striped = parseAnsi("\x1b[31mx\x1b[32my".repeat(5000)).lines[0]!;
    expect(striped.segments.length).toBeLessThanOrEqual(MAX_LINE_RUNS);
    expect(striped.length).toBe(10_000);
  });

  it("drops an oversized escape whole, and the text after it survives", () => {
    expect(ansiToPlainText(`\x1b[${"1;".repeat(1000)}mok`)).toBe("ok");
    expect(ansiToPlainText(`\x1b]0;${"x".repeat(10_000)}\x07shown`)).toBe("shown");
    const split = new AnsiParser();
    split.write(`\x1b]0;${"x".repeat(5000)}`);
    split.write("TAIL\x07visible");
    expect(split.lines.map(lineText)).toEqual(["visible"]);
    const longLink = parseAnsi(`\x1b]8;;https://x.dev/${"a".repeat(3000)}\x07t\x1b]8;;\x07`);
    expect(longLink.lines[0]!.segments[0]!.style.link).toBeNull();
  });

  it("recovers from malformed escapes without eating the text after them", () => {
    expect(ansiToPlainText("a\x1b[123\nb")).toBe("a\nb");
    expect(ansiToPlainText("a\x1b]0;title\nb")).toBe("a\nb");
    expect(ansiToPlainText("end\x1b")).toBe("end");
    expect(ansiToPlainText("x\x00y\x07z")).toBe("xyz");
  });

  it("reads C1 controls and consumes control strings unseen", () => {
    expect(styled("\u009b31mX")[0]![0]!.style.fg).toContain("terminal-red");
    expect(ansiToPlainText("\x1bPsecret\x1b\\shown")).toBe("shown");
    expect(ansiToPlainText("\x1b_apc\u009cshown")).toBe("shown");
    expect(ansiToPlainText("\u009d0;t\u009cok")).toBe("ok");
  });

  it("never leaves half a surrogate pair behind a rewrite", () => {
    expect(ansiToPlainText("😀\bX")).toBe(" X");
    expect(ansiToPlainText("a😀b\rab")).toBe("ab b");
  });

  it("publishes snapshots that later writes never change", () => {
    const parser = new AnsiParser();
    parser.write("one\ntw");
    const before = parser.snapshot();
    parser.write("o!");
    expect(lineText(before.lines[1]!)).toBe("tw");
    expect(lineText(parser.snapshot().lines[1]!)).toBe("two!");
    expect(parser.snapshot().lines[0]).toBe(before.lines[0]);
  });
});
