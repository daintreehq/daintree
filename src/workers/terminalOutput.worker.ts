/**
 * TerminalOutputWorker - OFF-MAIN-THREAD SAB INGESTION
 *
 * PROTECTED INFRASTRUCTURE:
 * This worker polls SharedArrayBuffers (SAB) to ingest terminal output off the
 * main thread, preventing UI jank during high-throughput output.
 *
 * Do not remove the SAB polling loop or atomic wait logic.
 */

import { SharedRingBuffer, PacketParser } from "../../shared/utils/SharedRingBuffer.js";
import type {
  WorkerInboundMessage,
  WorkerOutboundMessage,
} from "../../shared/types/terminal-output-worker-messages.js";

const MAX_SAB_READ_BYTES = 256 * 1024;
const MAX_SAB_BYTES_PER_TICK = 2 * 1024 * 1024;
const MAX_READS_PER_TICK = 50;
const ATOMICS_WAIT_TIMEOUT_MS = 100;
const STANDARD_BATCH_POST_INTERVAL_MS = 8;
const INK_BATCH_POST_INTERVAL_MS = 25;
const INK_PATTERN_LOOKBACK_CHARS = 32;
const INK_ERASE_LINE_PATTERN = "\x1b[2K\x1b[1A";

let ringBuffers: SharedRingBuffer[] = [];
let signalView: Int32Array | null = null;
let lastSeenSignal = 0;
const packetParsers: PacketParser[] = [];
let isRunning = false;
type WorkerOutput = { id: string; data: string | Uint8Array };
let pendingOutputs: WorkerOutput[] = [];
let lastBatchPostTime = 0;
let batchTimeoutId: number | null = null;
let batchPostDeadline = 0;
let atomicsWaitSupported: boolean | null = null;
const scheduledDeadlines = new Map<number, number>();
const recentCharsByTerminal = new Map<string, string>();
let nextShardIndex = 0;

function scheduleTimeout(callback: () => void, delayMs: number): number {
  const now = getNow();
  const id = self.setTimeout(() => {
    scheduledDeadlines.delete(id);
    callback();
  }, delayMs) as unknown as number;
  scheduledDeadlines.set(id, now + delayMs);
  return id;
}

function clearScheduledTimeout(timeoutId: number): void {
  scheduledDeadlines.delete(timeoutId);
  self.clearTimeout(timeoutId);
}

function getNow(): number {
  return Date.now();
}

function getNextTimerDueInMs(): number | null {
  if (scheduledDeadlines.size === 0) return null;
  const now = getNow();
  let soonest = Number.POSITIVE_INFINITY;
  for (const when of scheduledDeadlines.values()) {
    if (when < soonest) soonest = when;
  }
  return Math.max(0, soonest - now);
}

function resetWorkerState(): void {
  if (batchTimeoutId !== null) {
    clearScheduledTimeout(batchTimeoutId);
    batchTimeoutId = null;
  }
  batchPostDeadline = 0;
  for (const timeoutId of scheduledDeadlines.keys()) {
    self.clearTimeout(timeoutId);
  }
  scheduledDeadlines.clear();
  pendingOutputs = [];
  lastBatchPostTime = 0;
  recentCharsByTerminal.clear();
  for (const parser of packetParsers) {
    parser.reset();
  }
  packetParsers.length = 0;
  ringBuffers = [];
  signalView = null;
  lastSeenSignal = 0;
  nextShardIndex = 0;
}

function scheduleBatchPost(delayMs: number): void {
  if (pendingOutputs.length === 0) return;

  const now = Date.now();
  const minIntervalDeadline = lastBatchPostTime + STANDARD_BATCH_POST_INTERVAL_MS;
  const targetDeadline = Math.max(minIntervalDeadline, now + delayMs);

  if (batchTimeoutId === null) {
    if (targetDeadline <= now) {
      postBatch();
      return;
    }
    batchPostDeadline = targetDeadline;
    batchTimeoutId = scheduleTimeout(() => {
      batchTimeoutId = null;
      batchPostDeadline = 0;
      postBatch();
    }, targetDeadline - now);
    return;
  }

  if (targetDeadline > batchPostDeadline) {
    clearScheduledTimeout(batchTimeoutId);
    batchPostDeadline = targetDeadline;
    batchTimeoutId = scheduleTimeout(() => {
      batchTimeoutId = null;
      batchPostDeadline = 0;
      postBatch();
    }, targetDeadline - now);
  }
}

function postBatch(): void {
  if (batchTimeoutId !== null) {
    clearScheduledTimeout(batchTimeoutId);
    batchTimeoutId = null;
  }
  batchPostDeadline = 0;

  if (pendingOutputs.length === 0) return;

  const batches = pendingOutputs.splice(0);
  lastBatchPostTime = Date.now();

  const message: WorkerOutboundMessage = {
    type: "OUTPUT_BATCH",
    batches,
  };
  self.postMessage(message);
}

