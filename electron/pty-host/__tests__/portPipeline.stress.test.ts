import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { PortBatcher, setPortBatchThroughputDelayMs } from "../portBatcher.js";
import { PortQueueManager } from "../portQueue.js";
import { PtyPauseCoordinator } from "../PtyPauseCoordinator.js";
import {
  IPC_MAX_QUEUE_BYTES,
  IPC_HIGH_WATERMARK_PERCENT,
  IPC_LOW_WATERMARK_PERCENT,
  PORT_BATCH_THRESHOLD_BYTES,
  PORT_BATCH_THROUGHPUT_DELAY_MS,
} from "../../services/pty/types.js";
import type { TerminalReliabilityMetricPayload } from "../../../shared/types/pty-host.js";

/**
 * Deterministic stress tests over the REAL per-window output pipeline —
 * PortBatcher → PortQueueManager → PtyPauseCoordinator wired exactly like
 * `electron/pty-host.ts` wires them per renderer connection. The unit suites
 * (portBatcher.test.ts, portQueue.test.ts) each mock the other component;
 * these tests exist to prove the composed behavior under heavy multi-terminal
 * output: batching preserves per-terminal byte order, the focused pane's
 * latency privilege survives sibling floods, watermark pauses engage and
 * ack-driven resume actually releases the PTY, and teardown paths leak
 * neither bytes nor pause holds.
 */

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const HIGH_WATERMARK_BYTES = (IPC_MAX_QUEUE_BYTES * IPC_HIGH_WATERMARK_PERCENT) / 100;
const LOW_WATERMARK_BYTES = (IPC_MAX_QUEUE_BYTES * IPC_LOW_WATERMARK_PERCENT) / 100;

interface PostedBatch {
  id: string;
  data: Uint8Array;
  bytes: number;
}

interface SimulatedWindow {
  windowId: number;
  batcher: PortBatcher;
  queueManager: PortQueueManager;
  posted: PostedBatch[];
  statusEvents: Array<{ id: string; status: string }>;
  metrics: TerminalReliabilityMetricPayload[];
  /** Simulate the renderer acking one posted batch (xterm write completed). */
  ack: (batch: PostedBatch) => void;
}

interface SimulatedTerminal {
  rawPause: ReturnType<typeof vi.fn>;
  rawResume: ReturnType<typeof vi.fn>;
  coordinator: PtyPauseCoordinator;
}

function createHarness() {
  const terminals = new Map<string, SimulatedTerminal>();
  const windows: SimulatedWindow[] = [];
  let focusedByWindow = new Map<number, string | null>();

  function getOrCreateTerminal(id: string): SimulatedTerminal {
    let t = terminals.get(id);
    if (!t) {
      const rawPause = vi.fn();
      const rawResume = vi.fn();
      t = {
        rawPause,
        rawResume,
        coordinator: new PtyPauseCoordinator({ pause: rawPause, resume: rawResume }),
      };
      terminals.set(id, t);
    }
    return t;
  }

  function addWindow(windowId: number): SimulatedWindow {
    const posted: PostedBatch[] = [];
    const statusEvents: Array<{ id: string; status: string }> = [];
    const metrics: TerminalReliabilityMetricPayload[] = [];
    const queueManager = new PortQueueManager({
      getTerminal: (id) =>
        terminals.has(id) ? { ptyProcess: { pause: vi.fn(), resume: vi.fn() } } : undefined,
      getPauseCoordinator: (id) => terminals.get(id)?.coordinator,
      sendEvent: vi.fn(),
      metricsEnabled: () => true,
      emitTerminalStatus: (id, status) => {
        statusEvents.push({ id, status });
      },
      emitReliabilityMetric: (payload) => {
        metrics.push(payload);
      },
      pauseToken: `port-queue-${windowId}`,
      getFocusedTerminalId: () => focusedByWindow.get(windowId) ?? null,
    });
    const batcher = new PortBatcher({
      portQueueManager: queueManager,
      getFocusedTerminalId: () => focusedByWindow.get(windowId) ?? null,
      postMessage: (id, data, bytes) => {
        posted.push({ id, data, bytes });
      },
      onError: (error) => {
        throw error;
      },
    });
    const win: SimulatedWindow = {
      windowId,
      batcher,
      queueManager,
      posted,
      statusEvents,
      metrics,
      ack: (batch) => {
        queueManager.removeBytes(batch.id, batch.bytes);
        queueManager.tryResume(batch.id);
      },
    };
    windows.push(win);
    return win;
  }

  /**
   * Pump one PTY chunk through the same routing the host's data handler uses:
   * every window is a target (no project filter in these tests), `owned` is
   * true only for a sole target, and a rejecting batcher marks the window
   * saturated. Returns the windows that rejected the chunk.
   */
  function pump(id: string, text: string, interactive = false): SimulatedWindow[] {
    getOrCreateTerminal(id);
    const chunk = encoder.encode(text);
    const owned = windows.length === 1;
    const saturated: SimulatedWindow[] = [];
    for (const win of windows) {
      if (!win.batcher.write(id, chunk, chunk.byteLength, owned, interactive)) {
        saturated.push(win);
      }
    }
    return saturated;
  }

  return {
    terminals,
    windows,
    addWindow,
    pump,
    getOrCreateTerminal,
    setFocused: (windowId: number, id: string | null) => {
      focusedByWindow.set(windowId, id);
    },
    reset: () => {
      focusedByWindow = new Map();
    },
  };
}

