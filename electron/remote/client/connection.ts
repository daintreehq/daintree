import {
  formatHostConnection,
  sshConnection,
  sshTargetOf,
  type HostConnection,
} from "../../../shared/types/remoteHosts.js";
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

/** A connection from untrusted input (IPC, the settings file), trimmed; null when unusable. */
export function parseHostConnection(value: unknown): HostConnection | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as { kind?: unknown; target?: unknown };
  switch (raw.kind) {
    case "ssh": {
      if (typeof raw.target !== "string") return null;
      const target = raw.target.trim();
      return isValidSshTarget(target) ? sshConnection(target) : null;
    }
    default:
      return null;
  }
}

/** {@link parseHostConnection}, throwing the user-facing VALIDATION error. */
export function requireHostConnection(value: unknown): HostConnection {
  const connection = parseHostConnection(value);
  if (!connection) {
    throw new AppError({
      code: "VALIDATION",
      message: "Not a usable host connection",
      userMessage: SSH_TARGET_HINT,
    });
  }
  return connection;
}

export { sshTargetOf };

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
  return `${connection.kind}:${formatHostConnection(connection)}`;
}
