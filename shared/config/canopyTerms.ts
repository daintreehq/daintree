/** The dialog's title, the same in every state it renders: the feature named in full. */
export const CANOPY_TITLE = "Daintree Canopy";

/** What turning Canopy on does: said the same way on the offer and in Settings. */
export const CANOPY_LOCAL =
  "Canopy reads your agents' screens on this computer, with a small model it downloads the first time. Nothing it reads leaves this computer.";

/** How to turn it off again. */
export const CANOPY_STOP = "Turn it off at any time from Settings > Canopy.";

/** What turning Canopy on does on another host, whose own Canopy does the reading. */
export function canopyLocalOn(hostName: string): string {
  return `Canopy on ${hostName} reads its agents' screens there, with a small model it downloads the first time. No screen is sent to any service.`;
}

/** How to turn another host's Canopy off. */
export function canopyStopOn(hostName: string): string {
  return `Turn it off at any time from Settings > Canopy on ${hostName}.`;
}

/** The same said once for several hosts, each of which does its own reading. */
export function canopyLocalOnHosts(hostNames: readonly string[]): string {
  const names = hostNames.join(", ");
  return `Canopy on each of these hosts (${names}) reads its own agents' screens there, with a small model each downloads the first time. No screen is sent to any service.`;
}

/** How to turn any of those hosts' Canopy off. */
export const CANOPY_STOP_ON_EACH = "Turn it off at any time from Settings > Canopy on each host.";
