import { describe, it, expect, vi } from "vitest";
import { filteredOutputBytesUpTo, survivingBytesLowerBound } from "../filteredOutputBytes.js";
import { stripAnsi } from "../AgentPatternDetector.js";
import { stripIdleTerminalSequences } from "../IdleSequenceFilter.js";
import { stripCosmeticParticles } from "../CosmeticParticleFilter.js";

vi.mock("../AgentPatternDetector.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../AgentPatternDetector.js")>();
  return { ...actual, stripAnsi: vi.fn(actual.stripAnsi) };
});

function exactBytes(data: string): number {
  return Buffer.byteLength(stripAnsi(stripIdleTerminalSequences(data)), "utf8");
}

function makeRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

// Pieces drawn from every family the two filters touch, including the
// adversarial joins: lone ESCs, unfinished CSIs, nested and unterminated OSCs,
// split SGR fragments, Kitty deletes, charset designations, particle frames,
// and surrogate halves.
const PIECES: readonly string[] = [
  "hello",
  " world ",
  "Task 5: building 45%",
  "$0.12",
  "> ",
  "│",
  "─",
  "é",
  "⠋",
  "😀",
  "\ud83d",
  "\ude00",
  "\r\n",
  "\r",
  "\x07",
  "]",
  "[",
  ";30;30;30m",
  "38;2;1;2;3m",
  "5mH",
  "m",
  "H",
  "[0m",
  "\x1b",
  "\x1b[",
  "\x1b[0m",
  "\x1b[38;2;200;120;50m",
  "\x1b[12;40H",
  "\x1b[2K",
  "\x1b[1A",
  "\x1b[?25l",
  "\x1b[?2026h",
  "\x1b[?25;9999h",
  "\x1b[12;34R",
  "\x1b[6n",
  "\x1b[200~",
  "\x1b[ q",
  "\x1b[[",
  "\x1b[38;2;",
  "\x1b]0;title\x07",
  "\x1b]133;A\x07",
  "\x1b]8;;https://example.com\x1b\\",
  "\x1b]9;4;1;50\x1b\\",
  "\x1b]0;",
  "\x1b]1337;x",
  "\x1b\\",
  "\x1b_Ga=d,d=i,i=5\x1b\\",
  "\x1b_Gf=100;AAAA\x1b\\",
  "\x1b(B",
  "\x1b(",
  "\x1b)0",
  "\x1b7",
  "\x1b8",
  "\x1b=",
  "\x1b>",
  "\x1bM",
  "\x1bD",
  "\x1bP",
  "\x1b^",
  "\x1bc",
  "\x1b[3;7H\x1b[38;2;80;80;80m⠁",
  "\x1b[38;2;90;90;90m⠂",
  "\x1b[38;2;100;100;100m⠄\x1b[38;2;64;64;64m⠈\x1b[38;2;70;70;70m⠐",
  "⠠",
];

function randomChunk(random: () => number): string {
  const pieces = 1 + Math.floor(random() * 40);
  let chunk = "";
  for (let i = 0; i < pieces; i++) {
    chunk += PIECES[Math.floor(random() * PIECES.length)];
  }
  return chunk;
}

