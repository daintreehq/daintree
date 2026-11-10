import { beforeEach, describe, expect, it, vi } from "vitest";
import { stripAnsi } from "../AgentPatternDetector.js";
import { getTrailingNonBlankLines } from "../trailingOutputLines.js";

vi.mock("../AgentPatternDetector.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../AgentPatternDetector.js")>();
  return { ...actual, stripAnsi: vi.fn(actual.stripAnsi) };
});

const strip = vi.mocked(stripAnsi);

// What the line scan computed before it was windowed: strip the whole chunk,
// split every line, keep the last `count` non-blank ones.
function wholeChunkTailLines(text: string, count: number): string[] {
  return strip(text)
    .split(/\r\n|\r|\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line.trim().length > 0)
    .slice(-count);
}

function longestStripInput(): number {
  return Math.max(0, ...strip.mock.calls.map(([text]) => text.length));
}

function totalStripInput(): number {
  return strip.mock.calls.reduce((sum, [text]) => sum + text.length, 0);
}

function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Ordinary agent output: text, prompt shapes, CSI and terminated OSC.
const COMMON_FRAGMENTS = [
  "a",
  "output",
  " ",
  "   ",
  "\t",
  "\u00a0",
  "\u3000",
  "$",
  "#",
  "%",
  ">",
  "user@host:~/repo$ ",
  "PS C:\\repo> ",
  "C:\\repo>",
  "➜  repo git:(main)",
  "❯ ",
  "›",
  "─────",
  "⠁",
  "\x1b[0m",
  "\x1b[01;32m",
  "\x1b[2K",
  "\x1b[1A",
  "\x1b[12;33H",
  "\x1b[?25l",
  "\x1b[>4;1m",
  "\x1b[2 q",
  "\x1b]0;title\x07",
  "\x1b]8;;file:///x\x1b\\",
  "\x1b(B",
  "\x1b=",
  "\x1b>",
  "\x1b7",
  "\x1b8",
  "\x1bM",
];

// Malformed or line-spanning sequences that stress the window boundary.
const ODD_FRAGMENTS = [
  "\x1b[",
  "\x1b[3",
  "\x1b]",
  "\x1b]0;multi\nline",
  "\x1b]0;multi\r\nline",
  "\x07",
  "\x1b\\",
  "\x1b",
  "\x1b\x1b",
  "\x1b\x1b[0m]0;",
  "]",
  "[",
  "\\",
  "\x1bD",
  "\u2028",
  "\u2029",
];

const LINE_BREAKS = ["\r", "\n", "\r\n", "\r\n", "\r\n", "\n\n"];

const ALL_FRAGMENTS = [...COMMON_FRAGMENTS, ...ODD_FRAGMENTS, ...LINE_BREAKS];

