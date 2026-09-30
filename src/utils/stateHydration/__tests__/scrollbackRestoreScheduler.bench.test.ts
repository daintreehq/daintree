// Benchmark for startup scrollback restore concurrency.
// Prints metrics with RESTORE_CONCURRENCY_BENCH=1; the assertions pin the shape.
//
// 20 restored terminals, the focused one LAST in list order. Each restore runs
// the real TerminalRestoreController against a real @xterm/headless terminal,
// so snapshot parsing competes for the one thread exactly as xterm's write
// buffers do in the renderer. getSerializedState is served by a simulated
// pty-host: one FIFO serializer whose service time scales with payload size,
// plus fixed IPC latency each way.
//
// Measured per run (median of RUNS):
// - maxInFlight: peak concurrent getSerializedState requests
// - focusedFetchMs: schedule → focused pane's snapshot request issued
// - focusedPaintMs: schedule → focused pane's snapshot fully parsed by xterm
// - visiblePaintMs: schedule → every on-screen pane's snapshot fully parsed
// - allParsedMs: schedule → every pane's snapshot fully parsed
import { afterEach, describe, expect, it, vi } from "vitest";
import { Terminal } from "@xterm/headless";
import type { SerializedTerminalSnapshot } from "@shared/types/terminal";

vi.mock("@/utils/logger", () => ({
  logWarn: vi.fn(),
  logError: vi.fn(),
  logInfo: vi.fn(),
  logDebug: vi.fn(),
}));

// Chromium exposes scheduler.postTask / scheduler.yield; Node doesn't, and the
// controller's setTimeout(10 ms) yield fallback would dominate the timings.
const macrotask = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
vi.stubGlobal("scheduler", {
  postTask: (cb: () => void) => macrotask().then(cb),
  yield: macrotask,
});

const IPC_LATENCY_MS = 2;
const HOST_BASE_MS = 1;
const HOST_MS_PER_256KB = 6;

interface HostRequest {
  id: string;
  resolve: (snapshot: SerializedTerminalSnapshot | null) => void;
}

const host = {
  payloads: new Map<string, string>(),
  queue: [] as HostRequest[],
  busy: false,
  inFlight: 0,
  maxInFlight: 0,
  requestedAt: new Map<string, number>(),
  requestOrder: [] as string[],
};

function pumpHost(): void {
  if (host.busy) return;
  const next = host.queue.shift();
  if (!next) return;
  host.busy = true;
  const data = host.payloads.get(next.id) ?? "";
  const serviceMs = HOST_BASE_MS + (data.length / 262144) * HOST_MS_PER_256KB;
  setTimeout(() => {
    host.busy = false;
    setTimeout(() => {
      host.inFlight--;
      next.resolve({ data, cols: COLS, rows: ROWS });
    }, IPC_LATENCY_MS);
    pumpHost();
  }, serviceMs);
}

vi.mock("@/clients", () => ({
  terminalClient: {
    getSerializedState: (id: string) =>
      new Promise<SerializedTerminalSnapshot | null>((resolve) => {
        host.inFlight++;
        host.maxInFlight = Math.max(host.maxInFlight, host.inFlight);
        host.requestedAt.set(id, performance.now());
        host.requestOrder.push(id);
        setTimeout(() => {
          host.queue.push({ id, resolve });
          pumpHost();
        }, IPC_LATENCY_MS);
      }),
  },
}));

const COLS = 200;
const ROWS = 50;

type BenchManaged = Record<string, unknown> & {
  terminal: Terminal;
  scrollbackRestoreState: "none" | "pending" | "in-progress" | "done";
  isFocused: boolean;
  isVisible: boolean;
};

const instances = new Map<string, BenchManaged>();
const restoreReturned = new Map<string, number>();
let focusedPanelId: string | null = null;

const { TerminalRestoreController } = await import("@/services/terminal/TerminalRestoreController");
const controller = new TerminalRestoreController({
  getInstance: (id) => instances.get(id) as never,
  writeData: () => {},
});

vi.mock("@/services/TerminalInstanceService", () => ({
  terminalInstanceService: {
    get: (id: string) => instances.get(id),
    fetchAndRestore: async (id: string) => {
      const result = await controller.fetchAndRestore(id);
      restoreReturned.set(id, performance.now());
      return result;
    },
    notifyRestoreSettledWaiters: () => {},
    notifyScrollbackRestoreListeners: () => {},
    addInstanceDestroyedListener: () => () => {},
  },
}));

vi.mock("@/store", () => ({
  usePanelStore: {
    getState: () => ({
      focusedId: focusedPanelId,
      setScrollbackRestoreError: () => {},
      clearScrollbackRestoreError: () => {},
    }),
    subscribe: () => () => {},
  },
}));

const { scheduleScrollbackRestore, resetScrollbackRestoreBatch } =
  await import("../scrollbackRestoreScheduler");

const PRINT = process.env.RESTORE_CONCURRENCY_BENCH === "1";
const RUNS = Number(process.env.RESTORE_CONCURRENCY_RUNS ?? (PRINT ? 5 : 1));
const TERMINALS = 20;
const VISIBLE = 4;
const FOCUSED_BYTES = Number(process.env.RESTORE_CONCURRENCY_FOCUSED_KB ?? 200) * 1024;
// Mostly below the 256 KB incremental threshold (synchronous replay path),
// with a few large agent transcripts on the chunked incremental path.
const SIZE_CYCLE = [96, 160, 220, 250, 600].map((kb) => kb * 1024);