describe("survivingBytesLowerBound", () => {
  it("never exceeds what the filters actually leave", () => {
    const random = makeRandom(17042);
    for (let run = 0; run < 20000; run++) {
      const data = randomChunk(random);
      const bound = survivingBytesLowerBound(stripCosmeticParticles(data), Infinity);
      const exact = exactBytes(data);
      if (bound > exact) {
        throw new Error(
          `lower bound ${bound} > exact ${exact} for ${JSON.stringify(data)} -> ${JSON.stringify(stripAnsi(stripIdleTerminalSequences(data)))}`
        );
      }
    }
  });

  it("never exceeds what the filters leave of arbitrary escape-heavy text", () => {
    const alphabet = [..."\x1b[]\x07\\()B012;?mHKJaz _G=d7MP~Rnhl38", "é", "⠁", "😀", "\ud83d"];
    const random = makeRandom(9);
    for (let run = 0; run < 20000; run++) {
      let data = "";
      const length = 1 + Math.floor(random() * 30);
      for (let i = 0; i < length; i++) data += alphabet[Math.floor(random() * alphabet.length)];
      const bound = survivingBytesLowerBound(stripCosmeticParticles(data), Infinity);
      if (bound > exactBytes(data)) {
        throw new Error(
          `lower bound ${bound} > exact ${exactBytes(data)} for ${JSON.stringify(data)}`
        );
      }
    }
  });

  it("counts visible text between SGR and cursor moves", () => {
    const frame = "\x1b[3;1H\x1b[38;2;1;2;3mhello\x1b[0m wörld\x1b[K";
    expect(survivingBytesLowerBound(frame, Infinity)).toBe(exactBytes(frame));
  });

  it("does not count an OSC payload or the text after an unterminated one", () => {
    expect(survivingBytesLowerBound("\x1b]0;a long window title\x07", Infinity)).toBe(0);
    expect(survivingBytesLowerBound("\x1b]0;title hello", Infinity)).toBe(0);
  });

  it("resumes counting after a terminated OSC", () => {
    const frame = "\x1b]0;✳ Claude\x07\x1b[2;1Hdone";
    expect(survivingBytesLowerBound(frame, Infinity)).toBe(4);
  });

  it("stops at a lone ESC, whose pairing a later deletion can change", () => {
    expect(survivingBytesLowerBound("ab\x1b\x1b[0mDcd", Infinity)).toBe(2);
  });

  it("keeps a split SGR tail at the chunk head out of the count", () => {
    const chunk = "\x1b[?2026h;30;30mhello";
    expect(survivingBytesLowerBound(chunk, Infinity)).toBeLessThanOrEqual(exactBytes(chunk));
    expect(exactBytes(chunk)).toBe(5);
  });

  it("stops early once the limit is reached", () => {
    const text = "x".repeat(10_000);
    expect(survivingBytesLowerBound(text, 256)).toBe(256);
  });
});

describe("filteredOutputBytesUpTo", () => {
  it("matches the full strip, capped, for any chunk and limit", () => {
    const random = makeRandom(4242);
    for (let run = 0; run < 20000; run++) {
      const data = randomChunk(random);
      const limit = [1, 8, 64, 256, 1024][run % 5];
      const expected = Math.min(exactBytes(data), limit);
      expect(filteredOutputBytesUpTo(data, stripCosmeticParticles(data), limit)).toBe(expected);
    }
  });

  it("is zero for protocol noise alone", () => {
    const noise = "\x1b[?25l\x1b[?2026h\x1b]133;A\x07\x1b[12;34R\x1b[?2026l\x1b[?25h";
    expect(filteredOutputBytesUpTo(noise, stripCosmeticParticles(noise), 256)).toBe(0);
  });

  it("is zero for a particle field", () => {
    const sparkles =
      "\x1b[3;7H\x1b[38;2;80;80;80m⠁\x1b[4;9H\x1b[38;2;90;90;90m⠂\x1b[5;2H\x1b[38;2;100;100;100m⠄";
    expect(filteredOutputBytesUpTo(sparkles, stripCosmeticParticles(sparkles), 256)).toBe(0);
  });

  it("counts plain text without escapes exactly", () => {
    expect(filteredOutputBytesUpTo("héllo", "héllo", 256)).toBe(6);
    expect(filteredOutputBytesUpTo("x".repeat(1000), "x".repeat(1000), 256)).toBe(256);
  });

  it("saturates a large cursor-addressed repaint from its visible text", () => {
    let repaint = "\x1b[?2026h";
    for (let row = 1; repaint.length < 64 * 1024; row = (row % 60) + 1) {
      repaint += `\x1b[${row};1H\x1b[2K\x1b[38;2;200;120;50m│\x1b[0m Task ${row}: building\x1b[K`;
    }
    repaint += "\x1b[?2026l";
    const withoutParticles = stripCosmeticParticles(repaint);
    expect(survivingBytesLowerBound(withoutParticles, 256)).toBe(256);
    vi.mocked(stripAnsi).mockClear();
    expect(filteredOutputBytesUpTo(repaint, withoutParticles, 256)).toBe(256);
    expect(stripAnsi).not.toHaveBeenCalled();
  });

  it("strips a chunk whose provable text falls short of the cap", () => {
    const chunk = "\x1b]0;title\x1b[0m hello";
    const expected = exactBytes(chunk);
    vi.mocked(stripAnsi).mockClear();
    expect(filteredOutputBytesUpTo(chunk, chunk, 256)).toBe(expected);
    expect(stripAnsi).toHaveBeenCalledTimes(1);
  });
});
