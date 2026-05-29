import net from "node:net";
import { getCliSocketPath } from "../lib/socketPath.js";

const REQUEST_TIMEOUT_MS = 30_000;

/**
 * Daintree isn't reachable on the control socket. `ENOENT` means no instance is
 * running (the socket file is absent); `ECONNREFUSED` means a stale socket file
 * was left by a crashed instance. Both name the socket path tried so authors
 * can debug on Linux (lesson #4463).
 */
export class DaintreeUnavailableError extends Error {
  constructor(
    message: string,
    readonly socketPath: string
  ) {
    super(message);
    this.name = "DaintreeUnavailableError";
  }
}

interface CliResponse {
  id: string | number;
  result?: unknown;
  error?: { message: string };
}

/**
 * Send one request frame to the running Daintree instance and resolve with the
 * `result` (or reject with the `error.message`). Connection-level failures map
 * to {@link DaintreeUnavailableError} with a human-facing message.
 */
export function sendCliRequest(method: string, params?: unknown): Promise<unknown> {
  const socketPath = getCliSocketPath();
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ path: socketPath });
    let buffer = "";
    let settled = false;

    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      fn();
    };

    const timer = setTimeout(() => {
      finish(() => reject(new Error("Timed out waiting for Daintree to respond")));
    }, REQUEST_TIMEOUT_MS);

    socket.setEncoding("utf8");

    socket.on("connect", () => {
      socket.write(JSON.stringify({ id: 1, method, params }) + "\n");
    });

    socket.on("data", (chunk: string) => {
      buffer += chunk;
      const idx = buffer.indexOf("\n");
      if (idx < 0) return;
      const line = buffer.slice(0, idx);
      let res: CliResponse;
      try {
        res = JSON.parse(line);
      } catch {
        finish(() => reject(new Error("Received a malformed response from Daintree")));
        return;
      }
      if (res.error) {
        finish(() => reject(new Error(res.error?.message ?? "Daintree returned an error")));
        return;
      }
      finish(() => resolve(res.result));
    });

    socket.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "ENOENT") {
        finish(() =>
          reject(
            new DaintreeUnavailableError(
              `Daintree isn't running. Start Daintree and try again. (tried: ${socketPath})`,
              socketPath
            )
          )
        );
        return;
      }
      if (err.code === "ECONNREFUSED") {
        finish(() =>
          reject(
            new DaintreeUnavailableError(
              `Couldn't connect to Daintree (stale socket at ${socketPath}). Restart Daintree and try again.`,
              socketPath
            )
          )
        );
        return;
      }
      finish(() => reject(err));
    });
  });
}
