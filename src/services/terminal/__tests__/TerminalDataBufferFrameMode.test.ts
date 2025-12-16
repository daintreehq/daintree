import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { TerminalDataBuffer } from "../TerminalDataBuffer";

describe("TerminalDataBuffer frame mode", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    (globalThis as unknown as { window: unknown }).window = globalThis;
  });

  afterEach(() => {
    vi.useRealTimers();
    delete (globalThis as unknown as { window?: unknown }).window;
  });

  it("coalesces redraw frames and presents atomically", () => {
    const writes: Array<{ id: string; data: string | Uint8Array }> = [];
    const buffer = new TerminalDataBuffer((id, data) => writes.push({ id, data }));

    buffer.bufferData("t1", "\x1b[2J");
    buffer.bufferData("t1", "content");

    vi.advanceTimersByTime(15);
    expect(writes).toEqual([]);

    vi.runAllTimers();
    expect(writes).toEqual([{ id: "t1", data: "\x1b[2Jcontent" }]);
  });

  it("drops oldest frames when overwhelmed", () => {
    const writes: Array<{ id: string; data: string | Uint8Array }> = [];
    const buffer = new TerminalDataBuffer((id, data) => writes.push({ id, data }));

    for (let i = 1; i <= 5; i += 1) {
      buffer.bufferData("t1", `\x1b[2Jframe${i}`);
      buffer.flushForTerminal("t1");
    }

    vi.runAllTimers();

    expect(writes.map((w) => w.data)).toEqual(["\x1b[2Jframe3", "\x1b[2Jframe4", "\x1b[2Jframe5"]);
  });

  it("does not bypass frame mode during interactive flush windows", () => {
    const writes: Array<{ id: string; data: string | Uint8Array }> = [];
    const buffer = new TerminalDataBuffer((id, data) => writes.push({ id, data }));

    buffer.markInteractive("t1", 1000);
    buffer.bufferData("t1", "\x1b[2J");
    buffer.bufferData("t1", "x");

    expect(writes).toEqual([]);

    vi.runAllTimers();
    expect(writes).toEqual([{ id: "t1", data: "\x1b[2Jx" }]);
  });
});
