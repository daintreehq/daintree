import net from "node:net";
import { readDiscoveryFile } from "../host/discoveryFile.js";

/**
 * How a link client reaches a host socket. The SSH transport forwards a
 * local socket to the remote one; the direct transport dials a socket on
 * this machine (tests, and attaching to this machine's own host).
 */

export interface LinkTransportConnection {
  socket: net.Socket;
  /** The host's per-launch token, read from its discovery file. */
  token: string;
  /** Release whatever the transport started (ssh forward, local socket file). */
  dispose(): Promise<void>;
}

export interface LinkTransport {
  open(signal: AbortSignal): Promise<LinkTransportConnection>;
}

/** A failure to reach the host. `detail` is what we observed (ssh's own words), never a guess. */
export class TransportError extends Error {
  constructor(
    message: string,
    readonly detail: string | null
  ) {
    super(message);
    this.name = "TransportError";
  }
}

export function connectUnixSocket(
  socketPath: string,
  signal: AbortSignal,
  timeoutMs = 10_000
): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new TransportError("Connection cancelled", null));
      return;
    }
    const socket = net.connect(socketPath);
    const cleanup = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      socket.off("connect", onConnect);
      socket.off("error", onError);
    };
    const onConnect = () => {
      cleanup();
      resolve(socket);
    };
    const onError = (err: Error) => {
      cleanup();
      socket.destroy();
      reject(new TransportError(`Could not connect to ${socketPath}`, err.message));
    };
    const onAbort = () => {
      cleanup();
      socket.destroy();
      reject(new TransportError("Connection cancelled", null));
    };
    const timer = setTimeout(() => {
      cleanup();
      socket.destroy();
      reject(new TransportError(`Timed out connecting to ${socketPath}`, null));
    }, timeoutMs);
    socket.once("connect", onConnect);
    socket.once("error", onError);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

export function createDirectTransport(
  target: { socketPath: string; token: string } | { discoveryPath: string }
): LinkTransport {
  return {
    async open(signal) {
      let socketPath: string;
      let token: string;
      if ("discoveryPath" in target) {
        const info = await readDiscoveryFile(target.discoveryPath);
        if (!info) {
          throw new TransportError(`No host discovery file at ${target.discoveryPath}`, null);
        }
        ({ socketPath, token } = info);
      } else {
        ({ socketPath, token } = target);
      }
      const socket = await connectUnixSocket(socketPath, signal);
      return {
        socket,
        token,
        dispose: async () => {
          socket.destroy();
        },
      };
    },
  };
}
