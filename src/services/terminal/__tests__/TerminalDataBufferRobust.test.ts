import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { TerminalDataBuffer } from "../TerminalDataBuffer";

describe("TerminalDataBuffer robust buffering", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    (globalThis as unknown as { window: unknown }).window = globalThis;
  });

  afterEach(() => {
    vi.useRealTimers();
    delete (globalThis as unknown as { window?: unknown }).window;
  });

  it("coalesces string chunks and flushes on timer", () => {
    const writes: Array<{ id: string; data: string | Uint8Array }> = [];
    const buffer = new TerminalDataBuffer((id, data) => writes.push({ id, data }));

    buffer.bufferData("t1", "hello ");
    buffer.bufferData("t1", "world");

    expect(writes).toEqual([]);

    vi.runAllTimers();
    expect(writes).toEqual([{ id: "t1", data: "hello world" }]);
  });

  it("flushes immediately when buffer exceeds MAX_BUFFER_BYTES", () => {
    const writes: Array<{ id: string; data: string | Uint8Array }> = [];
    const buffer = new TerminalDataBuffer((id, data) => writes.push({ id, data }));

    buffer.bufferData("t1", "x".repeat(20 * 1024));

    expect(writes).toEqual([{ id: "t1", data: "x".repeat(20 * 1024) }]);
  });

  it("stopPolling flushes any pending buffers", () => {
    const writes: Array<{ id: string; data: string | Uint8Array }> = [];
    const buffer = new TerminalDataBuffer((id, data) => writes.push({ id, data }));

    buffer.bufferData("t1", "hello");
    buffer.stopPolling();

    expect(writes).toEqual([{ id: "t1", data: "hello" }]);
  });
});
