import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SemanticBufferManager } from "../SemanticBufferManager.js";
import type { TerminalInfo } from "../types.js";

function createTerminalInfo(overrides: Partial<TerminalInfo> = {}): TerminalInfo {
  return {
    id: "term-1",
    cwd: "/repo",
    shell: "/bin/zsh",
    spawnedAt: Date.now(),
    analysisEnabled: false,
    lastInputTime: 0,
    lastOutputTime: 0,
    lastCheckTime: 0,
    restartCount: 0,
    ptyProcess: {} as never,
    semanticBuffer: [],
    ...overrides,
  } as TerminalInfo;
}

const MARKER = "... [truncated]";
const CAPPED_LENGTH = 1000;

// The full-split implementation this manager replaced, kept as the behavioural oracle.
class SplitReference {
  buffer: string[];
  private pending = "";
  private lastChunkEndedWithNewline = false;

  constructor(seed: string[]) {
    this.buffer = [...seed];
  }

  onData(data: string): void {
    this.pending += data;
    if (this.pending.length > 64 * 1024) this.pending = this.pending.slice(-64 * 1024);
  }

  flush(): void {
    if (!this.pending) return;
    const chunk = this.pending;
    this.pending = "";
    const capLine = (line: string) =>
      line.length > CAPPED_LENGTH ? line.substring(0, CAPPED_LENGTH) + MARKER : line;
    const normalized = chunk.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    const lines = normalized.split("\n");
    const lastIndex = this.buffer.length - 1;
    const last = this.buffer[lastIndex];
    const continuesLastLine =
      lastIndex >= 0 &&
      !normalized.startsWith("\n") &&
      !(this.lastChunkEndedWithNewline && last !== "");
    this.lastChunkEndedWithNewline = normalized.endsWith("\n");
    if (continuesLastLine) {
      const truncated = last.length === CAPPED_LENGTH + MARKER.length && last.endsWith(MARKER);
      if (!truncated) this.buffer[lastIndex] = capLine(last + lines[0]);
      lines.shift();
    }
    const processed = lines
      .filter((line) => line.length > 0 || this.buffer.length > 0)
      .map(capLine);
    this.buffer.push(...processed.slice(-50));
    if (this.buffer.length > 50) this.buffer = this.buffer.slice(-50);
  }
}

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function assertMatchesReference(seed: string[], batches: string[][]): void {
  const info = createTerminalInfo({ semanticBuffer: [...seed] });
  const manager = new SemanticBufferManager(info);
  const reference = new SplitReference(seed);
  batches.forEach((batch, index) => {
    for (const data of batch) {
      manager.onData(data);
      reference.onData(data);
    }
    manager.flush();
    reference.flush();
    expect(info.semanticBuffer, `after batch ${index}`).toEqual(reference.buffer);
  });
  manager.dispose();
}