function makePayload(bytes: number, seed: number): string {
  const parts: string[] = [];
  let len = 0;
  let line = 0;
  while (len < bytes) {
    const color = 31 + ((seed + line) % 7);
    const text = `${seed}:${line} `.padEnd(
      COLS - 8,
      String.fromCharCode(97 + ((seed + line) % 26))
    );
    const row = `\x1b[${color}m${text.slice(0, 40)}\x1b[0m${text.slice(40)}\r\n`;
    parts.push(row);
    len += row.length;
    line++;
  }
  return parts.join("").slice(0, bytes);
}

function makeManaged(): BenchManaged {
  const terminal = new Terminal({
    cols: COLS,
    rows: ROWS,
    scrollback: 5000,
    allowProposedApi: true,
  });
  return {
    terminal,
    isOpened: true,
    targetCols: COLS,
    targetRows: ROWS,
    restoreGeneration: 0,
    restoreWindowToken: 0,
    isSerializedRestoreInProgress: false,
    isUserScrolledBack: false,
    deferredOutput: [],
    writeChain: Promise.resolve(),
    hasReceivedOutput: false,
    scrollbackRestoreState: "none",
    isFocused: false,
    isVisible: false,
  };
}

function waitParsed(terminal: Terminal): Promise<number> {
  return new Promise((resolve) => terminal.write("", () => resolve(performance.now())));
}

interface RunResult {
  maxInFlight: number;
  focusedFetchMs: number;
  focusedPaintMs: number;
  visiblePaintMs: number;
  allParsedMs: number;
  requestOrder: string[];
}

const POLL_INTERVAL_MS = 1;

async function waitUntil(predicate: () => boolean, timeoutMs = 30_000): Promise<void> {
  const start = performance.now();
  while (!predicate()) {
    if (performance.now() - start > timeoutMs) throw new Error("bench timed out");
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
}

async function runOnce(): Promise<RunResult> {
  instances.clear();
  restoreReturned.clear();
  host.payloads.clear();
  host.requestedAt.clear();
  host.requestOrder = [];
  host.queue = [];
  host.inFlight = 0;
  host.maxInFlight = 0;
  resetScrollbackRestoreBatch();

  const ids: string[] = [];
  for (let i = 0; i < TERMINALS; i++) {
    const id = `t${i}`;
    ids.push(id);
    const managed = makeManaged();
    instances.set(id, managed);
    const isFocused = i === TERMINALS - 1;
    host.payloads.set(
      id,
      makePayload(isFocused ? FOCUSED_BYTES : SIZE_CYCLE[i % SIZE_CYCLE.length]!, i)
    );
    // Focused pane is last in list order; three other panes share the grid.
    managed.isVisible = isFocused || i < VISIBLE - 1;
    managed.isFocused = isFocused;
  }
  const focusedId = ids[TERMINALS - 1]!;
  focusedPanelId = focusedId;

  const t0 = performance.now();
  scheduleScrollbackRestore(
    ids.map((id) => ({ terminalId: id, label: id, location: "grid" as const })),
    () => true
  );

  const visibleIds = ids.filter((id) => instances.get(id)!.isVisible);
  const visiblePainted = Promise.all(
    visibleIds.map(async (id) => {
      await waitUntil(() => restoreReturned.has(id));
      return waitParsed(instances.get(id)!.terminal);
    })
  );
  await waitUntil(() => restoreReturned.has(focusedId));
  const focusedPaint = await waitParsed(instances.get(focusedId)!.terminal);
  const visiblePaint = Math.max(...(await visiblePainted));

  await waitUntil(() => ids.every((id) => instances.get(id)!.scrollbackRestoreState === "done"));
  const parsedAt = await Promise.all(ids.map((id) => waitParsed(instances.get(id)!.terminal)));
  const allParsed = Math.max(...parsedAt);

  for (const id of ids) {
    const managed = instances.get(id)!;
    expect(managed.terminal.buffer.active.length).toBeGreaterThan(ROWS);
    managed.terminal.dispose();
  }

  return {
    maxInFlight: host.maxInFlight,
    focusedFetchMs: host.requestedAt.get(focusedId)! - t0,
    focusedPaintMs: focusedPaint - t0,
    visiblePaintMs: visiblePaint - t0,
    allParsedMs: allParsed - t0,
    requestOrder: [...host.requestOrder],
  };
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)]!;
}

afterEach(() => {
  instances.clear();
  focusedPanelId = null;
});

describe("scrollback restore concurrency benchmark", () => {
  it("restores the focused pane first with bounded snapshot concurrency", async () => {
    // Warm xterm's parser and the JIT so the first measured run isn't an outlier.
    await runOnce();
    const results: RunResult[] = [];
    for (let i = 0; i < RUNS; i++) results.push(await runOnce());

    const summary = {
      maxInFlight: median(results.map((r) => r.maxInFlight)),
      focusedFetchMs: median(results.map((r) => r.focusedFetchMs)),
      focusedPaintMs: median(results.map((r) => r.focusedPaintMs)),
      visiblePaintMs: median(results.map((r) => r.visiblePaintMs)),
      allParsedMs: median(results.map((r) => r.allParsedMs)),
    };
    if (PRINT) {
      process.stdout.write(
        "\n" +
          `[restore-concurrency] runs=${RUNS} ` +
          Object.entries(summary)
            .map(([k, v]) => `${k}=${typeof v === "number" ? v.toFixed(1) : v}`)
            .join(" ")
      );
    }

    for (const r of results) {
      expect(r.maxInFlight).toBeLessThanOrEqual(3);
      // Focused (last in list order) first, then the other on-screen panes.
      expect(r.requestOrder.slice(0, VISIBLE)).toEqual([
        `t${TERMINALS - 1}`,
        ...Array.from({ length: VISIBLE - 1 }, (_, i) => `t${i}`),
      ]);
      expect(r.requestOrder).toHaveLength(TERMINALS);
    }
  }, 120_000);
});
