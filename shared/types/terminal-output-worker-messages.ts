export type WorkerInboundMessage =
  | {
      type: "INIT_BUFFER";
      buffers: SharedArrayBuffer[];
      signalBuffer: SharedArrayBuffer;
    }
  | { type: "SET_INTERACTIVE"; id: string; ttlMs: number }
  | { type: "FLUSH_TERMINAL"; id: string }
  | { type: "RESET_TERMINAL"; id: string }
  | { type: "SET_DIRECT_MODE"; id: string; enabled: boolean }
  | { type: "STOP" };

export type WorkerOutboundMessage = {
  type: "OUTPUT_BATCH";
  batches: Array<{ id: string; data: string | Uint8Array }>;
};
