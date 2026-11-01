import net from "node:net";
import type { Duplex } from "node:stream";
import { readDiscoveryFile } from "../host/discoveryFile.js";
import { SSH_ACCESS_DENIED } from "../../../shared/utils/sshRefusal.js";

/**
 * How a link client reaches a host. The SSH transport forwards a local socket
 * to the remote one (or, where the server refuses that, carries the stream
 * over a command's stdio); the direct transport dials a socket on this machine
 * (tests, and attaching to this machine's own host); the command stream
 * transport runs a program whose stdio is the link.
 */

export interface LinkTransportConnection {
  /** The link's byte stream: a socket, or a command's stdio. Its write() return value is its backpressure. */
  socket: Duplex;
  /** The host's per-launch token, read from its discovery file. */
  token: string;
  /** Release whatever the transport started (ssh forward, local socket file). */
  dispose(): Promise<void>;
}

export interface LinkOpenOptions {
  /**
   * Whether a host reached with no Daintree serving may be checked on and
   * started (true unless given). False while the host has said it is
   * restarting: it comes back by itself, and until then its record says it
   * quit on purpose.
   */
  mayStart?: boolean;
}

export interface LinkTransport {
  open(signal: AbortSignal, options?: LinkOpenOptions): Promise<LinkTransportConnection>;
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

/**
 * ssh refused to log in: authentication or the host key failed. Trying again
 * finds the same until the user fixes it, and each try can land in the host's
 * auth log (and its fail2ban) or ask to approve a key.
 */
export class SshAccessError extends TransportError {
  constructor(detail: string) {
    super("ssh couldn't log in to the host", detail);
    this.name = "SshAccessError";
  }
}

/** Whether ssh's stderr says it couldn't log in, rather than couldn't reach the host. */
export function isSshAccessDenied(stderr: string): boolean {
  return SSH_ACCESS_DENIED.test(stderr);
}

/**
 * This machine can't reach the host the way it is set up: a connection kind
 * this platform doesn't use (an ssh host in a Windows Shell's list), WSL not
 * installed, a distro that isn't there. Trying again finds the same until the
 * user changes something, so the link waits for a Connect.
 */
export class UnusableConnectionError extends TransportError {
  constructor(message: string, detail: string | null) {
    super(message, detail);
    this.name = "UnusableConnectionError";
  }
}

/** ssh reached the host and found no Daintree listening there in Host mode. */
export class HostModeOffError extends TransportError {
  constructor(detail: string) {
    super("Daintree isn't running in Host mode on the host", detail);
    this.name = "HostModeOffError";
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
