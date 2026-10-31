import type { HostForgeObservation } from "@shared/types/remoteHosts";

/**
 * A host's forge connections as the host itself reports them. Each host signs
 * in for itself, so every line names the host it describes. These are the
 * host's observations: a saved credential whose account the provider hasn't
 * reported is said to be saved, never assumed signed in.
 */

/** One provider, as a full sentence naming the host. */
export function describeHostForge(forge: HostForgeObservation, hostName: string): string {
  if (!forge.hasCredential) return `${forge.name} isn't connected on ${hostName}`;
  if (forge.account) return `Signed in as ${forge.account} on ${hostName}`;
  return `A credential is saved on ${hostName}, and it hasn't reported an account`;
}
