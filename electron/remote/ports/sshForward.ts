import { isValidSshTarget, type SshSpawner } from "../client/sshTransport.js";

/**
 * Port forwards added to (and removed from) the ControlMaster the link's own
 * connection already runs, so a forwarded port costs no new SSH connection
 * or authentication. `ssh -O forward` asks the master to bind the local side
 * and exits; the forward lives as long as the master.
 */

export interface SshMuxTarget {
  /** What the user typed for the host: `user@host`, an ~/.ssh/config alias. */
  target: string;
  controlPath: string;
}

const DEFAULT_TIMEOUT_MS = 10_000;

function isPort(value: number): boolean {
  return Number.isInteger(value) && value >= 1 && value <= 65535;
}

/**
 * `ssh -O forward|cancel -L 127.0.0.1:<local>:localhost:<remote>` through the
 * master. The local side binds IPv4 loopback alone, so exactly what it holds
 * is known (the IPv6 side is held by a relay here); the remote side is the
 * Host's own `localhost`, resolved by its sshd.
 */
export function buildPortForwardArgs(
  mux: SshMuxTarget,
  localPort: number,
  remotePort: number,
  operation: "forward" | "cancel"
): string[] {
  if (!isValidSshTarget(mux.target)) throw new Error(`Invalid SSH target: ${mux.target}`);
  if (!isPort(localPort) || !isPort(remotePort)) {
    throw new Error(`Invalid port pair ${localPort}:${remotePort}`);
  }
  return [
    "-o",
    `ControlPath=${mux.controlPath}`,
    "-O",
    operation,
    "-L",
    `127.0.0.1:${localPort}:localhost:${remotePort}`,
    "--",
    mux.target,
  ];
}

/** Run one mux control command; true when ssh reports success. Never rejects. */
export function runSshMuxCommand(
  spawn: SshSpawner,
  args: string[],
  timeoutMs = DEFAULT_TIMEOUT_MS
): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(ok);
    };
    let child: ReturnType<SshSpawner>;
    try {
      child = spawn(args);
    } catch {
      resolve(false);
      return;
    }
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      finish(false);
    }, timeoutMs);
    // Drain both pipes so a chatty ssh can't block on a full buffer.
    child.stdout?.resume();
    child.stderr?.resume();
    child.on("error", () => finish(false));
    child.on("exit", (code) => finish(code === 0));
  });
}
