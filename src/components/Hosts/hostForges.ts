import type { HostForgeObservation, HostMetricsSummary } from "@shared/types/remoteHosts";

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

/** One provider in a few words, for the overview card. */
export function describeHostForgeShort(forge: HostForgeObservation): string {
  if (!forge.hasCredential) return `${forge.name} not connected`;
  if (forge.account) return `${forge.name} as ${forge.account}`;
  return `${forge.name} credential saved`;
}

/**
 * The card's line, and the sentences behind it. Null when the host reported
 * nothing, so the card shows no line rather than a guess.
 */
export function describeHostForges(
  summary: Pick<HostMetricsSummary, "forges"> | null,
  hostName: string
): { short: string; full: string } | null {
  const forges = summary?.forges;
  if (!forges) return null;
  if (forges.length === 0) {
    const none = `No forge providers on ${hostName}`;
    return { short: "None", full: none };
  }
  return {
    short: forges.map(describeHostForgeShort).join(" · "),
    full: forges.map((forge) => `${forge.name}: ${describeHostForge(forge, hostName)}`).join(". "),
  };
}
