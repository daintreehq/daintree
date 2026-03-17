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
    inputWriteQueue: [],
    inputWriteTimeout: null,
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

  it("accumulates data across multiple onData calls before timer", () => {
    const info = createTerminalInfo();
    const manager = new SemanticBufferManager(info);

    manager.onData("hel");
    manager.onData("lo\nworld\n");

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

  it("getLastCommand() returns undefined on empty buffer", () => {
    const info = createTerminalInfo();
    const manager = new SemanticBufferManager(info);

    expect(manager.getLastCommand()).toBeUndefined();

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