function detectInkRedrawPattern(id: string, data: string | Uint8Array): boolean {
  if (typeof data !== "string") return false;
  const previous = recentCharsByTerminal.get(id) ?? "";
  const combined = previous + data;
  recentCharsByTerminal.set(id, combined.slice(-INK_PATTERN_LOOKBACK_CHARS));
  return combined.includes(INK_ERASE_LINE_PATTERN);
}

function drainRingBuffer(): boolean {
  if (ringBuffers.length === 0) return false;

  let hasData = false;
  let hasOutput = false;
  let postDelayMs = STANDARD_BATCH_POST_INTERVAL_MS;
  let reads = 0;
  let bytesReadThisTick = 0;
  let consecutiveEmptyShards = 0;

  while (reads < MAX_READS_PER_TICK && bytesReadThisTick < MAX_SAB_BYTES_PER_TICK) {
    const remainingBudget = MAX_SAB_BYTES_PER_TICK - bytesReadThisTick;
    if (remainingBudget <= 0) break;

    const shardIndex = nextShardIndex % ringBuffers.length;
    const shard = ringBuffers[shardIndex];
    const parser = packetParsers[shardIndex];
    nextShardIndex = (nextShardIndex + 1) % ringBuffers.length;

    const perReadBudget = Math.min(MAX_SAB_READ_BYTES, remainingBudget);
    const data = shard.readUpTo(perReadBudget);

    if (!data) {
      consecutiveEmptyShards += 1;
      if (consecutiveEmptyShards >= ringBuffers.length) {
        break;
      }
      continue;
    }

    hasData = true;
    consecutiveEmptyShards = 0;
    reads += 1;
    bytesReadThisTick += data.byteLength;

    const packets = parser.parse(data);
    for (const packet of packets) {
      pendingOutputs.push({ id: packet.id, data: packet.data });
      if (detectInkRedrawPattern(packet.id, packet.data)) {
        postDelayMs = INK_BATCH_POST_INTERVAL_MS;
      }
      hasOutput = true;
    }
  }

  if (hasOutput) {
    scheduleBatchPost(postDelayMs);
  }

  return hasData;
}

function mainLoop(): void {
  if (!isRunning || ringBuffers.length === 0 || !signalView) return;

  const hasData = drainRingBuffer();

  if (hasData) {
    lastSeenSignal = Atomics.load(signalView, 0);
    scheduleTimeout(mainLoop, 0);
    return;
  }

  const currentSignal = Atomics.load(signalView, 0);
  if (currentSignal !== lastSeenSignal) {
    lastSeenSignal = currentSignal;
    scheduleTimeout(mainLoop, 0);
    return;
  }

  const nextDue = getNextTimerDueInMs();
  const waitMs = Math.min(ATOMICS_WAIT_TIMEOUT_MS, nextDue ?? ATOMICS_WAIT_TIMEOUT_MS);

  try {
    if (atomicsWaitSupported !== false) {
      const result = Atomics.wait(signalView, 0, lastSeenSignal, waitMs);
      atomicsWaitSupported = true;

      if (result === "ok" || result === "not-equal") {
        lastSeenSignal = Atomics.load(signalView, 0);
      }
    }
  } catch {
    if (atomicsWaitSupported !== false) {
      console.warn("[TerminalOutputWorker] Atomics.wait not supported, using polling fallback");
    }
    atomicsWaitSupported = false;
  }

  scheduleTimeout(mainLoop, atomicsWaitSupported === false ? waitMs : 0);
}

self.onmessage = (event: MessageEvent<WorkerInboundMessage>) => {
  const message = event.data;

  switch (message.type) {
    case "INIT_BUFFER": {
      resetWorkerState();
      ringBuffers = message.buffers.map((buf) => new SharedRingBuffer(buf));
      signalView = new Int32Array(message.signalBuffer);
      lastSeenSignal = Atomics.load(signalView, 0);

      for (let i = 0; i < ringBuffers.length; i++) {
        packetParsers.push(new PacketParser());
      }

      isRunning = true;
      mainLoop();
      break;
    }

    case "SET_INTERACTIVE":
    case "SET_DIRECT_MODE":
      break;

    case "RESET_TERMINAL": {
      pendingOutputs = pendingOutputs.filter((output) => output.id !== message.id);
      recentCharsByTerminal.delete(message.id);
      if (pendingOutputs.length === 0 && batchTimeoutId !== null) {
        clearScheduledTimeout(batchTimeoutId);
        batchTimeoutId = null;
        batchPostDeadline = 0;
      }
      break;
    }

    case "FLUSH_TERMINAL": {
      postBatch();
      break;
    }

    case "STOP": {
      isRunning = false;
      postBatch();
      resetWorkerState();
      break;
    }

    default: {
      console.warn(
        "[TerminalOutputWorker] Unknown message type:",
        (message as { type: string }).type
      );
      break;
    }
  }
};
