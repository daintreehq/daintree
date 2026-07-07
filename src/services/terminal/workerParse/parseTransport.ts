import { formatErrorMessage } from "@shared/utils/errorMessage";
import { ParseAuthority, type AuthoritySnapshot } from "./parseAuthority";

// The message protocol between a WorkerParseSession (main thread) and its
// ParseAuthority (worker). Transport-agnostic: the same endpoint runs behind
// a Web Worker (renderer), a node worker_thread (perf harness), or in-thread
// (tests). Message order is FIFO per session — a snapshot request observes
// every write sent before it.

export type AuthorityRequest =
  | { type: "init"; cols: number; rows: number; scrollback: number }
  | { type: "write"; data: string | Uint8Array }
  | { type: "resize"; cols: number; rows: number }
  | { type: "restore"; serialized: string }
  | { type: "snapshot"; requestId: number; boundedScrollbackLines?: number }
  // Live-ingest control (issue #10960). `attach-port` is only meaningful on a
  // real Worker transport — the dedicated pty-host MessagePort rides the
  // postMessage transfer list, out-of-band of this union (see
  // createParseWorkerTransport.attachIngestPort). `activate-port-ingest` is
  // the demotion barrier: it rides the control FIFO BEHIND every byte the
  // main thread relayed pre-engage, so the worker starts consuming held port
  // chunks only after those relayed bytes are queued — cross-channel
  // reordering is structurally impossible.
  | { type: "attach-port" }
  | { type: "activate-port-ingest" }
  | { type: "dispose" };

export type AuthorityResponse =
  | { type: "snapshot"; requestId: number; snapshot: AuthoritySnapshot | null }
  // The promotion barrier answer: the host's `ingest-detached` sentinel was
  // seen on the dedicated port, so every pre-release port byte is now queued
  // ahead of any subsequent snapshot request.
  | { type: "port-drained"; drainId: number }
  // The dedicated port closed under the worker (host teardown, project
  // switch). Not a crash — the controller falls back to the main-thread path.
  | { type: "ingest-port-closed" }
  // requestId present when the failure belongs to a specific snapshot
  // request, so the session can settle that wait instead of leaving the
  // caller (a promotion) pending until dispose.
  | { type: "error"; message: string; requestId?: number };

// What the pty-host posts on a dedicated worker-ingest port: the same `data`
// shape it posts on the per-window port, plus the `ingest-detached` release
// sentinel (FIFO behind the final routed chunk).
export type IngestPortMessage =
  | { type: "data"; id: string; data: string | Uint8Array; bytes: number }
  | { type: "ingest-detached"; drainId: number };

export interface AuthorityTransport {
  send(request: AuthorityRequest): void;
  onResponse(listener: (response: AuthorityResponse) => void): () => void;
  dispose(): void;
  // Transfer a dedicated pty-host ingest port into the worker. Only real
  // Worker transports implement this; in-thread transports have no second
  // thread for bytes to bypass.
  attachIngestPort?(port: MessagePort): void;
}

// The worker-side request handler. Owns exactly one authority; `init` must
// arrive first (the session sends it on construction).
export class AuthorityEndpoint {
  private authority: ParseAuthority | null = null;

  constructor(private post: (response: AuthorityResponse) => void) {}

  async handle(request: AuthorityRequest): Promise<void> {
    try {
      switch (request.type) {
        case "init":
          this.authority?.dispose();
          this.authority = new ParseAuthority({
            cols: request.cols,
            rows: request.rows,
            scrollback: request.scrollback,
          });
          return;
        case "write":
          this.requireAuthority().write(request.data);
          return;
        case "resize":
          this.requireAuthority().resize(request.cols, request.rows);
          return;
        case "restore":
          this.requireAuthority().restore(request.serialized);
          return;
        case "snapshot": {
          try {
            const snapshot = await this.requireAuthority().takeSnapshot(
              request.boundedScrollbackLines
            );
            this.post({ type: "snapshot", requestId: request.requestId, snapshot });
          } catch (error) {
            this.post({
              type: "error",
              requestId: request.requestId,
              message: formatErrorMessage(error, "snapshot failed"),
            });
          }
          return;
        }
        case "attach-port":
        case "activate-port-ingest":
          // Handled by the worker entry (parseWorker) before requests reach
          // the endpoint; a transport without port support delivers them here
          // as no-ops.
          return;
        case "dispose":
          this.authority?.dispose();
          this.authority = null;
          return;
      }
    } catch (error) {
      this.post({
        type: "error",
        message: formatErrorMessage(error, "parse authority request failed"),
      });
    }
  }

