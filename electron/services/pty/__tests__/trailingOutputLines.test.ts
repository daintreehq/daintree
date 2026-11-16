import { beforeEach, describe, expect, it, vi } from "vitest";
import { stripAnsi } from "../AgentPatternDetector.js";
import { getTrailingNonBlankLines, trailingLinesStart } from "../trailingOutputLines.js";
import {
  CMD_PROMPT_PATTERN,
  DECORATED_SHELL_PROMPT_PATTERN_NO_AGENT_GLYPHS,
  MAC_BASH_PROMPT_PATTERN,
  POSIX_USER_HOST_PROMPT_PATTERN,
  POWERSHELL_PROMPT_PATTERN,
  SHELL_ONLY_SINGLE_CHAR_PROMPT_PATTERN,
} from "../../../../shared/utils/shellPrompt.js";

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

// The committed-agent prompt shapes IdentityWatcher reads, and the edges it
// hands getTrailingNonBlankLines for them.
const PROMPT_SHAPES = [
  SHELL_ONLY_SINGLE_CHAR_PROMPT_PATTERN,
  POSIX_USER_HOST_PROMPT_PATTERN,
  MAC_BASH_PROMPT_PATTERN,
  POWERSHELL_PROMPT_PATTERN,
  CMD_PROMPT_PATTERN,
  DECORATED_SHELL_PROMPT_PATTERN_NO_AGENT_GLYPHS,
];
const isPromptLine = (line: string) => PROMPT_SHAPES.some((pattern) => pattern.test(line));
const promptEdges = (head: string, tail: string) =>
  /[#$%>](?:\^C)*\s*$/.test(tail) || /^\s*[➜➤➟➔]/.test(head);

// A cursor-addressed frame: cells placed by CUP with SGR around them, marker
// characters in the text, and no line break to window on.
function cursorAddressedFrame(cells: number, last = ""): string {
  let frame = "\x1b[?2026h";
  for (let cell = 0; cell < cells; cell++) {
    frame += `\x1b[${(cell % 40) + 1};3H\x1b[2K\x1b[38;2;200;120;50m│\x1b[0m Task ${cell}: 45% of $0.12 > next`;
  }
  return `${frame}${last}\x1b[?2026l`;
}

// Repaint cells; OSCs and lone ESCs are in a rarer pool of their own, since
// any one of them sends the whole line down the full-strip path.
const LONG_LINE_FRAGMENTS = [
  ...COMMON_FRAGMENTS.filter((fragment) => !fragment.includes("\x1b]")),
  "\x1b[12;33H",
  "\x1b[38;2;80;80;80m",
  "\x1b[?2026h",
  "C:\\repo>^C",
  "^C",
  "PS C:\\> ",
  "➜ ",
  "zz",
  "é",
];
const LONG_LINE_HAZARDS = ["\x1b]0;t\x07", "\x1b\x1b", "\x1b]", "\x1b]8;;file:///x\x1b\\"];

describe("getTrailingNonBlankLines with prompt edges", () => {
  beforeEach(() => {
    strip.mockClear();
  });

  it("answers the prompt question as the whole-chunk strip does, abbreviating only ruled-out lines", () => {
    const random = mulberry32(17042);
    const pick = (pool: readonly string[]) => pool[Math.floor(random() * pool.length)];
    let abbreviated = 0;
    for (let iteration = 0; iteration < 3_000; iteration++) {
      let text = "";
      const lines = 1 + Math.floor(random() * 7);
      for (let line = 0; line < lines; line++) {
        if (random() < 0.5) {
          // Past the long-line threshold, as a cursor-addressed repaint is.
          const target = text.length + 1_100 + Math.floor(random() * 600);
          while (text.length < target) {
            text += random() < 0.002 ? pick(LONG_LINE_HAZARDS) : pick(LONG_LINE_FRAGMENTS);
          }
        } else {
          const fragments = Math.floor(random() * 6);
          for (let i = 0; i < fragments; i++) text += pick(COMMON_FRAGMENTS);
        }
        if (random() < 0.3) text += pick(["user@host:~/repo$ ", "$ ", "➜  repo", "C:\\x>^C"]);
        if (line < lines - 1 || random() < 0.3) text += pick(LINE_BREAKS);
      }
      const expected = wholeChunkTailLines(text, 4);
      const actual = getTrailingNonBlankLines(text, 4, /[#$%>➜➤➟➔]/, promptEdges);
      const input = JSON.stringify(text);
      expect({ input, prompt: actual.some(isPromptLine) }).toEqual({
        input,
        prompt: expected.some(isPromptLine),
      });
      if (actual.length === 0 && !/[#$%>➜➤➟➔]/.test(text)) continue;
      expect({ input, lines: actual.length }).toEqual({ input, lines: expected.length });
      actual.forEach((line, index) => {
        const whole = expected[index];
        if (line === whole) return;
        abbreviated++;
        expect({ input, line, ruledOut: !isPromptLine(whole) && !isPromptLine(line) }).toEqual({
          input,
          line,
          ruledOut: true,
        });
        expect(line.trim()[0]).toBe(whole.trim()[0]);
        expect(line.trimEnd().at(-1)).toBe(whole.trimEnd().at(-1));
      });
    }
    // Most long lines must be abbreviated, or this only proves the fallback.
    expect(abbreviated).toBeGreaterThan(500);
  });

  it("reads a marker-rich cursor-addressed repaint by its ends", () => {
    const frame = cursorAddressedFrame(1_500);

    expect(getTrailingNonBlankLines(frame, 4, /[#$%>➜➤➟➔]/, promptEdges)).toHaveLength(1);
    expect(longestStripInput()).toBeLessThan(200);
  });

  it("finds a prompt on the line after a long repaint", () => {
    const frame = cursorAddressedFrame(100, "\r\n\x1b[01;32muser@host\x1b[00m:~/repo$ ");

    expect(getTrailingNonBlankLines(frame, 4, /[#$%>➜➤➟➔]/, promptEdges).at(-1)).toBe(
      "user@host:~/repo$"
    );
  });

  it("strips a long line whole when its end looks like a prompt", () => {
    const frame = cursorAddressedFrame(100, "\x1b[24;1Huser@host:~/repo$ ");
    const expected = wholeChunkTailLines(frame, 4);
    strip.mockClear();

    expect(getTrailingNonBlankLines(frame, 4, /[#$%>➜➤➟➔]/, promptEdges)).toEqual(expected);
    expect(longestStripInput()).toBe(frame.length);
  });

  it("strips a long line whole when an OSC could reach into it", () => {
    const frame = `\x1b]0;open${cursorAddressedFrame(100)}`;
    const expected = wholeChunkTailLines(frame, 4);
    strip.mockClear();

    expect(getTrailingNonBlankLines(frame, 4, /[#$%>➜➤➟➔]/, promptEdges)).toEqual(expected);
    expect(longestStripInput()).toBe(frame.length);
  });
});

describe("trailingLinesStart", () => {
  // The character-at-a-time walk it replaced for text with few breaks.
  function walkBack(text: string, breaks: number): number {
    let crossed = 0;
    for (let i = text.length - 1; i >= 0; i--) {
      const code = text.charCodeAt(i);
      if (code !== 13 && code !== 10) continue;
      if (++crossed === breaks) return i + 1;
      if (code === 10 && i > 0 && text.charCodeAt(i - 1) === 13) i--;
    }
    return 0;
  }

  it("finds a line-dense tail's breaks without searching the rest", () => {
    const text = "line\n".repeat(20_000);
    const indexOf = vi.spyOn(String.prototype, "indexOf");
    try {
      // The text ends on a break, so the eighth from the end is 7 lines back.
      expect(trailingLinesStart(text, 8)).toBe(text.length - 7 * 5);
      expect(indexOf).not.toHaveBeenCalled();
    } finally {
      indexOf.mockRestore();
    }
  });

  it("finds the same window start as walking back a character at a time", () => {
    const random = mulberry32(4096);
    const pieces = ["\r", "\n", "\r\n", "\r\r\n", "\n\r", "x", "abc", "\x1b[12;3H", "│"];
    for (let iteration = 0; iteration < 4_000; iteration++) {
      let text = "";
      const sparse = iteration % 2 === 0;
      const target = Math.floor(random() * 12_000);
      while (text.length < target) {
        text +=
          sparse && random() < 0.97
            ? "y".repeat(1 + Math.floor(random() * 400))
            : pieces[Math.floor(random() * pieces.length)];
      }
      // Put a CRLF across the boundary the tail walk stops at.
      if (iteration % 7 === 0 && text.length > 4_200) {
        const at = text.length - 4_096 - 1;
        text = `${text.slice(0, at)}\r\n${text.slice(at + 2)}`;
      }
      for (const breaks of [1, 2, 8]) {
        expect({ iteration, breaks, start: trailingLinesStart(text, breaks) }).toEqual({
          iteration,
          breaks,
          start: walkBack(text, breaks),
        });
      }
    }
  });
});
