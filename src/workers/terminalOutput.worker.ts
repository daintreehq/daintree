import { SharedRingBuffer, PacketParser } from "../../shared/utils/SharedRingBuffer.js";
import {
  TerminalOutputCoalescer,
  type CoalescerOutput,
} from "../services/terminal/TerminalOutputCoalescer.js";
import type {
  WorkerInboundMessage,
  WorkerOutboundMessage,
} from "../../shared/types/terminal-output-worker-messages.js";

const MAX_SAB_READ_BYTES = 256 * 1024;
const MAX_SAB_BYTES_PER_TICK = 2 * 1024 * 1024;
const MAX_READS_PER_TICK = 50;
const ATOMICS_WAIT_TIMEOUT_MS = 100;
const BATCH_POST_INTERVAL_MS = 50;

let ringBuffers: SharedRingBuffer[] = [];
let signalView: Int32Array | null = null;
let lastSeenSignal = 0;
const packetParsers: PacketParser[] = [];
let coalescer: TerminalOutputCoalescer | null = null;
let isRunning = false;
let pendingOutputs: CoalescerOutput[] = [];
let lastBatchPostTime = 0;
let batchTimeoutId: number | null = null;
let atomicsWaitSupported: boolean | null = null;
const scheduledDeadlines = new Map<number, number>();
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
  for (const timeoutId of scheduledDeadlines.keys()) {
    self.clearTimeout(timeoutId);
  }
  scheduledDeadlines.clear();
  pendingOutputs = [];
  lastBatchPostTime = 0;
  for (const parser of packetParsers) {
    parser.reset();
  }
  packetParsers.length = 0;
  ringBuffers = [];
  signalView = null;
  lastSeenSignal = 0;
  coalescer?.dispose();
  coalescer = null;
  nextShardIndex = 0;
}

function onCoalescerOutput(output: CoalescerOutput): void {
  pendingOutputs.push(output);
  scheduleBatchPost();
}

function scheduleBatchPost(): void {
  if (batchTimeoutId !== null) {
    return;
  }

  const now = Date.now();
  const timeSinceLastPost = now - lastBatchPostTime;

  if (timeSinceLastPost >= BATCH_POST_INTERVAL_MS) {
    postBatch();
  } else {
    const delay = BATCH_POST_INTERVAL_MS - timeSinceLastPost;
    batchTimeoutId = scheduleTimeout(() => {
      batchTimeoutId = null;
      postBatch();
    }, delay);
  }
}

function postBatch(): void {
  if (pendingOutputs.length === 0) return;

  const batches = pendingOutputs.splice(0);
  lastBatchPostTime = Date.now();

  const message: WorkerOutboundMessage = {
    type: "OUTPUT_BATCH",
    batches,
  };
  self.postMessage(message);
}

function drainRingBuffer(): boolean {
  if (ringBuffers.length === 0) return false;

  let hasData = false;
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
      coalescer?.bufferData(packet.id, packet.data);
    }
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

      coalescer = new TerminalOutputCoalescer(
        scheduleTimeout,
        clearScheduledTimeout,
        getNow,
        onCoalescerOutput
      );

      isRunning = true;
      mainLoop();
      break;
    }

    case "SET_INTERACTIVE": {
      coalescer?.markInteractive(message.id, message.ttlMs);
      break;
    }

    case "FLUSH_TERMINAL": {
      coalescer?.flushForTerminal(message.id);
      postBatch();
      break;
    }

    case "RESET_TERMINAL": {
      coalescer?.resetForTerminal(message.id);
      break;
    }

    case "STOP": {
      isRunning = false;
      coalescer?.flushAll();
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
