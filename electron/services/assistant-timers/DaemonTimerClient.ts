import { connect, type Socket } from "node:net";

/**
 * A one-shot client for the assistant supervisor daemon's control socket.
 *
 * Daintree reaches this socket for exactly one reason: a durable timer outlives the
 * session that made it, so the moment it matters most is the moment no engine is
 * running. Once the panel and its process are gone the daemon holds the project
 * lease, and it is the only thing that can say what is still going to happen.
 *
 * Reading the engine's SQLite directly would be the other way to answer that, and it
 * is the wrong one: it duplicates a schema across a process boundary, races the
 * writes the lease-holder is making, and bypasses both the redaction the engine
 * applies and the audit row it writes. The socket keeps the engine the only writer.
 *
 * One connection per call, deliberately. These are rare (a popover opening, a cancel)
 * and a pooled connection to a process that can exit at any time is a reconnect
 * state machine bought for nothing.
 */

/** The daemon's control-protocol version. Mismatches are refused by the server. */
const PROTOCOL_VERSION = 1;

/**
 * Bounds one call. Generous next to the work — two SQLite reads — because the cost
 * of being wrong is asymmetric: a timeout reports "no daemon" for a daemon that is
 * simply busy, which reads to a user as "you have no timers".
 */
const CALL_TIMEOUT_MS = 5_000;

/** Refuses an absurd frame rather than buffering it. The daemon's own cap is 1 MiB. */
const MAX_FRAME_BYTES = 1024 * 1024;

export class DaemonUnavailableError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "DaemonUnavailableError";
  }
}

interface DaemonResponse {
  v: number;
  id: string;
  ok: boolean;
  error?: string;
  payload?: unknown;
}

/**
 * Sends one request and resolves its payload.
 *
 * Rejects with {@link DaemonUnavailableError} when there is no daemon to talk to —
 * which is the ORDINARY case, not an error condition: a project with no scheduled
 * work has no daemon, and so does one whose daemon idle-exited. A caller renders
 * that as "nothing to show", never as a fault.
 */
export function daemonCall<T>(socketPath: string, type: string, payload?: unknown): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let socket: Socket | undefined;
    let settled = false;
    let buffer = "";

    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket?.destroy();
      fn();
    };

    const timer = setTimeout(() => {
      finish(() => reject(new DaemonUnavailableError(`the daemon did not answer ${type} in time`)));
    }, CALL_TIMEOUT_MS);

    try {
      socket = connect(socketPath);
    } catch (error) {
      finish(() => reject(new DaemonUnavailableError(String(error))));
      return;
    }

    // Every connection-level failure is the same answer: there is no daemon here.
    // ENOENT (no socket file), ECONNREFUSED (a stale file whose process died) and a
    // mid-call reset all mean the project is unsupervised right now.
    socket.on("error", (error) => {
      finish(() => reject(new DaemonUnavailableError(error.message)));
    });
    socket.on("close", () => {
      finish(() =>
        reject(new DaemonUnavailableError(`the daemon closed before answering ${type}`))
      );
    });

    socket.on("connect", () => {
      const frame = JSON.stringify({ v: PROTOCOL_VERSION, id: "r1", type, payload });
      socket?.write(`${frame}\n`);
    });

    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      if (buffer.length > MAX_FRAME_BYTES) {
        finish(() => reject(new DaemonUnavailableError("the daemon sent an oversized frame")));
        return;
      }
      const newline = buffer.indexOf("\n");
      if (newline === -1) return;
      const line = buffer.slice(0, newline).trim();
      if (!line) return;

      let response: DaemonResponse;
      try {
        response = JSON.parse(line) as DaemonResponse;
      } catch {
        finish(() => reject(new DaemonUnavailableError("the daemon sent a malformed frame")));
        return;
      }
      if (!response.ok) {
        // A refusal is a real answer, not a transport failure — most often "this
        // daemon is not holding the project", which means an attached session took
        // the lease and the caller should route there instead. It stays a plain
        // Error so a caller can tell it from DaemonUnavailableError.
        finish(() => reject(new Error(response.error || `the daemon refused ${type}`)));
        return;
      }
      finish(() => resolve(response.payload as T));
    });
  });
}
