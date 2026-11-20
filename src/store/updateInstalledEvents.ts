/**
 * Which terminals heard an update-installed event since a mark (#17905), so a
 * host record read before that event never overwrites what it said. Kept apart
 * from the listener so a reader doesn't load the panel store to ask.
 */
let eventCount = 0;
const lastEventAt = new Map<string, number>();

/** The next event's place in arrival order. */
export function nextUpdateInstalledSeq(): number {
  eventCount += 1;
  return eventCount;
}

/**
 * Record that a pane took an event, at the place it arrived: one held for a
 * pane that came later still dates from its arrival, not from when applied.
 */
export function noteUpdateInstalledEvent(terminalId: string, seq = nextUpdateInstalledSeq()): void {
  if ((lastEventAt.get(terminalId) ?? 0) < seq) lastEventAt.set(terminalId, seq);
}

/** A mark to take before reading host records. */
export function updateInstalledEventMark(): number {
  return eventCount;
}

/** An event for this terminal arrived after `mark`, so it is newer than a record read before it. */
export function updateInstalledChangedSince(terminalId: string, mark: number): boolean {
  return (lastEventAt.get(terminalId) ?? 0) > mark;
}

export function resetUpdateInstalledEvents(): void {
  lastEventAt.clear();
}