describe("getTrailingNonBlankLines", () => {
  beforeEach(() => {
    strip.mockClear();
  });

  it("matches the whole-chunk strip on random mixes of text, line breaks and escapes", () => {
    const random = mulberry32(16425);
    const iterations = 20_000;
    let windowed = 0;
    for (let iteration = 0; iteration < iterations; iteration++) {
      const pick = (pool: readonly string[]) => pool[Math.floor(random() * pool.length)];
      let text = "";
      if (iteration % 2 === 0) {
        // Uniform mix: every fragment, line breaks included, equally likely.
        const length = 1 + Math.floor(random() * (iteration % 10 === 0 ? 400 : 80));
        for (let i = 0; i < length; i++) text += pick(ALL_FRAGMENTS);
      } else {
        // Line-shaped output with the odd malformed sequence, as a TUI sends.
        const lines = 1 + Math.floor(random() * 60);
        for (let line = 0; line < lines; line++) {
          const fragments = Math.floor(random() * 6);
          for (let i = 0; i < fragments; i++) {
            text += random() < 0.04 ? pick(ODD_FRAGMENTS) : pick(COMMON_FRAGMENTS);
          }
          if (line < lines - 1 || random() < 0.3) text += pick(LINE_BREAKS);
        }
      }
      const expected = wholeChunkTailLines(text, 4);
      strip.mockClear();
      const actual = getTrailingNonBlankLines(text, 4);
      if (longestStripInput() < text.length) windowed++;
      const input = JSON.stringify(text);
      if (JSON.stringify(actual) !== JSON.stringify(expected)) {
        expect({ iteration, input, count: 4, actual }).toEqual({
          iteration,
          input,
          count: 4,
          actual: expected,
        });
      }
      const expectedLast = wholeChunkTailLines(text, 1);
      const actualLast = getTrailingNonBlankLines(text, 1);
      if (JSON.stringify(actualLast) !== JSON.stringify(expectedLast)) {
        expect({ iteration, input, count: 1, actual: actualLast }).toEqual({
          iteration,
          input,
          count: 1,
          actual: expectedLast,
        });
      }
    }
    // Enough inputs must take the windowed path, or this only proves the
    // whole-text fallback.
    expect(windowed).toBeGreaterThan(iterations / 3);
  });

  it("strips only the trailing lines of a large repaint", () => {
    let chunk = "";
    for (let i = 0; i < 400; i++) {
      chunk += `\x1b[2K\x1b[38;5;245m│ agent output line ${i} with some width\x1b[0m\r\n`;
    }
    chunk +=
      "\x1b]0;user@host: ~/repo\x07\x1b[01;32muser@host\x1b[00m:\x1b[01;34m~/repo\x1b[00m$ \r\n";

    expect(getTrailingNonBlankLines(chunk, 4)).toEqual([
      "│ agent output line 397 with some width",
      "│ agent output line 398 with some width",
      "│ agent output line 399 with some width",
      "user@host:~/repo$",
    ]);
    // One window is enough only when CRLF counts as a single line break.
    expect(strip).toHaveBeenCalledTimes(1);
    expect(longestStripInput()).toBeLessThan(chunk.length / 20);
  });

  it("widens past trailing blank lines to reach the lines above them", () => {
    let chunk = "";
    for (let i = 0; i < 200; i++) chunk += `line ${i}\r\n`;
    chunk += "user@host:~/repo$ \r\n";
    for (let i = 0; i < 40; i++) chunk += "\x1b[2K   \r\n";

    expect(getTrailingNonBlankLines(chunk, 4)).toEqual([
      "line 197",
      "line 198",
      "line 199",
      "user@host:~/repo$",
    ]);
    expect(longestStripInput()).toBeLessThan(chunk.length / 2);
  });

  it("bounds the stripping a long blank tail costs across widenings", () => {
    let chunk = "";
    for (let i = 0; i < 20; i++) chunk += `line ${i}\r\n`;
    chunk += "user@host:~/repo$ \r\n";
    for (let i = 0; i < 1_000; i++) chunk += "\x1b[2K\r\n";
    chunk += `\x1b[2K${" ".repeat(60_000)}\r\n`;
    for (let i = 0; i < 4; i++) chunk += "\x1b[2K\r\n";

    expect(getTrailingNonBlankLines(chunk, 4)).toEqual([
      "line 17",
      "line 18",
      "line 19",
      "user@host:~/repo$",
    ]);
    expect(totalStripInput()).toBeLessThanOrEqual(2 * chunk.length);
  });

  it("finds a prompt split by an OSC whose payload spans the window's first line break", () => {
    let chunk = "";
    for (let i = 0; i < 200; i++) chunk += `line ${i}\r\n`;
    // Every line break in the tail sits inside the title payload, so a window
    // cut at one of them would start mid-OSC and surface payload as text.
    chunk += "user@host:~/repo\x1b]0;a\r\nb\r\nc\r\nd\r\ne\r\nf\r\ng\r\nh\r\ni\x07$ ";

    expect(getTrailingNonBlankLines(chunk, 4)).toEqual(wholeChunkTailLines(chunk, 4));
    expect(getTrailingNonBlankLines(chunk, 4).at(-1)).toBe("user@host:~/repo$");
  });

  it("treats a CSI inside an OSC payload as part of the OSC across the window start", () => {
    let chunk = "";
    for (let i = 0; i < 50; i++) chunk += `line ${i}\n`;
    chunk += "\x1b]0;t\x1b[0m\n1\n2\n3\n4\n5\n6\n7\n8\n9\x07user@host:~$ ";

    expect(getTrailingNonBlankLines(chunk, 4)).toEqual(wholeChunkTailLines(chunk, 4));
  });

  it("treats an ESC that a removed CSI joins to `]` as an OSC opener across the window start", () => {
    let chunk = "";
    for (let i = 0; i < 50; i++) chunk += `line ${i}\n`;
    chunk += "\x1b\x1b[0m]0;t\n1\n2\n3\n4\n5\n6\n7\n8\n9\x07user@host:~$ ";

    expect(getTrailingNonBlankLines(chunk, 4)).toEqual(wholeChunkTailLines(chunk, 4));
  });

  it("treats an ESC that a removed CSI joins to `\\` as an OSC terminator in the window", () => {
    // The window holds no BEL and no raw ST, but CSI removal turns
    // `ESC ESC[0m \` into one, closing the OSC opened before the window.
    const chunk = "\x1b]x\n1\n2\x1b\x1b[0m\\$";

    expect(getTrailingNonBlankLines(chunk, 1)).toEqual(["$"]);
    expect(getTrailingNonBlankLines(chunk, 4)).toEqual(wholeChunkTailLines(chunk, 4));
  });

  it("windows past an OSC opener that nothing in the window could close", () => {
    // Without a BEL or ST after it the opener matches no OSC, so its payload
    // is visible text and the window strips as the whole would.
    let chunk = "\x1b]0;never closed\r\n";
    for (let i = 0; i < 200; i++) chunk += `line ${i}\r\n`;
    chunk += "user@host:~/repo$ ";

    expect(getTrailingNonBlankLines(chunk, 4)).toEqual(wholeChunkTailLines(chunk, 4));
    strip.mockClear();
    getTrailingNonBlankLines(chunk, 4);
    expect(longestStripInput()).toBeLessThan(chunk.length / 10);
  });

  it("skips stripping text it would strip whole when the marker is absent", () => {
    const marker = /[#$%>]/;
    const repaint =
      "\x1b[12;33H\x1b[38;2;105;105;105m⠁\x1b[12;35H⢀ Working (12s • esc to interrupt)";

    expect(getTrailingNonBlankLines(repaint, 4, marker)).toEqual([]);
    expect(strip).not.toHaveBeenCalled();
    expect(getTrailingNonBlankLines(`${repaint}\x1b[13;1Huser@host:~$ `, 4, marker)).toEqual(
      wholeChunkTailLines(`${repaint}\x1b[13;1Huser@host:~$ `, 4)
    );
  });

  it("returns every non-blank line when there are fewer than asked for", () => {
    expect(getTrailingNonBlankLines("", 4)).toEqual([]);
    expect(getTrailingNonBlankLines("\r\n\r\n", 4)).toEqual([]);
    expect(getTrailingNonBlankLines("\x1b[2Kuser@host:~$ ", 4)).toEqual(["user@host:~$"]);
    expect(getTrailingNonBlankLines("a\r\n\r\nb\rc", 4)).toEqual(["a", "b", "c"]);
  });
});
