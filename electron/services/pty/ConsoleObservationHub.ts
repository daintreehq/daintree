export interface ConsoleObservationChunk {
  seq: number;
  data: string;
  encoding: "base64";
  bytes: number;
}

export type ConsoleObservationEvent =
  | ({ type: "output" } & ConsoleObservationChunk)
  | { type: "invalidated"; reason: "generation-changed" | "host-restarted" };

export type ConsoleObservationStart =
  | { mode: "snapshot" | "resume"; throughSeq: number; chunks: ConsoleObservationChunk[] }
  | { mode: "resync"; reason: "gap"; throughSeq: number; chunks: [] };

interface TerminalConsoleState {
  generation: number;
  seq: number;
  history: ConsoleObservationChunk[];
  historyBytes: number;
  observers: Set<string>;
}

const DEFAULT_MAX_CHUNK_BYTES = 64 * 1024;
const DEFAULT_MAX_HISTORY_BYTES = 1024 * 1024;

export class ConsoleObservationHub {
  private readonly states = new Map<string, TerminalConsoleState>();
  private readonly maxChunkBytes: number;
  private readonly maxHistoryBytes: number;

  constructor(
    private readonly emit: (
      terminalId: string,
      generation: number,
      observerId: string,
      event: ConsoleObservationEvent
    ) => void,
    options: { maxChunkBytes?: number; maxHistoryBytes?: number } = {}
  ) {
    this.maxChunkBytes = options.maxChunkBytes ?? DEFAULT_MAX_CHUNK_BYTES;
    this.maxHistoryBytes = options.maxHistoryBytes ?? DEFAULT_MAX_HISTORY_BYTES;
  }

  begin(
    terminalId: string,
    generation: number,
    observerId: string,
    afterSeq?: number
  ): ConsoleObservationStart {
    let state = this.states.get(terminalId);
    if (!state || state.generation !== generation) {
      if (state) {
        for (const observer of state.observers) {
          this.emit(terminalId, state.generation, observer, {
            type: "invalidated",
            reason: "generation-changed",
          });
        }
      }
      state = { generation, seq: 0, history: [], historyBytes: 0, observers: new Set() };
      this.states.set(terminalId, state);
    }
    state.observers.add(observerId);
    if (afterSeq === undefined) return { mode: "snapshot", throughSeq: state.seq, chunks: [] };
    const oldest = state.history[0]?.seq ?? state.seq + 1;
    if (afterSeq > state.seq || afterSeq < oldest - 1) {
      return { mode: "resync", reason: "gap", throughSeq: state.seq, chunks: [] };
    }
    return {
      mode: "resume",
      throughSeq: state.seq,
      chunks: state.history.filter((chunk) => chunk.seq > afterSeq),
    };
  }

  onData(terminalId: string, generation: number, data: string | Uint8Array): void {
    const state = this.states.get(terminalId);
    if (!state) return;
    if (state.generation !== generation) {
      this.removeTerminal(terminalId, "generation-changed");
      return;
    }
    const bytes = typeof data === "string" ? Buffer.from(data, "utf8") : Buffer.from(data);
    for (let offset = 0; offset < bytes.byteLength; offset += this.maxChunkBytes) {
      const slice = bytes.subarray(offset, offset + this.maxChunkBytes);
      const chunk: ConsoleObservationChunk = {
        seq: ++state.seq,
        data: slice.toString("base64"),
        encoding: "base64",
        bytes: slice.byteLength,
      };
      state.history.push(chunk);
      state.historyBytes += chunk.bytes;
      while (state.historyBytes > this.maxHistoryBytes && state.history.length > 0) {
        state.historyBytes -= state.history.shift()!.bytes;
      }
      for (const observer of state.observers) {
        this.emit(terminalId, generation, observer, { type: "output", ...chunk });
      }
    }
  }

  end(terminalId: string, observerId: string): void {
    this.states.get(terminalId)?.observers.delete(observerId);
  }

  removeTerminal(terminalId: string, reason: "generation-changed" | "host-restarted"): void {
    const state = this.states.get(terminalId);
    if (!state) return;
    for (const observer of state.observers) {
      this.emit(terminalId, state.generation, observer, { type: "invalidated", reason });
    }
    this.states.delete(terminalId);
  }

  clear(reason: "generation-changed" | "host-restarted"): void {
    for (const terminalId of Array.from(this.states.keys()))
      this.removeTerminal(terminalId, reason);
  }

  diagnostics(terminalId: string): { historyBytes: number; historyFrames: number } | null {
    const state = this.states.get(terminalId);
    return state ? { historyBytes: state.historyBytes, historyFrames: state.history.length } : null;
  }
}
