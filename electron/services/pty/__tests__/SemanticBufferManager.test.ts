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
    outputBuffer: "",
    semanticBuffer: [],
    ...overrides,
  } as TerminalInfo;
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
