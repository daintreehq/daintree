/**
 * The guided relay removals (#16202) the spawn handler has sent, by terminal
 * id, until the removal's watcher takes each one up with the spawn it belongs
 * to. Only a spawn that follows one ran the removal. A plain shell spawned
 * under the id (a restart, a restore) spoils it for good, whichever of the two
 * was sent first, so the shell's answer and exit, which say nothing about
 * Cloudflare, are never taken for the removal's. Here rather than beside the
 * watcher, which loads only with Decisions, because the spawn handler loads at
 * startup.
 */
const launches = new Map<string, "sent" | "spoiled">();

export function noteRelayRemovalLaunch(terminalId: string): void {
  if (launches.get(terminalId) !== "spoiled") launches.set(terminalId, "sent");
}

/** A plain shell was spawned under `terminalId`: no removal launch under it can be confirmed. */
export function spoilRelayRemovalLaunch(terminalId: string): void {
  launches.set(terminalId, "spoiled");
}

/** Whether a removal launch was sent under `terminalId`, unspoiled, since the last take; taking clears it. */
export function takeRelayRemovalLaunch(terminalId: string): boolean {
  const state = launches.get(terminalId);
  launches.delete(terminalId);
  return state === "sent";
}

/** @internal Tests only. */
export function _resetRelayRemovalLaunchesForTesting(): void {
  launches.clear();
}
