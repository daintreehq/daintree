import { SharedRingBuffer, PacketParser } from "@shared/utils/SharedRingBuffer";
import { terminalClient } from "@/clients";

// Target ~20fps steady updates for terminal rendering.
// We trade latency for reliability/throughput by batching writes.
const DEFAULT_FLUSH_DELAY_MS = 50;
const INTERACTIVE_FLUSH_THRESHOLD_BYTES = 2048;
const INTERACTIVE_FLUSH_DELAY_MS = 0;
const IDLE_POLL_INTERVALS = [8, 16, 33, 100] as const;
const MAX_BUFFER_BYTES = 20 * 1024;
const MAX_READS_PER_TICK = 50;
const BUSY_POLL_INTERVAL_MS = 8;
const MAX_SAB_READ_BYTES = 256 * 1024;
const MAX_SAB_BYTES_PER_TICK = 2 * 1024 * 1024;

const BYPASS_FRAME_BUFFER: boolean = false;

type BufferEntry = {
  chunks: (string | Uint8Array)[];
  bytes: number;
  timeoutId: number | null;
};

export class TerminalDataBuffer {
  private ringBuffer: SharedRingBuffer | null = null;
  private packetParser = new PacketParser();
  private pollingActive = false;
  private pollTimeoutId: number | null = null;
  private sharedBufferEnabled = false;
  private idlePollCount = 0;

  private buffers = new Map<string, BufferEntry>();
  private interactiveUntil = new Map<string, number>();

  constructor(private readonly writeToTerminal: (id: string, data: string | Uint8Array) => void) {}

  public async initialize(): Promise<void> {
    try {
      const buffer = await terminalClient.getSharedBuffer();
      if (buffer) {
        this.ringBuffer = new SharedRingBuffer(buffer);
        this.sharedBufferEnabled = true;
        this.startPolling();
        console.log("[TerminalDataBuffer] SharedArrayBuffer polling enabled");
      } else {
        console.log("[TerminalDataBuffer] SharedArrayBuffer unavailable, using IPC");
      }
    } catch (error) {
      console.warn("[TerminalDataBuffer] Failed to initialize SharedArrayBuffer:", error);
    }
  }

  public isEnabled(): boolean {
    return this.sharedBufferEnabled;
  }

  public isPolling(): boolean {
    return this.pollingActive;
  }

  public boost(): void {
    this.idlePollCount = 0;

    if (!this.pollingActive || !this.ringBuffer) return;
    if (this.pollTimeoutId === null) return;

    window.clearTimeout(this.pollTimeoutId);
    this.pollTimeoutId = null;
    this.poll();
  }

  public markInteractive(id: string, ttlMs: number = 1000): void {
    this.interactiveUntil.set(id, Date.now() + ttlMs);
  }

  private startPolling(): void {
    if (this.pollingActive || !this.ringBuffer) return;
    this.pollingActive = true;
    this.idlePollCount = 0;
    this.poll();
  }

  public stopPolling(): void {
    this.pollingActive = false;
    if (this.pollTimeoutId !== null) {
      clearTimeout(this.pollTimeoutId);
      this.pollTimeoutId = null;
    }

    for (const id of [...this.buffers.keys()]) {
      this.flushBuffer(id);
    }
  }

  public bufferData(id: string, data: string | Uint8Array): void {
    if (BYPASS_FRAME_BUFFER) {
      this.writeToTerminal(id, data);
      return;
    }

    let entry = this.buffers.get(id);
    const dataLength = typeof data === "string" ? data.length : data.byteLength;

    if (!entry) {
      entry = { chunks: [], bytes: 0, timeoutId: null };
      this.buffers.set(id, entry);
    }

    entry.chunks.push(data);
    entry.bytes += dataLength;

    // Typing fast-lane: flush aggressively right after user input.
    const until = this.interactiveUntil.get(id);
    if (until !== undefined && Date.now() <= until) {
      if (entry.bytes <= INTERACTIVE_FLUSH_THRESHOLD_BYTES) {
        this.flushBuffer(id);
        return;
      }

      if (entry.timeoutId !== null) {
        window.clearTimeout(entry.timeoutId);
      }

      entry.timeoutId = window.setTimeout(() => this.flushBuffer(id), INTERACTIVE_FLUSH_DELAY_MS);
      return;
    }

    if (entry.bytes >= MAX_BUFFER_BYTES) {
      this.flushBuffer(id);
      return;
    }

    if (entry.timeoutId === null) {
      entry.timeoutId = window.setTimeout(() => this.flushBuffer(id), DEFAULT_FLUSH_DELAY_MS);
    }
  }

  public resetForTerminal(id: string): void {
    const entry = this.buffers.get(id);
    if (!entry) return;
    if (entry.timeoutId !== null) {
      window.clearTimeout(entry.timeoutId);
    }
    this.buffers.delete(id);
    this.interactiveUntil.delete(id);
  }

  public flushForTerminal(id: string): void {
    this.flushBuffer(id);
  }

  private poll = (): void => {
    if (!this.pollingActive || !this.ringBuffer) return;
    this.pollTimeoutId = null;

    let hasData = false;
    let reads = 0;
    let bytesReadThisTick = 0;

    while (reads < MAX_READS_PER_TICK && bytesReadThisTick < MAX_SAB_BYTES_PER_TICK) {
      const remainingBudget = MAX_SAB_BYTES_PER_TICK - bytesReadThisTick;
      if (remainingBudget <= 0) {
        break;
      }
      const perReadBudget = Math.min(MAX_SAB_READ_BYTES, remainingBudget);
      const data = this.ringBuffer.readUpTo(perReadBudget);
      if (!data) {
        break;
      }

      hasData = true;
      reads += 1;
      bytesReadThisTick += data.byteLength;
      const packets = this.packetParser.parse(data);

      for (const packet of packets) {
        this.bufferData(packet.id, packet.data);
      }
    }

    if (hasData) {
      this.idlePollCount = 0;
      this.pollTimeoutId = window.setTimeout(this.poll, BUSY_POLL_INTERVAL_MS);
    } else {
      const intervalIndex = Math.min(this.idlePollCount, IDLE_POLL_INTERVALS.length - 1);
      const interval = IDLE_POLL_INTERVALS[intervalIndex];
      this.idlePollCount = Math.min(this.idlePollCount + 1, IDLE_POLL_INTERVALS.length - 1);
      this.pollTimeoutId = window.setTimeout(this.poll, interval);
    }
  };

  private flushBuffer(id: string): void {
    const entry = this.buffers.get(id);
    if (!entry) return;

    if (entry.timeoutId !== null) {
      window.clearTimeout(entry.timeoutId);
      entry.timeoutId = null;
    }

    this.buffers.delete(id);
    if (entry.chunks.length === 0) return;

    if (entry.chunks.length === 1) {
      this.writeToTerminal(id, entry.chunks[0]);
      return;
    }

    const allStrings = entry.chunks.every((chunk) => typeof chunk === "string");
    if (allStrings) {
      this.writeToTerminal(id, (entry.chunks as string[]).join(""));
      return;
    }

    for (const chunk of entry.chunks) {
      this.writeToTerminal(id, chunk);
    }
  }
}
