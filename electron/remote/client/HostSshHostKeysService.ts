import type { HostConnection, HostId } from "../../../shared/types/remoteHosts.js";
import type { HostSshTrust, HostSshTrustBasis } from "../../../shared/types/hostControl.js";
import {
  SshHostKeysAnswerSchema,
  type SshHostKeysAnswer,
} from "../../../shared/types/hostSshHostKeys.js";
import type { CloudSshTrust } from "../../../shared/types/cloudHosts.js";
import { hostKeyFingerprint, normalizeHostKey } from "../cloud/sshEndpoint.js";
import type { CloudDialTrust } from "../cloud/cloudTransport.js";
import { LinkMethod } from "../host/linkMethods.js";
import { parsePublicKeyFile } from "../host/sshPublicKey.js";
import type { LinkSession } from "../link/session.js";

/** Past the Host's own 6 s bound on its read, so a slow read answers `timed-out` rather than nothing. */
export const SSH_HOST_KEYS_READ_TIMEOUT_MS = 10_000;

/**
 * One reading of a host's SSH host keys (#18258), or why there is none. A
 * reading carries the trust behind the link it came over, as that link was
 * dialled, and the key Daintree pinned for it (null for none).
 */
export type HostSshHostKeysRead =
  | { status: "read"; trust: HostSshTrust; pinnedKey: string | null; answer: SshHostKeysAnswer }
  | { status: "not-found" }
  /** No open link now, or the one asked closed or was replaced before it answered. */
  | { status: "disconnected" }
  /** A Host from before the read (#18257). */
  | { status: "unsupported" }
  /** The link stayed open but no answer came in time. */
  | { status: "no-answer" }
  | { status: "rate-limited" }
  /** The caller gave up first. */
  | { status: "cancelled" }
  /** The Host answered with something that isn't a reading. */
  | { status: "invalid-answer" }
  | { status: "failed" };

export interface HostSshHostKeysServiceDeps {
  /** How this Shell reaches the host; null when it isn't one of its hosts. */
  connectionOf(hostId: HostId): HostConnection | null;
  /** The host's open link session now, or null. */
  sessionOf(hostId: HostId): LinkSession | null;
  /** Keeps the host's link open while the read is out. */
  hold(hostId: HostId): () => void;
  onSessionOpened(listener: (hostId: HostId, session: LinkSession) => void): () => void;
  /** What the host's last transport to open to that cloud machine rested on. */
  cloudDialledWith?(hostId: HostId, bindingId: string): CloudDialTrust | undefined;
}

interface SessionTrust {
  trust: HostSshTrust;
  pinnedKey: string | null;
}

const PINNED_BASIS: Record<Exclude<CloudSshTrust, "provider-tunnel">, HostSshTrustBasis> = {
  "pinned-from-api": "provider-pin",
  "confirm-on-first-connect": "person-confirmed-pin",
  "api-or-confirm": "provider-or-person-pin",
};

function cloudTrust(dial: CloudDialTrust | undefined): SessionTrust {
  const providerId = dial?.providerId ? dial.providerId : null;
  const unknown = {
    trust: { basis: "unknown" as const, providerId, pinnedFingerprint: null },
    pinnedKey: null,
  };
  if (!dial || dial.sshTrust === null) return unknown;
  const pinnedKey = normalizeHostKey(dial.hostKey);
  if (dial.sshTrust === "provider-tunnel") {
    // The route pins nothing under a tunnel; a key on record would be a contradiction.
    return dial.hostKey === null
      ? {
          trust: { basis: "provider-tunnel", providerId, pinnedFingerprint: null },
          pinnedKey: null,
        }
      : unknown;
  }
  if (pinnedKey === null) return unknown;
  return {
    trust: {
      basis: PINNED_BASIS[dial.sshTrust],
      providerId,
      pinnedFingerprint: hostKeyFingerprint(pinnedKey),
    },
    pinnedKey,
  };
}

function errorCode(error: unknown): string | null {
  if (typeof error !== "object" || error === null || !("code" in error)) return null;
  return typeof error.code === "string" ? error.code : null;
}

/**
 * Reads a connected host's SSH host public keys over its link (#18258), for
 * the assistant's `host.sshHostKeys` and Settings → Hosts (#18259). It never
 * dials: a host with no open link answers `disconnected`. The trust each
 * reading names is taken when its link session opens, from what that dial
 * rested on, so a pin rewritten later never labels an older link.
 */
