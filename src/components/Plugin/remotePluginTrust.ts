import { isMac } from "@/lib/platform";
import { useHostConnection } from "@/hooks/useHostConnection";

/** How the person knows the machine in front of them. */
export function localMachineLabel(): string {
  return isMac() ? "this Mac" : "this computer";
}

/**
 * The second half of trusting a plugin from a window attached to another
 * machine: its main code runs on the host, but its views run here, in this
 * machine's renderer, with the same reach as any other view. Consent names
 * both machines. `subject` is the plugin's quoted name, or a pronoun for
 * several.
 */
export function remoteTrustSentence(
  subject: string,
  hostName: string,
  plural = false,
  localMachine = localMachineLabel()
): string {
  return `Trusting ${subject} on ${hostName} also runs ${plural ? "their" : "its"} view code on ${localMachine}.`;
}

/** {@link remoteTrustSentence} for this window, or null when it runs on this machine. */
export function useRemoteTrustSentence(subject: string, plural = false): string | null {
  const { hostId, hostName } = useHostConnection();
  if (hostId === null) return null;
  return remoteTrustSentence(subject, hostName ?? hostId, plural);
}