  // Port-ingest write: same authority, but the caller owns ack timing —
  // `onParsed` fires from xterm's write-completion callback.
  ingestWrite(data: string | Uint8Array, onParsed: () => void): void {
    this.requireAuthority().write(data, onParsed);
  }

  private requireAuthority(): ParseAuthority {
    if (!this.authority) {
      throw new Error("Parse authority endpoint received a message before init");
    }
    return this.authority;
  }
}

export interface IngestPortConsumerDeps {
  // Parse a chunk; `onParsed` must fire once the bytes have actually landed
  // in the authority (AuthorityEndpoint.ingestWrite).
  write(data: string | Uint8Array, onParsed: () => void): void;
  // Ack back over the dedicated port to the pty-host's queue ledger.
  postAck(ack: { type: "ack"; id: string; bytes: number }): void;
  // Control-channel response (to the WorkerParseSession / ingest controller).
  postResponse(response: AuthorityResponse): void;
  // Serialize a task into the worker's single FIFO shared with
  // AuthorityRequest handling — a snapshot request must observe every port
  // chunk enqueued before it.
  enqueue(task: () => void | Promise<void>): void;
}

// Worker-side consumer for a dedicated ingest port. Environment-agnostic (the
// worker entry adapts the real MessagePort; tests drive it directly). Chunks
// arriving before `activate()` are HELD: pre-engage bytes travel main-thread →
// control channel, and consuming direct port bytes before that relay drains
// would parse them out of order. The `ingest-detached` sentinel answers the
// release barrier and returns the consumer to holding for the next engage.
export class IngestPortConsumer {
  private active = false;
  private held: Array<Extract<IngestPortMessage, { type: "data" }>> = [];

  constructor(private deps: IngestPortConsumerDeps) {}

  handlePortMessage(message: unknown): void {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- wire message; every branch below re-validates field types before use
    const msg = message as IngestPortMessage;
    if (!msg || typeof msg !== "object") return;
    if (msg.type === "data" && typeof msg.id === "string" && typeof msg.bytes === "number") {
      if (this.active) {
        this.deps.enqueue(() => this.processData(msg));
      } else {
        this.held.push(msg);
      }
      return;
    }
    if (msg.type === "ingest-detached" && typeof msg.drainId === "number") {
      const drainId = msg.drainId;
      this.deps.enqueue(() => {
        // Port FIFO guarantees every pre-detach chunk was already dispatched
        // (enqueued or held). Drain holds too — an engage that raced release
        // before its activate arrived must not strand bytes.
        this.drainHeld();
        this.active = false;
        this.deps.postResponse({ type: "port-drained", drainId });
      });
    }
  }

  // Runs inside the control-channel FIFO (worker entry enqueues it for
  // `activate-port-ingest`): every pre-engage relayed byte is queued ahead.
  activate(): void {
    this.drainHeld();
    this.active = true;
  }

  private drainHeld(): void {
    const held = this.held;
    this.held = [];
    for (const msg of held) this.processData(msg);
  }

  private processData(msg: Extract<IngestPortMessage, { type: "data" }>): void {
    try {
      this.deps.write(msg.data, () => {
        this.deps.postAck({ type: "ack", id: msg.id, bytes: msg.bytes });
      });
    } catch (error) {
      // The write never entered the parse buffer (xterm discard watermark, or
      // authority not initialized). Ack anyway — the host ledger must not
      // leak into permanent backpressure — and surface a whole-worker error
      // so the controller falls back to the main-thread path, whose host
      // snapshot restore recovers the lost content.
      this.deps.postAck({ type: "ack", id: msg.id, bytes: msg.bytes });
      this.deps.postResponse({
        type: "error",
        message: formatErrorMessage(error, "worker ingest write failed"),
      });
    }
  }
}

// In-thread transport for tests and for environments without Worker support:
// requests are handled by a local endpoint. Still async (endpoint.handle is
// async), still FIFO — behaviorally the Web Worker transport minus the
// thread hop, which is exactly what deterministic tests want.
export function createInThreadTransport(): AuthorityTransport {
  const listeners = new Set<(response: AuthorityResponse) => void>();
  const endpoint = new AuthorityEndpoint((response) => {
    listeners.forEach((listener) => listener(response));
  });
  let queue: Promise<void> = Promise.resolve();
  return {
    send(request) {
      queue = queue.then(() => endpoint.handle(request));
    },
    onResponse(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    dispose() {
      queue = queue.then(() => endpoint.handle({ type: "dispose" }));
      listeners.clear();
    },
  };
}
