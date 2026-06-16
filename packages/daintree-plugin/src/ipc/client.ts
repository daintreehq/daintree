import net from "node:net";
import { getCliSocketPath, readCliControlFile } from "../lib/socketPath.js";

const REQUEST_TIMEOUT_MS = 30_000;

/**
 * Resolve where to connect and which auth token to present (#10518). The host
 * advertises both in its control-discovery file on startup; the CLI reads it so
 * it can authenticate and (on Windows) find the per-launch randomized pipe name.
 * An explicit `DAINTREE_CLI_SOCKET` override still wins for the path — the token
 * is still pulled from the control file when one exists. With no control file
 * the host isn't running; fall back to the default path so the connect surfaces
 * a clean "not running" error naming it.
 */
async function resolveEndpoint(): Promise<{ socketPath: string; token?: string }> {
  const override = process.env.DAINTREE_CLI_SOCKET;
  const control = await readCliControlFile();
  if (override && override.length > 0) {
    return { socketPath: override, token: control?.token };
  }
  if (control) {
    return { socketPath: control.socketPath, token: control.token };
  }
  return { socketPath: getCliSocketPath() };
}

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
export async function sendCliRequest(method: string, params?: unknown): Promise<unknown> {
  const { socketPath, token } = await resolveEndpoint();
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
      socket.write(JSON.stringify({ id: 1, method, params, token }) + "\n");
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

    // The peer accepted the connection then closed it without a complete
    // response frame — treat as an unusable/stale endpoint rather than hanging
    // until the request timeout fires.
    socket.on("close", () => {
      finish(() =>
        reject(
          new DaintreeUnavailableError(
            `Daintree closed the connection without responding (socket: ${socketPath}). Restart Daintree and try again.`,
            socketPath
          )
        )
      );
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
      // ECONNREFUSED: stale socket file with no listener. ECONNRESET/EPIPE: the
      // peer accepted then dropped the connection mid-request (e.g. a process
      // holding the path that doesn't speak the protocol). All mean "can't
      // complete the request against this endpoint".
      if (err.code === "ECONNREFUSED" || err.code === "ECONNRESET" || err.code === "EPIPE") {
        finish(() =>
          reject(
            new DaintreeUnavailableError(
              `Couldn't connect to Daintree (stale or unresponsive socket at ${socketPath}). Restart Daintree and try again.`,
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
