import { SshAccessError, type LinkTransport } from "../client/transport.js";
import type { CloudSshTrust } from "../../../shared/types/cloudHosts.js";
import type { CloudSshRoute } from "./CloudSshFiles.js";

/** ssh's words when the server's key isn't the one pinned for it. */
const HOST_KEY_REFUSED =
  /Host key verification failed|REMOTE HOST IDENTIFICATION HAS CHANGED|host key for .* has changed/i;

export interface CloudTransportAccess {
  ensureAccess(
    bindingId: string,
    signal?: AbortSignal,
    options?: { fresh?: boolean }
  ): Promise<CloudSshRoute>;
  accessGeneration(bindingId: string): string | null;
  /** After ssh refused the machine's key: looks at it again, and throws the review when it changed. */
  recheckHostKey(bindingId: string, signal?: AbortSignal): Promise<void>;
  dialTrust(bindingId: string): CloudDialSample | null;
}

/**
 * What one dial to a cloud machine rested on (#18258): the provider's
 * declared trust and the key its route pinned (null for none). `sshTrust` is
 * null when it can't be told, such as a route rewritten while ssh opened.
 */
export interface CloudDialTrust {
  providerId: string;
  sshTrust: CloudSshTrust | null;
  hostKey: string | null;
  /** Who vouched for `hostKey`, where the binding recorded it: the provider's API or the person. */
  pinOrigin: "provider" | "person" | null;
}

/** One look at what a dial would rest on, with a count that moves on every route rewrite. */
export interface CloudDialSample extends CloudDialTrust {
  revision: number;
}

type EnsureRunning = (signal: AbortSignal) => Promise<boolean>;

/**
 * Each cloud machine's link transport: one ssh transport per access
 * generation, so a machine's new address or key gets a fresh one. When ssh
 * itself refuses the machine's key (it changed after the last look), the
 * lifecycle looks again, so the refusal names the change and offers the new
 * key for review rather than leaving only ssh's words.
 */
export function createCloudTransports(deps: {
  access: () => CloudTransportAccess;
  ssh: (route: CloudSshRoute, ensureRunning?: EnsureRunning) => LinkTransport;
}): {
  /**
   * `hostId` names the host whose link this transport opens, so what each of
   * its dials rested on is kept for that host alone.
   */
  transportFor(bindingId: string, ensureRunning?: EnsureRunning, hostId?: string): LinkTransport;
  forget(bindingId: string): void;
  /**
   * What the host's last transport to open to this machine rested on;
   * undefined when none has opened for that host and machine.
   */
  dialledWith(hostId: string, bindingId: string): CloudDialTrust | undefined;
} {
  const transports = new Map<string, { generation: string; transport: LinkTransport }>();
  const dialled = new Map<string, { bindingId: string; trust: CloudDialTrust }>();
  return {
    transportFor: (bindingId, ensureRunning, hostId) => ({
      open: async (signal, options) => {
        const access = deps.access();
        const route = await access.ensureAccess(bindingId, signal, {
          fresh: options?.fresh === true,
        });
        const generation = access.accessGeneration(bindingId) ?? "";
        const trust = access.dialTrust(bindingId);
        let entry = transports.get(bindingId);
        if (!entry || entry.generation !== generation) {
          entry = { generation, transport: deps.ssh(route, ensureRunning) };
          transports.set(bindingId, entry);
        }
        try {
          const opened = await entry.transport.open(signal, options);
          // ssh reads the route's files as it connects: one rewritten meanwhile
          // leaves which pin it checked unknown.
          // Any rewrite meanwhile moves the revision, even one that ends where it began.
          const steady =
            trust !== null &&
            access.accessGeneration(bindingId) === generation &&
            sameDialSample(access.dialTrust(bindingId), trust);
          if (hostId !== undefined) {
            dialled.set(hostId, {
              bindingId,
              trust:
                steady && trust
                  ? {
                      providerId: trust.providerId,
                      sshTrust: trust.sshTrust,
                      hostKey: trust.hostKey,
                      pinOrigin: trust.pinOrigin,
                    }
                  : {
                      providerId: trust?.providerId ?? "",
                      sshTrust: null,
                      hostKey: null,
                      pinOrigin: null,
                    },
            });
          }
          return opened;
        } catch (error) {
          if (error instanceof SshAccessError && HOST_KEY_REFUSED.test(error.detail ?? "")) {
            await access.recheckHostKey(bindingId, signal);
          }
          throw error;
        }
      },
    }),
    forget: (bindingId) => {
      transports.delete(bindingId);
      for (const [hostId, record] of dialled) {
        if (record.bindingId === bindingId) dialled.delete(hostId);
      }
    },
    dialledWith: (hostId, bindingId) => {
      const record = dialled.get(hostId);
      return record?.bindingId === bindingId ? record.trust : undefined;
    },
  };
}

function sameDialSample(a: CloudDialSample | null, b: CloudDialSample): boolean {
  return (
    a !== null &&
    a.providerId === b.providerId &&
    a.sshTrust === b.sshTrust &&
    a.hostKey === b.hostKey &&
    a.pinOrigin === b.pinOrigin &&
    a.revision === b.revision
  );
}
