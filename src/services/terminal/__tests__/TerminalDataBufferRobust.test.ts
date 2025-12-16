import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { TerminalDataBuffer } from "../TerminalDataBuffer";
import { SharedRingBuffer, PacketFramer } from "@shared/utils/SharedRingBuffer";

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

describe("TerminalDataBuffer polling budget", () => {
  let ringBuffer: SharedRingBuffer;
  let framer: PacketFramer;

  const MAX_SAB_READ_BYTES = 256 * 1024;
  const MAX_SAB_BYTES_PER_TICK = 2 * 1024 * 1024;
  const BUSY_POLL_INTERVAL_MS = 8;
  const PAYLOAD_BYTES = 60 * 1024;

  beforeEach(() => {
    vi.useFakeTimers();
    (globalThis as unknown as { window: unknown }).window = globalThis;
    const sab = SharedRingBuffer.create(4 * 1024 * 1024);
    ringBuffer = new SharedRingBuffer(sab);
    framer = new PacketFramer();
  });

  afterEach(() => {
    vi.useRealTimers();
    delete (globalThis as unknown as { window?: unknown }).window;
  });

  function writeManyPackets(count: number, ch: string): void {
    for (let i = 0; i < count; i++) {
      const packet = framer.frame("t1", ch.repeat(PAYLOAD_BYTES));
      expect(packet).not.toBeNull();
      ringBuffer.write(packet!);
    }
  }

  it("caps each SAB read to MAX_SAB_READ_BYTES", () => {
    const writes: Array<{ id: string; data: string | Uint8Array }> = [];
    const buffer = new TerminalDataBuffer((id, data) => writes.push({ id, data }));

    writeManyPackets(80, "x");
    const readSpy = vi.spyOn(ringBuffer, "readUpTo");

    const bufferWithRing = Object.assign(buffer, {
      ringBuffer,
      sharedBufferEnabled: true,
      pollingActive: true,
    });

    (bufferWithRing as { poll: () => void }).poll();

    const returned = readSpy.mock.results
      .map((r) => r.value)
      .filter((v): v is Uint8Array => v instanceof Uint8Array);

    expect(returned.length).toBeGreaterThan(0);
    expect(Math.max(...returned.map((b) => b.byteLength))).toBeLessThanOrEqual(MAX_SAB_READ_BYTES);
  });

  it("stops reading after MAX_SAB_BYTES_PER_TICK and schedules next poll", () => {
    const writes: Array<{ id: string; data: string | Uint8Array }> = [];
    const buffer = new TerminalDataBuffer((id, data) => writes.push({ id, data }));

    writeManyPackets(80, "y");
    const readSpy = vi.spyOn(ringBuffer, "readUpTo");
    const timeoutSpy = vi.spyOn(window, "setTimeout");

    const bufferWithRing = Object.assign(buffer, {
      ringBuffer,
      sharedBufferEnabled: true,
      pollingActive: true,
    });

    (bufferWithRing as { poll: () => void }).poll();

    const totalRead = readSpy.mock.results
      .map((r) => r.value)
      .filter((v): v is Uint8Array => v instanceof Uint8Array)
      .reduce((sum, b) => sum + b.byteLength, 0);

    expect(totalRead).toBeLessThanOrEqual(MAX_SAB_BYTES_PER_TICK);
    expect(ringBuffer.hasData()).toBe(true);
    expect(timeoutSpy).toHaveBeenCalledWith(expect.any(Function), BUSY_POLL_INTERVAL_MS);
  });

  it("continues polling when data remains after budget exhausted", () => {
    const writes: Array<{ id: string; data: string | Uint8Array }> = [];
    const buffer = new TerminalDataBuffer((id, data) => writes.push({ id, data }));

    writeManyPackets(80, "z");

    const bufferWithRing = Object.assign(buffer, {
      ringBuffer,
      sharedBufferEnabled: true,
      pollingActive: true,
    });

    (bufferWithRing as { poll: () => void }).poll();

    const hasScheduledPoll = vi.getTimerCount() > 0;
    expect(hasScheduledPoll).toBe(true);
  });
});
