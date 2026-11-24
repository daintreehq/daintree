import { SshAccessError, type LinkTransport } from "../client/transport.js";
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
  transportFor(bindingId: string, ensureRunning?: EnsureRunning): LinkTransport;
  forget(bindingId: string): void;
} {
  const transports = new Map<string, { generation: string; transport: LinkTransport }>();
  return {
    transportFor: (bindingId, ensureRunning) => ({
      open: async (signal, options) => {
        const access = deps.access();
        const route = await access.ensureAccess(bindingId, signal, {
          fresh: options?.fresh === true,
        });
        const generation = access.accessGeneration(bindingId) ?? "";
        let entry = transports.get(bindingId);
        if (!entry || entry.generation !== generation) {
          entry = { generation, transport: deps.ssh(route, ensureRunning) };
          transports.set(bindingId, entry);
        }
        try {
          return await entry.transport.open(signal, options);
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
    },
  };
}
