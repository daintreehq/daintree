import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { PortBatcher, type PortBatcherDeps } from "../portBatcher.js";
import type { PortQueueManager } from "../portQueue.js";
import { PORT_BATCH_THRESHOLD_BYTES } from "../../services/pty/types.js";

function bytes(text: string): Uint8Array {
  return new Uint8Array(Buffer.from(text, "utf8"));
}

function bytesOfLength(len: number, fillChar = "x"): Uint8Array {
  return new Uint8Array(Buffer.from(fillChar.repeat(len), "utf8"));
}

function createMockQueueManager() {
  return {
    isAtCapacity: vi.fn(() => false),
    addBytes: vi.fn(),
    getUtilization: vi.fn(() => 0),
    applyBackpressure: vi.fn(),
  } as unknown as PortQueueManager;
}

function createDeps(overrides?: Partial<PortBatcherDeps>): PortBatcherDeps {
  return {
    portQueueManager: createMockQueueManager(),
    postMessage: vi.fn(),
    onError: vi.fn(),
    ...overrides,
  };
}

describe("PortBatcher", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("latency mode: flushes on setImmediate with correct data", () => {
    const deps = createDeps();
    const batcher = new PortBatcher(deps);

    const result = batcher.write("t1", bytes("hello"), 5);
    expect(result).toBe(true);
    expect(deps.postMessage).not.toHaveBeenCalled();

    vi.runAllTimers();

    expect(deps.postMessage).toHaveBeenCalledOnce();
    expect(deps.postMessage).toHaveBeenCalledWith("t1", bytes("hello"), 5);
    expect(deps.portQueueManager.addBytes).toHaveBeenCalledWith("t1", 5);
  });

  it("throughput upgrade: second chunk before immediate switches to setTimeout(16)", () => {
    const deps = createDeps();
    const batcher = new PortBatcher(deps);

    batcher.write("t1", bytes("aaa"), 3);
    batcher.write("t1", bytes("bbb"), 3);

    // Advance less than 16ms — should not flush yet
    vi.advanceTimersByTime(10);
    expect(deps.postMessage).not.toHaveBeenCalled();

    // Advance to 16ms — should flush
    vi.advanceTimersByTime(6);
    expect(deps.postMessage).toHaveBeenCalledOnce();
    expect(deps.postMessage).toHaveBeenCalledWith("t1", bytes("aaabbb"), 6);
  });

  it("no double-upgrade: third chunk in throughput mode does not reschedule", () => {
    const deps = createDeps();
    const batcher = new PortBatcher(deps);

    batcher.write("t1", bytes("a"), 1);
    batcher.write("t1", bytes("b"), 1); // upgrade to throughput
    batcher.write("t1", bytes("c"), 1); // no reschedule

    vi.advanceTimersByTime(16);
    expect(deps.postMessage).toHaveBeenCalledOnce();
    expect(deps.postMessage).toHaveBeenCalledWith("t1", bytes("abc"), 3);
  });

  it("threshold bypass: sync flush when bytes exceed 64KB", () => {
    const deps = createDeps();
    const batcher = new PortBatcher(deps);

    const bigData = bytesOfLength(PORT_BATCH_THRESHOLD_BYTES);
    batcher.write("t1", bigData, PORT_BATCH_THRESHOLD_BYTES);

    // Should have flushed synchronously — no timer needed
    expect(deps.postMessage).toHaveBeenCalledOnce();
    expect(deps.postMessage).toHaveBeenCalledWith("t1", bigData, PORT_BATCH_THRESHOLD_BYTES);

    // No pending timers
    expect(vi.getTimerCount()).toBe(0);
  });

  it("multi-terminal grouping: interleaved writes produce separate postMessages", () => {
    const deps = createDeps();
    const batcher = new PortBatcher(deps);

    batcher.write("t1", bytes("a1"), 2);
    batcher.write("t2", bytes("b1"), 2);
    batcher.write("t1", bytes("a2"), 2);

    vi.runAllTimers();

    expect(deps.postMessage).toHaveBeenCalledTimes(2);
    expect(deps.postMessage).toHaveBeenCalledWith("t1", bytes("a1a2"), 4);
    expect(deps.postMessage).toHaveBeenCalledWith("t2", bytes("b1"), 2);
  });

  it("capacity gating: returns false when portQueueManager is at capacity", () => {
    const qm = createMockQueueManager();
    (qm.isAtCapacity as ReturnType<typeof vi.fn>).mockReturnValue(true);
    const deps = createDeps({ portQueueManager: qm });
    const batcher = new PortBatcher(deps);

    const result = batcher.write("t1", bytes("data"), 4);
    expect(result).toBe(false);
    expect(deps.postMessage).not.toHaveBeenCalled();
  });

  it("pending byte reservation: capacity check includes buffered bytes", () => {
    const qm = createMockQueueManager();
    (qm.isAtCapacity as ReturnType<typeof vi.fn>).mockImplementation(
      (_id: string, bytes: number) => bytes > 100
    );
    const deps = createDeps({ portQueueManager: qm });
    const batcher = new PortBatcher(deps);

    // First write of 80 bytes succeeds (80 <= 100)
    expect(batcher.write("t1", bytesOfLength(80), 80)).toBe(true);
    // Second write of 30 bytes should fail (80 + 30 = 110 > 100)
    expect(batcher.write("t1", bytesOfLength(30, "y"), 30)).toBe(false);
  });

  it("capacity rejection flushes pending data to prevent split-channel delivery", () => {
    const qm = createMockQueueManager();
    (qm.isAtCapacity as ReturnType<typeof vi.fn>).mockImplementation(
      (_id: string, bytes: number) => bytes > 100
    );
    const deps = createDeps({ portQueueManager: qm });
    const batcher = new PortBatcher(deps);

    // Buffer 80 bytes for t1
    const buffered = bytesOfLength(80, "b");
    expect(batcher.write("t1", buffered, 80)).toBe(true);
    expect(deps.postMessage).not.toHaveBeenCalled();

    // Next write rejected — but pending data should be flushed first
    const rejected = bytesOfLength(30, "r");
    expect(batcher.write("t1", rejected, 30)).toBe(false);
    expect(deps.postMessage).toHaveBeenCalledOnce();
    expect(deps.postMessage).toHaveBeenCalledWith("t1", buffered, 80);
  });

  it("flushTerminal: flushes only the specified terminal", () => {
    const deps = createDeps();
    const batcher = new PortBatcher(deps);

    batcher.write("t1", bytes("aaa"), 3);
    batcher.write("t2", bytes("bbb"), 3);

    batcher.flushTerminal("t1");

    expect(deps.postMessage).toHaveBeenCalledOnce();
    expect(deps.postMessage).toHaveBeenCalledWith("t1", bytes("aaa"), 3);

    // t2 is still buffered, flushes on timer
    vi.runAllTimers();
    expect(deps.postMessage).toHaveBeenCalledTimes(2);
    expect(deps.postMessage).toHaveBeenCalledWith("t2", bytes("bbb"), 3);
  });

  it("flushTerminal: subsequent write to a fresh terminal starts in latency mode", () => {
    const deps = createDeps();
    const batcher = new PortBatcher(deps);

    batcher.write("t1", bytes("aaa"), 3);
    batcher.write("t1", bytes("bbb"), 3); // t1 upgrades to throughput

    batcher.flushTerminal("t1");
    expect(deps.postMessage).toHaveBeenCalledWith("t1", bytes("aaabbb"), 6);

    // Next write to a fresh terminal starts with its own idle entry → latency (setImmediate),
    // not stale throughput inherited from t1.
    (deps.postMessage as ReturnType<typeof vi.fn>).mockClear();
    batcher.write("t2", bytes("ccc"), 3);

    vi.advanceTimersByTime(2);
    expect(deps.postMessage).toHaveBeenCalledWith("t2", bytes("ccc"), 3);
  });

  it("flushTerminal on non-existent id is a no-op", () => {
    const deps = createDeps();
    const batcher = new PortBatcher(deps);

    batcher.flushTerminal("nonexistent");
    expect(deps.postMessage).not.toHaveBeenCalled();
  });

  it("postMessage error calls onError with failed payloads", () => {
    const deps = createDeps();
    (deps.postMessage as ReturnType<typeof vi.fn>).mockImplementation(() => {
      throw new Error("port closed");
    });
    const batcher = new PortBatcher(deps);

    batcher.write("t1", bytes("data"), 4);
    vi.runAllTimers();

    expect(deps.onError).toHaveBeenCalledOnce();
    expect(deps.onError).toHaveBeenCalledWith(expect.any(Error), [
      { id: "t1", data: bytes("data"), bytes: 4 },
    ]);
  });

  it("postMessage error reports remaining buffered terminals for fallback delivery", () => {
    const deps = createDeps();
    (deps.postMessage as ReturnType<typeof vi.fn>).mockImplementation(() => {
      throw new Error("port closed");
    });
    const batcher = new PortBatcher(deps);

    batcher.write("t1", bytes("one"), 3);
    batcher.write("t2", bytes("two"), 3);
    vi.runAllTimers();

    expect(deps.onError).toHaveBeenCalledWith(expect.any(Error), [
      { id: "t1", data: bytes("one"), bytes: 3 },
      { id: "t2", data: bytes("two"), bytes: 3 },
    ]);
  });

  it("flush on empty buffer is a no-op", () => {
    const deps = createDeps();
    const batcher = new PortBatcher(deps);

    batcher.flush();
    expect(deps.postMessage).not.toHaveBeenCalled();
  });

  it("dispose cancels pending timers and rejects further writes", () => {
    const deps = createDeps();
    const batcher = new PortBatcher(deps);

    batcher.write("t1", bytes("data"), 4);
    batcher.dispose();

    expect(vi.getTimerCount()).toBe(0);
    expect(batcher.write("t1", bytes("more"), 4)).toBe(false);
  });

  it("dispose is safe to call twice", () => {
    const deps = createDeps();
    const batcher = new PortBatcher(deps);

    batcher.dispose();
    batcher.dispose();
    // No error thrown
  });

  it("addBytes is called only at flush time, not during write", () => {
    const deps = createDeps();
    const batcher = new PortBatcher(deps);

    batcher.write("t1", bytes("data"), 4);
    expect(deps.portQueueManager.addBytes).not.toHaveBeenCalled();

    vi.runAllTimers();
    expect(deps.portQueueManager.addBytes).toHaveBeenCalledWith("t1", 4);
  });

  it("single chunk flush emits the same bytes", () => {
    const deps = createDeps();
    const batcher = new PortBatcher(deps);

    batcher.write("t1", bytes("single"), 6);
    vi.runAllTimers();

    expect(deps.postMessage).toHaveBeenCalledWith("t1", bytes("single"), 6);
  });

  it("threshold accumulation: multiple small writes trigger sync flush at threshold", () => {
    const deps = createDeps();
    const batcher = new PortBatcher(deps);

    const chunkSize = 32 * 1024;
    const chunk = bytesOfLength(chunkSize);

    batcher.write("t1", chunk, chunkSize); // 32KB — latency mode
    expect(deps.postMessage).not.toHaveBeenCalled();

    batcher.write("t1", chunk, chunkSize); // 64KB — triggers sync flush
    expect(deps.postMessage).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("flush emits a transferable Uint8Array — backing buffer is not aliased to the input chunk", () => {
    // Slab-escape regression for PR #4639: node-pty Buffers under 4KB share an
    // 8KB pool slab, so the flush output must be a fresh ArrayBuffer that the
    // postMessage closure can safely place in a transfer list. The batcher's
    // output buffer must not be aliased to any input chunk.
    const deps = createDeps();
    const batcher = new PortBatcher(deps);

    // Simulate a node-pty chunk: a 4-byte view into an 8KB slab.
    const slab = new ArrayBuffer(8192);
    new Uint8Array(slab).fill(0xab); // pre-fill so we can detect aliasing
    const chunk = new Uint8Array(slab, 16, 4);
    chunk.set([1, 2, 3, 4]);

    batcher.write("t1", chunk, 4);
    vi.runAllTimers();

    const postMessage = deps.postMessage as ReturnType<typeof vi.fn>;
    expect(postMessage).toHaveBeenCalledOnce();
    const emitted = postMessage.mock.calls[0][1] as Uint8Array;

    expect(emitted.byteLength).toBe(4);
    // The emitted buffer must NOT be the slab — that would detach the slab on transfer.
    expect(emitted.buffer).not.toBe(slab);
    expect(emitted.buffer.byteLength).toBe(4);
    expect(Array.from(emitted)).toEqual([1, 2, 3, 4]);
  });

  it("multi-byte UTF-8: emitted byteLength matches Buffer.byteLength of the source string", () => {
    // ACK accounting on the host uses chunk.byteLength (the UTF-8 byte count),
    // not character count. A regression that confused string.length and
    // byteLength would silently miscalibrate backpressure for non-ASCII output.
    const deps = createDeps();
    const batcher = new PortBatcher(deps);

    const text = "café — 日本語 🚀";
    const expectedBytes = Buffer.byteLength(text, "utf8");
    expect(expectedBytes).toBeGreaterThan(text.length);

    batcher.write("t1", bytes(text), expectedBytes);
    vi.runAllTimers();

    const postMessage = deps.postMessage as ReturnType<typeof vi.fn>;
    expect(postMessage).toHaveBeenCalledOnce();
    const [, emitted, ackBytes] = postMessage.mock.calls[0];
    expect(ackBytes).toBe(expectedBytes);
    expect((emitted as Uint8Array).byteLength).toBe(expectedBytes);
    expect(Buffer.from(emitted as Uint8Array).toString("utf8")).toBe(text);
  });

  it("byte-count mismatch routes through onError instead of throwing", () => {
    // mergeChunks runs inside the flush try/catch, so allocation failures
    // (e.g., a future caller passing a wrong totalBytes) surface via onError
    // and trigger disconnectWindow rather than aborting the flush loop.
    const deps = createDeps();
    const batcher = new PortBatcher(deps);

    // Lie about the byte count: chunk is 4 bytes but we claim 8 bytes.
    // mergeChunks will allocate Uint8Array(8) and chunks.set(chunk, offset)
    // succeeds — but offset (4) does not equal totalBytes (8). The actual
    // failure mode here is benign (trailing zeros), so we use a chunk that
    // overflows the claimed budget instead.
    const chunk = bytesOfLength(8);
    batcher.write("t1", chunk, 4); // claim 4 bytes for an 8-byte chunk
    vi.runAllTimers();

    expect(deps.onError).toHaveBeenCalledOnce();
    expect(deps.onError).toHaveBeenCalledWith(expect.any(Error), [
      { id: "t1", data: new Uint8Array(0), bytes: 4 },
    ]);
  });

  it("flush concatenates multiple chunks into a single contiguous Uint8Array", () => {
    const deps = createDeps();
    const batcher = new PortBatcher(deps);

    batcher.write("t1", bytes("foo"), 3);
    batcher.write("t1", bytes("bar"), 3);
    batcher.write("t1", bytes("baz"), 3);
    vi.runAllTimers();

    const postMessage = deps.postMessage as ReturnType<typeof vi.fn>;
    expect(postMessage).toHaveBeenCalledOnce();
    const emitted = postMessage.mock.calls[0][1] as Uint8Array;

    expect(emitted.byteLength).toBe(9);
    expect(emitted.buffer.byteLength).toBe(9);
    expect(Buffer.from(emitted).toString("utf8")).toBe("foobarbaz");
  });

  describe("owned zero-copy fast path (#8367)", () => {
    // A chunk that fully owns its ArrayBuffer, mirroring pty-host.ts ingestion
    // (`new Uint8Array(...)` produces a fresh exact-length buffer, byteOffset 0).
    function ownedBytes(text: string): Uint8Array {
      return new Uint8Array(Buffer.from(text, "utf8"));
    }

    it("owned single-chunk flush transfers the chunk's own buffer without copying", () => {
      const deps = createDeps();
      const batcher = new PortBatcher(deps);

      const chunk = ownedBytes("flood");
      expect(chunk.byteOffset).toBe(0);
      expect(chunk.byteLength).toBe(chunk.buffer.byteLength);

      batcher.write("t1", chunk, 5, true);
      vi.runAllTimers();

      const postMessage = deps.postMessage as ReturnType<typeof vi.fn>;
      expect(postMessage).toHaveBeenCalledOnce();
      const emitted = postMessage.mock.calls[0][1] as Uint8Array;

      // No allocation: the emitted view is backed by the input chunk's buffer.
      expect(emitted).toBe(chunk);
      expect(emitted.buffer).toBe(chunk.buffer);
      expect(Buffer.from(emitted).toString("utf8")).toBe("flood");
    });

    it("non-owned single-chunk flush still copies into a fresh buffer", () => {
      const deps = createDeps();
      const batcher = new PortBatcher(deps);

      const chunk = ownedBytes("copyme");
      batcher.write("t1", chunk, 6); // owned defaults to false
      vi.runAllTimers();

      const postMessage = deps.postMessage as ReturnType<typeof vi.fn>;
      const emitted = postMessage.mock.calls[0][1] as Uint8Array;

      expect(emitted).not.toBe(chunk);
      expect(emitted.buffer).not.toBe(chunk.buffer);
      expect(Buffer.from(emitted).toString("utf8")).toBe("copyme");
    });

    it("owned chunk that is a slab subview still copies (PR #4639 invariant)", () => {
      const deps = createDeps();
      const batcher = new PortBatcher(deps);

      // A 4-byte view into an 8KB slab: transferring its buffer would detach
      // the slab. Even with owned=true the fast path must reject it.
      const slab = new ArrayBuffer(8192);
      const chunk = new Uint8Array(slab, 16, 4);
      chunk.set([9, 8, 7, 6]);

      batcher.write("t1", chunk, 4, true);
      vi.runAllTimers();

      const postMessage = deps.postMessage as ReturnType<typeof vi.fn>;
      const emitted = postMessage.mock.calls[0][1] as Uint8Array;

      expect(emitted.buffer).not.toBe(slab);
      expect(emitted.buffer.byteLength).toBe(4);
      expect(Array.from(emitted)).toEqual([9, 8, 7, 6]);
    });

    it("owned multi-chunk flush copies — fast path is single-chunk only", () => {
      const deps = createDeps();
      const batcher = new PortBatcher(deps);

      const a = ownedBytes("foo");
      const b = ownedBytes("bar");
      batcher.write("t1", a, 3, true);
      batcher.write("t1", b, 3, true); // second chunk → throughput, multi-chunk
      vi.runAllTimers();

      const postMessage = deps.postMessage as ReturnType<typeof vi.fn>;
      const emitted = postMessage.mock.calls[0][1] as Uint8Array;

      expect(emitted).not.toBe(a);
      expect(emitted.buffer).not.toBe(a.buffer);
      expect(emitted.byteLength).toBe(6);
      expect(Buffer.from(emitted).toString("utf8")).toBe("foobar");
    });

    it("owned + non-owned writes to the same terminal still concatenate correctly", () => {
      // Two writes accumulate into one multi-chunk entry, so the fast path
      // (single-chunk only) never engages regardless of the owned flags — the
      // merge must still produce a correct fresh contiguous copy. (The
      // `entry.owned &&= owned` accumulation is defensive: a single-chunk entry
      // only ever has one write, so it has no observable effect today; it
      // guards a future fast path that might span multiple chunks.)
      const deps = createDeps();
      const batcher = new PortBatcher(deps);

      const a = ownedBytes("aa");
      const b = ownedBytes("bb");
      batcher.write("t1", a, 2, true);
      batcher.write("t1", b, 2, false);
      vi.runAllTimers();

      const postMessage = deps.postMessage as ReturnType<typeof vi.fn>;
      const emitted = postMessage.mock.calls[0][1] as Uint8Array;

      expect(emitted.buffer).not.toBe(a.buffer);
      expect(Buffer.from(emitted).toString("utf8")).toBe("aabb");
    });

    it("owned zero-length chunk fast-paths without breaking ACK accounting", () => {
      // A 0-byte owned chunk satisfies the predicate (byteOffset 0,
      // byteLength 0 === buffer.byteLength) — it must pass through cleanly and
      // ACK exactly 0 bytes, not crash or miscount.
      const deps = createDeps();
      const batcher = new PortBatcher(deps);

      const empty = new Uint8Array(0);
      batcher.write("t1", empty, 0, true);
      vi.runAllTimers();

      const postMessage = deps.postMessage as ReturnType<typeof vi.fn>;
      expect(postMessage).toHaveBeenCalledOnce();
      const [, emitted, ackBytes] = postMessage.mock.calls[0];
      expect(emitted).toBe(empty);
      expect((emitted as Uint8Array).byteLength).toBe(0);
      expect(ackBytes).toBe(0);
    });
  });

  describe("per-terminal isolation", () => {
    it("quiet terminal is not stalled by a busy sibling's throughput cadence", () => {
      // Regression for #7652: previously a single class-level mode meant t1 entering
      // throughput would force t2's first write to inherit the 16ms cadence. With per-
      // terminal state, t2 schedules its own setImmediate and flushes before 16ms.
      const deps = createDeps();
      const batcher = new PortBatcher(deps);

      // t1 enters throughput mode (setTimeout 16ms)
      batcher.write("t1", bytes("a1"), 2);
      batcher.write("t1", bytes("a2"), 2);

      // t2's first write should schedule its own setImmediate (latency), not inherit
      // t1's throughput cadence.
      batcher.write("t2", bytes("b1"), 2);

      // Two pending timers: t1's setTimeout(16) + t2's setImmediate
      expect(vi.getTimerCount()).toBe(2);
      expect(deps.postMessage).not.toHaveBeenCalled();

      // Advance 0ms drains pending setImmediate handles without advancing the 16ms
      // setTimeout — Vitest treats setImmediate as a 0-delay timer. (Use this rather
      // than runAllTimers so the test fails if t2 was scheduled with setTimeout(16)
      // instead of setImmediate.) t2's setImmediate fires → global flush drains both.
      vi.advanceTimersByTime(0);

      expect(deps.postMessage).toHaveBeenCalledTimes(2);
      expect(deps.postMessage).toHaveBeenCalledWith("t2", bytes("b1"), 2);
      expect(deps.postMessage).toHaveBeenCalledWith("t1", bytes("a1a2"), 4);
      expect(vi.getTimerCount()).toBe(0);
    });

    it("each terminal upgrades to throughput independently", () => {
      const deps = createDeps();
      const batcher = new PortBatcher(deps);

      batcher.write("t1", bytes("a1"), 2); // t1: setImmediate
      batcher.write("t1", bytes("a2"), 2); // t1: setTimeout(16)
      batcher.write("t2", bytes("b1"), 2); // t2: setImmediate
      batcher.write("t2", bytes("b2"), 2); // t2: setTimeout(16)

      // Each terminal owns its own setTimeout(16)
      expect(vi.getTimerCount()).toBe(2);
      expect(deps.postMessage).not.toHaveBeenCalled();

      // First timer to fire (16ms) calls global flush(), draining both
      vi.advanceTimersByTime(16);
      expect(deps.postMessage).toHaveBeenCalledTimes(2);
      expect(deps.postMessage).toHaveBeenCalledWith("t1", bytes("a1a2"), 4);
      expect(deps.postMessage).toHaveBeenCalledWith("t2", bytes("b1b2"), 4);
      expect(vi.getTimerCount()).toBe(0);
    });

    it("dispose cancels per-terminal timers across all entries", () => {
      const deps = createDeps();
      const batcher = new PortBatcher(deps);

      batcher.write("t1", bytes("a"), 1); // t1: setImmediate
      batcher.write("t2", bytes("b1"), 2); // t2: setImmediate
      batcher.write("t2", bytes("b2"), 2); // t2: setTimeout(16)

      // t1 setImmediate + t2 setTimeout
      expect(vi.getTimerCount()).toBe(2);

      batcher.dispose();
      expect(vi.getTimerCount()).toBe(0);
    });

    it("flushTerminal cancels only the target's timer, leaving siblings pending", () => {
      const deps = createDeps();
      const batcher = new PortBatcher(deps);

      batcher.write("t1", bytes("a1"), 2); // t1: setImmediate
      batcher.write("t1", bytes("a2"), 2); // t1: setTimeout(16)
      batcher.write("t2", bytes("b"), 1); // t2: setImmediate

      // t1's setTimeout(16) + t2's setImmediate
      expect(vi.getTimerCount()).toBe(2);

      batcher.flushTerminal("t1");
      expect(deps.postMessage).toHaveBeenCalledWith("t1", bytes("a1a2"), 4);
      // t2's setImmediate is still pending
      expect(vi.getTimerCount()).toBe(1);

      vi.advanceTimersByTime(0);
      expect(deps.postMessage).toHaveBeenCalledWith("t2", bytes("b"), 1);
      expect(vi.getTimerCount()).toBe(0);
    });
  });
});
