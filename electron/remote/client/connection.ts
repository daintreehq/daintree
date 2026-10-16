import {
  formatHostConnection,
  isValidWslDistroName,
  sshConnection,
  sshTargetOf,
  wslConnection,
  type HostConnection,
} from "../../../shared/types/remoteHosts.js";
import { remoteConnectionKindOn } from "../../../shared/config/remoteHostsSupport.js";
import { AppError } from "../../utils/errorTypes.js";
import { isValidSshTarget } from "./sshTransport.js";

/**
 * Validation and capability checks for {@link HostConnection}. Anything that
 * only exists over ssh (a ControlMaster, `-O forward`, scp) asks
 * {@link sshTargetOf} or {@link requireSshTarget} rather than assuming every
 * host is an ssh target, so a new connection kind gets a clear refusal where
 * the capability doesn't exist for it yet.
 */

const SSH_TARGET_HINT = "Enter user@host, a host name, or an ~/.ssh/config alias.";
const WSL_DISTRO_HINT = "Choose a WSL distribution installed on this PC.";

/** A connection from untrusted input (IPC, the settings file), trimmed; null when unusable. */
export function parseHostConnection(value: unknown): HostConnection | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as { kind?: unknown; target?: unknown; distro?: unknown };
  switch (raw.kind) {
    case "ssh": {
      if (typeof raw.target !== "string") return null;
      const target = raw.target.trim();
      return isValidSshTarget(target) ? sshConnection(target) : null;
    }
    case "wsl": {
      if (typeof raw.distro !== "string") return null;
      const distro = raw.distro.trim();
      return isValidWslDistroName(distro) ? wslConnection(distro) : null;
    }
    default:
      return null;
  }
}

/** {@link parseHostConnection}, throwing the user-facing VALIDATION error. */
export function requireHostConnection(value: unknown): HostConnection {
  const connection = parseHostConnection(value);
  if (!connection) {
    const kind = (value as { kind?: unknown } | null)?.kind;
    throw new AppError({
      code: "VALIDATION",
      message: "Not a usable host connection",
      userMessage: kind === "wsl" ? WSL_DISTRO_HINT : SSH_TARGET_HINT,
    });
  }
  return connection;
}

export { sshTargetOf };

/**
 * A connection this platform's Shell can use (see remoteConnectionKindOn):
 * a stored ssh host on Windows, or a WSL one carried to a Mac in a settings
 * file, is kept but never run.
 */
export function requireSupportedConnection(
  connection: HostConnection,
  platform: NodeJS.Platform = process.platform
): HostConnection {
  if (connection.kind === remoteConnectionKindOn(platform)) return connection;
  const userMessage =
    platform === "win32"
      ? `${formatHostConnection(connection)} is reached over ssh, which Daintree for Windows doesn't support. Add a WSL distribution instead.`
      : `${formatHostConnection(connection)} is a WSL distribution, which only Daintree for Windows can reach.`;
  throw new AppError({
    code: "UNSUPPORTED",
    message: `${connection.kind} hosts aren't supported on ${platform}`,
    userMessage,
  });
}

/**
 * The refusal for a capability a connection kind doesn't have yet: typed
 * (`UNSUPPORTED`), naming the capability and the host.
 */
export function unsupportedConnection(connection: HostConnection, capability: string): AppError {
  const kind = (connection as { kind: string }).kind;
  return new AppError({
    code: "UNSUPPORTED",
    message: `${capability} needs an ssh connection; this host is reached over ${kind}`,
    userMessage: `${capability} isn't available for ${formatHostConnection(connection)} yet.`,
  });
}

/** The ssh target for something only ssh can do; any other kind is refused (see {@link unsupportedConnection}). */
export function requireSshTarget(connection: HostConnection, capability: string): string {
  const target = sshTargetOf(connection);
  if (target !== null) return target;
  throw unsupportedConnection(connection, capability);
}

/** A stable key for per-connection state (caches, dedup), distinct across kinds. */
export function connectionKey(connection: HostConnection): string {
  switch (connection.kind) {
    case "ssh":
      return `ssh:${connection.target}`;
    case "wsl":
      // WSL looks distro names up without regard to case.
      return `wsl:${connection.distro.toLowerCase()}`;
    default:
      return `${(connection as { kind: string }).kind}:${formatHostConnection(connection)}`;
  }
}