export class HostSshHostKeysService {
  private readonly trustBySession = new WeakMap<LinkSession, SessionTrust>();
  private readonly offSessions: () => void;

  constructor(private readonly deps: HostSshHostKeysServiceDeps) {
    this.offSessions = deps.onSessionOpened((hostId, session) => {
      const trust = this.trustNow(hostId);
      if (trust) this.trustBySession.set(session, trust);
    });
  }

  dispose(): void {
    this.offSessions();
  }

  private trustNow(hostId: HostId): SessionTrust | null {
    const connection = this.deps.connectionOf(hostId);
    if (!connection) return null;
    switch (connection.kind) {
      case "ssh":
        return {
          trust: { basis: "own-ssh-config", providerId: null, pinnedFingerprint: null },
          pinnedKey: null,
        };
      case "wsl":
        return {
          trust: { basis: "local-wsl", providerId: null, pinnedFingerprint: null },
          pinnedKey: null,
        };
      case "cloud":
        return cloudTrust(this.deps.cloudDialledWith?.(hostId, connection.bindingId));
    }
  }

  async read(hostId: HostId, signal?: AbortSignal): Promise<HostSshHostKeysRead> {
    if (!this.deps.connectionOf(hostId)) return { status: "not-found" };
    const session = this.deps.sessionOf(hostId);
    if (!session || !session.isOpen) return { status: "disconnected" };
    // A session opened before this service was told of it has no dial on
    // record: only a cloud machine's trust depends on one.
    const connection = this.deps.connectionOf(hostId);
    const trust: SessionTrust = this.trustBySession.get(session) ??
      (connection && connection.kind !== "cloud" ? this.trustNow(hostId) : null) ?? {
        trust: { basis: "unknown", providerId: null, pinnedFingerprint: null },
        pinnedKey: null,
      };
    const current = () => session.isOpen && this.deps.sessionOf(hostId) === session;
    const release = this.deps.hold(hostId);
    let answer: unknown;
    try {
      answer = await session.call(LinkMethod.SSH_HOST_KEYS, null, {
        timeoutMs: SSH_HOST_KEYS_READ_TIMEOUT_MS,
        ...(signal ? { signal } : {}),
      });
    } catch (error) {
      if (signal?.aborted) return { status: "cancelled" };
      if (!current()) return { status: "disconnected" };
      switch (errorCode(error)) {
        case "UNSUPPORTED":
          return { status: "unsupported" };
        case "HOST_DISCONNECTED":
          return { status: "disconnected" };
        case "OUTCOME_UNKNOWN":
          return { status: "no-answer" };
        case "RATE_LIMITED":
          return { status: "rate-limited" };
        default:
          return { status: "failed" };
      }
    } finally {
      release();
    }
    if (signal?.aborted) return { status: "cancelled" };
    if (!current()) return { status: "disconnected" };
    const parsed = SshHostKeysAnswerSchema.safeParse(answer);
    if (!parsed.success || !keysAgree(parsed.data)) return { status: "invalid-answer" };
    return { status: "read", trust: trust.trust, pinnedKey: trust.pinnedKey, answer: parsed.data };
  }
}

/**
 * Every key the Host read is one OpenSSH key whose type and fingerprint are
 * the ones the Host named beside it, as this Shell parses it: a row that
 * disagrees with itself could otherwise be shown as the pin.
 */
function keysAgree(answer: SshHostKeysAnswer): boolean {
  if (answer.status !== "reading") return true;
  return answer.listeners.every((listener) =>
    listener.keys.every((key) => {
      if (key.outcome !== "read") return true;
      const parsed = parsePublicKeyFile(key.publicKey);
      return (
        parsed !== null &&
        parsed.publicKey === key.publicKey &&
        parsed.type === key.type &&
        parsed.fingerprint === key.fingerprint
      );
    })
  );
}

/** Whether a key the Host read is the one Daintree pinned, by its blob; null when none is pinned. */
export function matchesPinnedKey(publicKey: string, pinnedKey: string | null): boolean | null {
  if (pinnedKey === null) return null;
  const read = normalizeHostKey(publicKey);
  return read !== null && hostKeyFingerprint(read) === hostKeyFingerprint(pinnedKey);
}
