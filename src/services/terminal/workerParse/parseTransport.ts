import { formatErrorMessage } from "@shared/utils/errorMessage";
import { ParseAuthority, type AuthoritySnapshot } from "./parseAuthority";

// The message protocol between a WorkerParseSession (main thread) and its
// ParseAuthority (worker). Transport-agnostic: the same endpoint runs behind
// a Web Worker (renderer), a node worker_thread (perf harness), or in-thread
// (tests). Message order is FIFO per session — a snapshot request observes
// every write sent before it.

export type AuthorityRequest =
  | { type: "init"; cols: number; rows: number; scrollback: number }
  | { type: "write"; data: string }
  | { type: "resize"; cols: number; rows: number }
  | { type: "restore"; serialized: string }
  | { type: "snapshot"; requestId: number; boundedScrollbackLines?: number }
  | { type: "dispose" };

export type AuthorityResponse =
  | { type: "snapshot"; requestId: number; snapshot: AuthoritySnapshot | null }
  // requestId present when the failure belongs to a specific snapshot
  // request, so the session can settle that wait instead of leaving the
  // caller (a promotion) pending until dispose.
  | { type: "error"; message: string; requestId?: number };

export interface AuthorityTransport {
  send(request: AuthorityRequest): void;
  onResponse(listener: (response: AuthorityResponse) => void): () => void;
  dispose(): void;
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

  private requireAuthority(): ParseAuthority {
    if (!this.authority) {
      throw new Error("Parse authority endpoint received a message before init");
    }
    return this.authority;
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
