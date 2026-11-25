import { describe, it, expect, vi } from "vitest";
import type { TerminalInfo } from "../types.js";

const logged = vi.hoisted(() => ({ error: vi.fn(), localOnly: vi.fn() }));
vi.mock("../../../utils/logger.js", () => ({
  logError: logged.error,
  logLocalOnly: logged.localOnly,
}));

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

describe("TerminalForensicsBuffer.logForensics", () => {
  const agentTerminal = { wasKilled: false, cwd: "/home/me", detectedAgentId: "claude" };

  it("logs an agent's abnormal exit with its tail", () => {
    logged.error.mockClear();
    const buffer = new TerminalForensicsBuffer();
    buffer.capture("Error: something broke\n");
    buffer.logForensics("term-1", 1, agentTerminal as unknown as TerminalInfo, true);
    expect(logged.error).toHaveBeenCalledTimes(1);
  });

  it("never logs an agent CLI sign-in's screen (#18196)", () => {
    logged.error.mockClear();
    logged.localOnly.mockClear();
    const buffer = new TerminalForensicsBuffer();
    buffer.capture("Error: something broke\nPaste code: ABCD-1234\n");
    buffer.logForensics("daintree-sign-in-1", 1, agentTerminal as unknown as TerminalInfo, true);
    expect(logged.error).not.toHaveBeenCalled();
    expect(logged.localOnly).not.toHaveBeenCalled();
  });
});

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

  it("bounds what it holds between reads, however many chunks arrive", () => {
    const buffer = new TerminalForensicsBuffer();
    const held = buffer as unknown as { chunks: string[]; bufferedLength: number };
    for (let i = 0; i < 50_000; i++) {
      buffer.capture(`line ${i}\r\n`);
      expect(held.bufferedLength).toBeLessThanOrEqual(2 * WINDOW + 20);
    }
    expect(held.chunks.length).toBeLessThanOrEqual(2 * WINDOW);
    expect(buffer.getRecentOutput().endsWith("line 49999\r\n")).toBe(true);
  });

  it("decodes each byte chunk on its own, as a split character arrives", () => {
    const buffer = new TerminalForensicsBuffer();
    buffer.capture(new Uint8Array([0xc3]));
    buffer.capture(new Uint8Array([0xa9]));
    buffer.capture(new Uint8Array([0x61, 0xff, 0x62]));

    expect(buffer.getRecentOutput()).toBe("\ufffd\ufffda\ufffdb");
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