function concatPosted(posted: PostedBatch[], id: string): string {
  const parts: Uint8Array[] = posted.filter((p) => p.id === id).map((p) => p.data);
  const total = parts.reduce((sum, p) => sum + p.byteLength, 0);
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    merged.set(part, offset);
    offset += part.byteLength;
  }
  return decoder.decode(merged);
}

describe("port pipeline stress (real batcher + queue + coordinator)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    setPortBatchThroughputDelayMs(PORT_BATCH_THROUGHPUT_DELAY_MS);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("focused terminal's batch posts ahead of five flooding siblings", () => {
    const harness = createHarness();
    const win = harness.addWindow(1);
    harness.setFocused(1, "t-focus");

    // Siblings write first (their per-terminal immediates are scheduled
    // first); the focused terminal writes LAST. The first flush still posts
    // the focused entry first.
    for (let i = 0; i < 5; i++) {
      harness.pump(`t${i}`, `sibling-${i}-`.repeat(20));
    }
    harness.pump("t-focus", "focused-output");

    vi.runAllTimers();

    expect(win.posted.length).toBeGreaterThanOrEqual(6);
    expect(win.posted[0]!.id).toBe("t-focus");
    expect(concatPosted(win.posted, "t-focus")).toBe("focused-output");
  });

  it("interactive echo accelerates the focused batch without reordering its earlier chunks", () => {
    const harness = createHarness();
    const win = harness.addWindow(1);
    harness.setFocused(1, "t-focus");

    // Focused terminal escalates to throughput mode (two writes), siblings
    // flood alongside. The echo write swaps the 16ms timer for an immediate.
    harness.pump("t-focus", "aaa");
    harness.pump("t-focus", "bbb");
    harness.pump("t1", "noise-1");
    harness.pump("t1", "noise-2");
    harness.pump("t-focus", "x", true);

    // One macrotask tick — well before the 16ms throughput window.
    vi.advanceTimersByTime(1);

    const focusedBatches = win.posted.filter((p) => p.id === "t-focus");
    expect(focusedBatches).toHaveLength(1);
    // Earlier queued chunks land ahead of the echo byte — accelerated, never
    // reordered.
    expect(decoder.decode(focusedBatches[0]!.data)).toBe("aaabbbx");
    expect(win.posted[0]!.id).toBe("t-focus");

    // The swapped-out throughput timer must not double-post.
    vi.advanceTimersByTime(PORT_BATCH_THROUGHPUT_DELAY_MS + 1);
    expect(win.posted.filter((p) => p.id === "t-focus")).toHaveLength(1);
  });

  it("per-terminal byte order survives an interleaved flood with threshold flushes and odd chunk shapes", () => {
    const harness = createHarness();
    const win = harness.addWindow(1);

    // Interleave two terminals with adversarial chunk shapes: zero-byte,
    // 1-byte, multibyte UTF-8, and 64KB slabs that trip the synchronous
    // threshold flush mid-stream.
    const written = new Map<string, string>([
      ["t1", ""],
      ["t2", ""],
    ]);
    const shapes = [
      "",
      "x",
      "⚠…emoji😀",
      "y".repeat(1024),
      "z".repeat(PORT_BATCH_THRESHOLD_BYTES),
      "小さなチャンク",
      "",
      "w".repeat(64),
    ];
    for (let round = 0; round < 12; round++) {
      for (const id of ["t1", "t2"]) {
        const text = `${id}:${round}:${shapes[(round + (id === "t2" ? 3 : 0)) % shapes.length]};`;
        written.set(id, written.get(id)! + text);
        harness.pump(id, text);
      }
    }
    vi.runAllTimers();

    // Byte-identical reassembly per terminal — no loss, duplication, or
    // cross-terminal reordering, regardless of how batches were cut.
    expect(concatPosted(win.posted, "t1")).toBe(written.get("t1"));
    expect(concatPosted(win.posted, "t2")).toBe(written.get("t2"));

    // Accounting matches delivery exactly: every posted byte is in the ledger.
    const postedBytes = win.posted.reduce((sum, p) => sum + p.bytes, 0);
    expect(win.queueManager.getTotalQueuedBytes()).toBe(postedBytes);
  });

  it("a sustained flood pauses the PTY once at the watermark and acks resume it", () => {
    const harness = createHarness();
    const win = harness.addWindow(1);

    // 40 × 64KB = 2.5MB — crosses the ~2MB per-terminal high watermark. Each
    // 64KB write trips the batcher's synchronous threshold flush, charging
    // the real ledger as it goes.
    const chunk = "f".repeat(PORT_BATCH_THRESHOLD_BYTES);
    for (let i = 0; i < 40; i++) {
      harness.pump("t1", chunk);
    }
    // Advance only past the batch window — running ALL timers would also fire
    // the 10s safety timeout and force-resume the pause under test.
    vi.advanceTimersByTime(PORT_BATCH_THROUGHPUT_DELAY_MS + 4);

    const terminal = harness.terminals.get("t1")!;
    expect(win.queueManager.isPaused("t1")).toBe(true);
    // The raw PTY pause fired exactly once (coordinator dedupes holds).
    expect(terminal.rawPause).toHaveBeenCalledTimes(1);
    expect(terminal.rawResume).not.toHaveBeenCalled();
    expect(win.statusEvents).toContainEqual({ id: "t1", status: "paused-backpressure" });
    expect(win.queueManager.getQueuedBytes("t1")).toBeGreaterThan(HIGH_WATERMARK_BYTES);

    // The renderer drains: ack each posted batch in FIFO order. The resume
    // must fire as soon as the ledger crosses the low watermark.
    for (const batch of win.posted) {
      win.ack(batch);
    }
    expect(win.queueManager.getQueuedBytes("t1")).toBe(0);
    expect(win.queueManager.isPaused("t1")).toBe(false);
    expect(terminal.rawResume).toHaveBeenCalledTimes(1);
    expect(win.statusEvents).toContainEqual({ id: "t1", status: "running" });
    expect(win.queueManager.getQueuedBytes("t1")).toBeLessThan(LOW_WATERMARK_BYTES);
  });

  it("terminal exit with batched data still pending delivers the tail and leaves no holds", () => {
    const harness = createHarness();
    const win = harness.addWindow(1);

    harness.pump("t1", "final-output-before-exit");
    // Exit arrives before any flush timer fires — mimic the host's exit
    // handler: flush the batcher's tail, then clear the queue accounting.
    win.batcher.flushTerminal("t1");
    win.queueManager.clearQueue("t1");

    expect(concatPosted(win.posted, "t1")).toBe("final-output-before-exit");
    expect(win.queueManager.getQueuedBytes("t1")).toBe(0);
    expect(win.queueManager.getTotalQueuedBytes()).toBe(0);
    expect(harness.terminals.get("t1")!.coordinator.isPaused).toBe(false);
  });

  it("a saturated window rejects while its sibling window keeps accepting", () => {
    const harness = createHarness();
    const winA = harness.addWindow(1);
    const winB = harness.addWindow(2);

    // Window B's renderer has stalled: its ledger for t1 sits at capacity.
    winB.queueManager.addBytes("t1", IPC_MAX_QUEUE_BYTES);

    const saturated = harness.pump("t1", "live-output");
    vi.runAllTimers();

    // Only window B rejected — exactly the per-window outcome the host uses
    // to decide who gets the data-loss pulse.
    expect(saturated.map((w) => w.windowId)).toEqual([2]);
    expect(concatPosted(winA.posted, "t1")).toBe("live-output");
    expect(winB.posted).toHaveLength(0);

    // B's renderer recovers (acks its backlog) — the next chunk flows again.
    winB.queueManager.removeBytes("t1", IPC_MAX_QUEUE_BYTES);
    const saturatedAfter = harness.pump("t1", "-recovered");
    vi.runAllTimers();
    expect(saturatedAfter).toHaveLength(0);
    expect(concatPosted(winB.posted, "t1")).toBe("-recovered");
    // Window A received both chunks in order.
    expect(concatPosted(winA.posted, "t1")).toBe("live-output-recovered");
  });

  it("a resource-governor hold outlives the port-queue resume (multi-source pause)", () => {
    const harness = createHarness();
    const win = harness.addWindow(1);
    const terminal = harness.getOrCreateTerminal("t1");

    // The governor pauses first (memory pressure), then the window's queue
    // crosses its watermark and takes its own hold.
    terminal.coordinator.pause("resource-governor");
    expect(terminal.rawPause).toHaveBeenCalledTimes(1);

    const chunk = "g".repeat(PORT_BATCH_THRESHOLD_BYTES);
    for (let i = 0; i < 40; i++) {
      harness.pump("t1", chunk);
    }
    vi.advanceTimersByTime(PORT_BATCH_THROUGHPUT_DELAY_MS + 4);
    expect(win.queueManager.isPaused("t1")).toBe(true);
    // Second hold on an already-paused coordinator does not double-pause.
    expect(terminal.rawPause).toHaveBeenCalledTimes(1);

    // The renderer drains fully — the port-queue hold releases, but the PTY
    // must stay paused (governor still holds) and no "running" status leaks.
    for (const batch of win.posted) {
      win.ack(batch);
    }
    expect(win.queueManager.isPaused("t1")).toBe(false);
    expect(terminal.rawResume).not.toHaveBeenCalled();
    expect(terminal.coordinator.isPaused).toBe(true);
    expect(win.statusEvents).not.toContainEqual({ id: "t1", status: "running" });

    // Governor pressure clears — NOW the PTY resumes.
    terminal.coordinator.resume("resource-governor");
    expect(terminal.rawResume).toHaveBeenCalledTimes(1);
  });

  it("window teardown mid-pause releases the PTY and surfaces the release", () => {
    const harness = createHarness();
    const win = harness.addWindow(1);

    const chunk = "d".repeat(PORT_BATCH_THRESHOLD_BYTES);
    for (let i = 0; i < 40; i++) {
      harness.pump("t1", chunk);
    }
    vi.advanceTimersByTime(PORT_BATCH_THROUGHPUT_DELAY_MS + 4);
    const terminal = harness.terminals.get("t1")!;
    expect(win.queueManager.isPaused("t1")).toBe(true);

    // LRU eviction / project close: the window goes away with acks pending.
    // Mimic disconnectWindow: resumeAll, then dispose.
    win.queueManager.resumeAll();
    win.queueManager.dispose();
    win.batcher.dispose();

    expect(terminal.rawResume).toHaveBeenCalledTimes(1);
    expect(terminal.coordinator.isPaused).toBe(false);
    // The release is surfaced (stuck-pill regression) with a pause-end metric.
    expect(win.statusEvents).toContainEqual({ id: "t1", status: "running" });
    expect(win.metrics.some((m) => m.terminalId === "t1" && m.metricType === "pause-end")).toBe(
      true
    );
    expect(win.queueManager.getTotalQueuedBytes()).toBe(0);
  });

  it("32 terminals flooding one window: every byte accounted, aggregate gate holds, sweep releases", () => {
    const harness = createHarness();
    const win = harness.addWindow(1);
    harness.setFocused(1, "t0");

    // 32 terminals × 40 × 16KB ≈ 20MB across the window — far over the 16MB
    // aggregate gate. Terminals stay below their OWN ~2MB watermark (640KB
    // each), so every pause in this test is aggregate-driven.
    const chunk = "m".repeat(16 * 1024);
    for (let round = 0; round < 40; round++) {
      for (let t = 0; t < 32; t++) {
        harness.pump(`t${t}`, chunk);
      }
    }
    vi.advanceTimersByTime(PORT_BATCH_THROUGHPUT_DELAY_MS + 4);

    // The focused terminal is exempt from the aggregate gate.
    expect(win.queueManager.isPaused("t0")).toBe(false);
    const pausedCount = [...Array(32).keys()].filter((t) =>
      win.queueManager.isPaused(`t${t}`)
    ).length;
    expect(pausedCount).toBeGreaterThan(0);

    // Nothing was lost on the way in: ledger total equals posted total.
    const postedBytes = win.posted.reduce((sum, p) => sum + p.bytes, 0);
    expect(win.queueManager.getTotalQueuedBytes()).toBe(postedBytes);

    // The renderer acks everything — every pause releases, every raw PTY
    // resume fires, the ledger returns to zero.
    for (const batch of win.posted) {
      win.ack(batch);
    }
    expect(win.queueManager.getTotalQueuedBytes()).toBe(0);
    for (let t = 0; t < 32; t++) {
      expect(win.queueManager.isPaused(`t${t}`)).toBe(false);
      expect(harness.terminals.get(`t${t}`)!.coordinator.isPaused).toBe(false);
    }
  });
});
