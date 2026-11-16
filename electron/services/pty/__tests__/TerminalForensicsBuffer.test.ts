import { describe, it, expect } from "vitest";
import { TerminalForensicsBuffer } from "../TerminalForensicsBuffer.js";

const WINDOW = 4000;

function referenceTail(chunks: string[]): string {
  let buffer = "";
  for (const chunk of chunks) {
    buffer += chunk;
    if (buffer.length > WINDOW) buffer = buffer.slice(-WINDOW);
  }
  return buffer;
}

function makeRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

describe("TerminalForensicsBuffer", () => {
  it("is empty before any capture", () => {
    expect(new TerminalForensicsBuffer().getRecentOutput()).toBe("");
  });

  it("keeps everything while under the window", () => {
    const buffer = new TerminalForensicsBuffer();
    buffer.capture("hello ");
    buffer.capture(new TextEncoder().encode("world"));
    expect(buffer.getRecentOutput()).toBe("hello world");
  });

  it("keeps only the last window of a chunk larger than the window", () => {
    const buffer = new TerminalForensicsBuffer();
    buffer.capture("a".repeat(10));
    const big = "x".repeat(WINDOW + 500) + "END";
    buffer.capture(big);
    expect(buffer.getRecentOutput()).toBe(big.slice(-WINDOW));
  });

  it("matches per-chunk trimming for any chunk sequence, read at any point", () => {
    const random = makeRandom(17042);
    for (let run = 0; run < 40; run++) {
      const buffer = new TerminalForensicsBuffer();
      const chunks: string[] = [];
      const steps = 1 + Math.floor(random() * 120);
      for (let step = 0; step < steps; step++) {
        const roll = random();
        const length =
          roll < 0.5
            ? Math.floor(random() * 40)
            : roll < 0.9
              ? Math.floor(random() * 3000)
              : WINDOW - 2 + Math.floor(random() * 5);
        const chunk = String.fromCharCode(97 + (step % 26)).repeat(length) + `|${step}|`;
        chunks.push(chunk);
        buffer.capture(chunk);
        if (random() < 0.2) {
          expect(buffer.getRecentOutput()).toBe(referenceTail(chunks));
        }
      }
      expect(buffer.getRecentOutput()).toBe(referenceTail(chunks));
      expect(buffer.getRecentOutput()).toBe(referenceTail(chunks));
    }
  });
});