describe("SemanticBufferManager", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("flushes data to semanticBuffer after debounce timer fires", () => {
    const info = createTerminalInfo();
    const manager = new SemanticBufferManager(info);

    manager.onData("hello\nworld\n");
    expect(info.semanticBuffer).toEqual([]);

    vi.advanceTimersByTime(100);
    expect(info.semanticBuffer).toContain("hello");
    expect(info.semanticBuffer).toContain("world");

    manager.dispose();
  });

  it("flush() clears pending data immediately without waiting for timer", () => {
    const info = createTerminalInfo();
    const manager = new SemanticBufferManager(info);

    manager.onData("immediate\n");
    manager.flush();

    expect(info.semanticBuffer).toContain("immediate");

    manager.dispose();
  });

  it("dispose() cancels pending timer", () => {
    const info = createTerminalInfo();
    const manager = new SemanticBufferManager(info);

    manager.onData("should not flush\n");
    manager.dispose();

    vi.advanceTimersByTime(200);
    expect(info.semanticBuffer).toEqual([]);
  });

  it("merges partial lines across onData calls", () => {
    const info = createTerminalInfo();
    const manager = new SemanticBufferManager(info);

    manager.onData("first line\npartial");
    vi.advanceTimersByTime(100);

    manager.onData(" continuation\n");
    vi.advanceTimersByTime(100);

    expect(info.semanticBuffer).toContain("first line");
    expect(info.semanticBuffer).toContain("partial continuation");

    manager.dispose();
  });

  it("truncates lines exceeding max length", () => {
    const info = createTerminalInfo();
    const manager = new SemanticBufferManager(info);

    const longLine = "x".repeat(1500);
    manager.onData(longLine + "\n");
    vi.advanceTimersByTime(100);

    expect(info.semanticBuffer[0].length).toBeLessThan(1100);
    expect(info.semanticBuffer[0]).toContain("... [truncated]");

    manager.dispose();
  });

  it("caps a line that grows across many flushes and keeps the following line", () => {
    const info = createTerminalInfo();
    const manager = new SemanticBufferManager(info);
    const capped = "a".repeat(1000) + "... [truncated]";

    manager.onData("before\na");
    vi.advanceTimersByTime(100);
    for (let i = 0; i < 200; i++) {
      manager.onData("a".repeat(8 * 1024));
      vi.advanceTimersByTime(100);
    }
    manager.onData("XYZ");
    vi.advanceTimersByTime(100);

    expect(info.semanticBuffer).toEqual(["before", capped]);

    manager.onData("discarded tail\nafter\n");
    vi.advanceTimersByTime(100);

    expect(info.semanticBuffer.slice(0, 3)).toEqual(["before", capped, "after"]);
    expect(info.semanticBuffer.join("\n")).not.toContain("XYZ");
    expect(info.semanticBuffer.join("\n")).not.toContain("discarded");

    manager.dispose();
  });

  it("keeps the following line when a newline arrives after a capped line", () => {
    const info = createTerminalInfo();
    const manager = new SemanticBufferManager(info);

    manager.onData("x".repeat(1200));
    manager.flush();
    manager.onData("more");
    manager.flush();
    manager.onData("\nafter\n");
    manager.flush();

    expect(info.semanticBuffer[0]).toBe("x".repeat(1000) + "... [truncated]");
    expect(info.semanticBuffer).toContain("after");

    manager.dispose();
  });

  it("starts a new line after a capped line completed in the first flush", () => {
    const info = createTerminalInfo();
    const manager = new SemanticBufferManager(info);

    manager.onData("x".repeat(1200) + "\n");
    manager.flush();
    manager.onData("after\n");
    manager.flush();

    expect(info.semanticBuffer[0]).toBe("x".repeat(1000) + "... [truncated]");
    expect(info.semanticBuffer[1]).toBe("after");
    expect(manager.getLastCommand()).toBe("after");

    manager.dispose();
  });

  it("truncates a line that reaches the cap only through a continuation", () => {
    const info = createTerminalInfo();
    const manager = new SemanticBufferManager(info);

    manager.onData("b".repeat(1000));
    vi.advanceTimersByTime(100);
    expect(info.semanticBuffer[0]).toBe("b".repeat(1000));

    manager.onData("cc");
    vi.advanceTimersByTime(100);
    manager.onData("dd");
    vi.advanceTimersByTime(100);

    expect(info.semanticBuffer).toEqual(["b".repeat(1000) + "... [truncated]"]);

    manager.dispose();
  });

  it("still joins continuations onto short text that ends with the marker", () => {
    const info = createTerminalInfo();
    const manager = new SemanticBufferManager(info);

    manager.onData("log... [truncated]");
    vi.advanceTimersByTime(100);
    manager.onData(" more\n");
    vi.advanceTimersByTime(100);

    expect(info.semanticBuffer[0]).toBe("log... [truncated] more");

    manager.dispose();
  });

  it("caps buffer at max lines", () => {
    const info = createTerminalInfo();
    const manager = new SemanticBufferManager(info);

    const lines = Array.from({ length: 60 }, (_, i) => `line${i}`).join("\n") + "\n";
    manager.onData(lines);
    vi.advanceTimersByTime(100);

    expect(info.semanticBuffer.length).toBeLessThanOrEqual(50);
    expect(info.semanticBuffer[info.semanticBuffer.length - 1]).toBe("line59");

    manager.dispose();
  });

  it("caps pending data at accumulation time under a flood", () => {
    const info = createTerminalInfo();
    const manager = new SemanticBufferManager(info);

    for (let i = 0; i < 50; i++) {
      manager.onData(`${"x".repeat(100)} chunk${i}\n`.repeat(100));
    }
    manager.onData("final line\n");
    vi.advanceTimersByTime(100);

    expect(info.semanticBuffer.length).toBeLessThanOrEqual(50);
    expect(info.semanticBuffer[info.semanticBuffer.length - 1]).toBe("final line");

    manager.dispose();
  });

  it("survives a short-line flood without overflowing the push spread", () => {
    const info = createTerminalInfo();
    const manager = new SemanticBufferManager(info);

    manager.onData("y\n".repeat(500_000));
    expect(() => vi.advanceTimersByTime(100)).not.toThrow();
    expect(info.semanticBuffer.length).toBeLessThanOrEqual(50);

    manager.dispose();
  });

  it("keeps the last lines of a newline-heavy burst, dropping blanks only on the first flush", () => {
    const burst = "\n" + Array.from({ length: 10_000 }, (_, i) => `l${i}\n`).join("");
    const lines = (from: number, to: number) =>
      Array.from({ length: to - from + 1 }, (_, i) => `l${from + i}`);

    const existing = createTerminalInfo({ semanticBuffer: ["earlier"] });
    const continuing = new SemanticBufferManager(existing);
    continuing.onData(burst);
    continuing.flush();
    expect(existing.semanticBuffer).toEqual([...lines(9951, 9999), ""]);

    const fresh = createTerminalInfo();
    const first = new SemanticBufferManager(fresh);
    first.onData(burst);
    first.flush();
    expect(fresh.semanticBuffer).toEqual(lines(9950, 9999));

    continuing.dispose();
    first.dispose();
  });

  it("finds the start of a long line that follows a newline-dense run", () => {
    const info = createTerminalInfo({ semanticBuffer: ["earlier"] });
    const manager = new SemanticBufferManager(info);

    manager.onData(
      "\n" +
        Array.from({ length: 4000 }, (_, i) => `a${i}\r`).join("") +
        "b".repeat(20_000) +
        "\rlast"
    );
    manager.flush();

    expect(info.semanticBuffer).toEqual([
      ...Array.from({ length: 48 }, (_, i) => `a${3952 + i}`),
      "b".repeat(1000) + MARKER,
      "last",
    ]);

    manager.dispose();
  });

  it("truncates a break-free continuation that passes the cap after an empty entry", () => {
    const info = createTerminalInfo({ semanticBuffer: ["done", ""] });
    const manager = new SemanticBufferManager(info);

    manager.onData("z".repeat(1001));
    manager.flush();
    expect(info.semanticBuffer).toEqual(["done", "z".repeat(1000) + MARKER]);

    manager.onData("more\nnext");
    manager.flush();
    expect(info.semanticBuffer).toEqual(["done", "z".repeat(1000) + MARKER, "next"]);

    manager.dispose();
  });

  it("keeps CRLF pairs within a flush but not across flushes", () => {
    const flushed = createTerminalInfo();
    const separate = new SemanticBufferManager(flushed);
    for (const data of ["p", "q\r\n"]) {
      separate.onData(data);
      separate.flush();
    }
    expect(flushed.semanticBuffer).toEqual(["pq", ""]);
    for (const data of ["r\r", "\ns"]) {
      separate.onData(data);
      separate.flush();
    }
    expect(flushed.semanticBuffer).toEqual(["pq", "r", "", "", "s"]);

    const coalesced = createTerminalInfo();
    const together = new SemanticBufferManager(coalesced);
    together.onData("p");
    together.flush();
    together.onData("q\r\n");
    together.flush();
    together.onData("r\r");
    together.onData("\ns");
    together.flush();
    expect(coalesced.semanticBuffer).toEqual(["pq", "r", "s"]);

    separate.dispose();
    together.dispose();
  });

  it("matches the full-split algorithm across randomized flush sequences", () => {
    const random = mulberry32(17792);
    const pick = <T>(items: T[]): T => items[Math.floor(random() * items.length)];
    const between = (min: number, max: number) => min + Math.floor(random() * (max - min + 1));
    const pieces: Array<() => string> = [
      () => "a",
      () => "cmd",
      () => "\r",
      () => "\n",
      () => "\r\n",
      () => "\n\n",
      () => "\r\r\n",
      () => "$ ls",
      () => MARKER,
      () => "x".repeat(between(240, 270)),
      () => "y".repeat(between(990, 1010)),
      () => "z".repeat(between(1, 6000)),
      () => "\n".repeat(between(1, 120)),
      () => "w\r\n".repeat(between(1, 80)),
      () => "v\n".repeat(between(40, 60)),
      // Two-byte strings, code units whose low byte is LF or CR, a non-break separator, and
      // surrogate pairs that the cap splits.
      () => "Ċč ",
      () => "\u{1f600}".repeat(between(495, 505)),
    ];
    const seeds: Array<() => string[]> = [
      () => [],
      () => ["prompt$ "],
      () => ["done", ""],
      () => ["q".repeat(CAPPED_LENGTH) + MARKER],
      () => ["short" + MARKER],
      () => Array.from({ length: 60 }, (_, i) => `seed${i}`),
    ];

    for (let sequence = 0; sequence < 300; sequence++) {
      const batches = Array.from({ length: between(1, 8) }, () =>
        Array.from({ length: between(1, 3) }, () =>
          Array.from({ length: between(1, 10) }, () => pick(pieces)()).join("")
        )
      );
      assertMatchesReference(pick(seeds)(), batches);
    }
  });

  it("matches the full-split algorithm on oversized and long-line batches", () => {
    assertMatchesReference(
      ["earlier"],
      [["x\n".repeat(40_000)], ["z".repeat(70_000)], ["\r\n" + "y".repeat(65_000) + "\r\n"]]
    );
    assertMatchesReference([], [["\n".repeat(30_000) + "only\n" + "\n".repeat(30_000)]]);
    assertMatchesReference(
      [],
      [["a".repeat(300) + "\r\n" + "b".repeat(1500) + "\r" + "c".repeat(513) + "\n"]]
    );
    // The onData cap discards the prefix before the retained LF, so the chunk starts a new line.
    assertMatchesReference(["seed"], [["discard\r", "\nhead\n" + "x".repeat(65_530)]]);
    // A break at the floor of the scan: the LF right after the continuation's CRLF.
    assertMatchesReference(["p"], [["q\r\n\n" + "k".repeat(512)]]);
    // Bare CRs either side of the backward-scan limit and the gallop's window edges.
    for (const length of [255, 256, 257, 511, 512, 513, 16_383, 16_384, 16_385]) {
      assertMatchesReference(["earlier"], [["\rhead\r" + "k".repeat(length)]]);
      assertMatchesReference(["earlier"], [["v\r".repeat(100) + "k".repeat(length) + "\r"]]);
    }
  });

  it("getLastCommand() strips shell prompt prefixes", () => {
    const info = createTerminalInfo({
      semanticBuffer: ["user@host:/path$ npm run build"],
    });
    const manager = new SemanticBufferManager(info);

    expect(manager.getLastCommand()).toBe("npm run build");

    manager.dispose();
  });

  it("getLastCommand() returns the last non-empty command", () => {
    const info = createTerminalInfo({
      semanticBuffer: ["ls -la", "echo hello", ""],
    });
    const manager = new SemanticBufferManager(info);

    expect(manager.getLastCommand()).toBe("echo hello");

    manager.dispose();
  });

  it("normalizes \\r\\n and bare \\r to \\n", () => {
    const info = createTerminalInfo();
    const manager = new SemanticBufferManager(info);

    manager.onData("line1\r\nline2\rline3\n");
    vi.advanceTimersByTime(100);

    expect(info.semanticBuffer).toContain("line1");
    expect(info.semanticBuffer).toContain("line2");
    expect(info.semanticBuffer).toContain("line3");

    manager.dispose();
  });

  it("onData with empty string is a no-op after flush", () => {
    const info = createTerminalInfo();
    const manager = new SemanticBufferManager(info);

    manager.onData("");
    vi.advanceTimersByTime(100);

    expect(info.semanticBuffer).toEqual([]);

    manager.dispose();
  });

  it("getLastCommand() returns undefined when all lines are prompt-only", () => {
    const info = createTerminalInfo({
      semanticBuffer: ["user@host:/path$ ", "$ ", ""],
    });
    const manager = new SemanticBufferManager(info);

    expect(manager.getLastCommand()).toBeUndefined();

    manager.dispose();
  });

  it("getLastCommand() only searches the last 10 lines", () => {
    const lines = Array.from({ length: 15 }, () => "");
    lines[0] = "old command";
    const info = createTerminalInfo({ semanticBuffer: lines });
    const manager = new SemanticBufferManager(info);

    expect(manager.getLastCommand()).toBeUndefined();

    manager.dispose();
  });
});
