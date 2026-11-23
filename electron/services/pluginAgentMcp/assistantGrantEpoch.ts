/**
 * A count of every time the user turned a plugin's tools off for a project's
 * Daintree Assistant in this run of Daintree, and the count each pair last
 * went off at (#18154). It orders a revocation against a notification raised
 * around it without the wall clock, which can move. Free to import: it holds
 * two numbers' worth of state and reads nothing.
 */
let offCount = 0;
const offAt = new Map<string, number>();

const keyOf = (projectId: string, pluginInstanceId: string): string =>
  `${projectId}\u0000${pluginInstanceId}`;

/** The count now: what a notification raised at this moment was raised under. */
export function assistantGrantEpoch(): number {
  return offCount;
}

/** The count this pair last went off at; 0 while it never has. */
export function assistantGrantOffEpoch(projectId: string, pluginInstanceId: string): number {
  return offAt.get(keyOf(projectId, pluginInstanceId)) ?? 0;
}

export function noteAssistantGrantOff(projectId: string, pluginInstanceId: string): void {
  offCount += 1;
  offAt.set(keyOf(projectId, pluginInstanceId), offCount);
}
