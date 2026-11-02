/**
 * Whose typed input a terminal holds, as the pty host recorded it (#16094):
 * an assistant's own keys, or anyone else's.
 */
export interface TypedInputProvenance {
  lastStateChange?: number;
  /** Any typed input, whoever wrote it. */
  lastTypedInputAt?: number;
  /** The last typed input written for an assistant, and whose. */
  lastOwnedInput?: { owner: string; at: number };
  /** The last typed input anyone but `lastOwnedInput`'s owner wrote. */
  lastForeignInputAt?: number;
}

/**
 * Stamp typed input at `at`, and whose it was: an assistant's `inputOwner`, or
 * nobody's (a person, a broadcast, a staged draft). An assistant's keys keep
 * their writer; once another writes after them they are foreign too, which
 * keeps {@link foreignTypedInputAt} exact for every caller, not only the last.
 */
export function stampTypedInput(
  record: TypedInputProvenance,
  at: number,
  inputOwner?: string
): void {
  record.lastTypedInputAt = at;
  if (inputOwner === undefined) {
    record.lastForeignInputAt = at;
    return;
  }
  const previous = record.lastOwnedInput;
  if (previous !== undefined && previous.owner !== inputOwner) {
    record.lastForeignInputAt = Math.max(record.lastForeignInputAt ?? previous.at, previous.at);
  }
  record.lastOwnedInput = { owner: inputOwner, at };
}

/**
 * What was typed since the agent last settled, as `owner` sees it: nothing,
 * only keys written for `owner`, or someone else's input. With no settle seen,
 * everything ever typed counts as since.
 */
export type TypedSinceSettle = "nothing" | "own-keys" | "someone";

/**
 * The last typed input anyone but `owner` wrote. A record that names no
 * provenance at all counts every typed input as someone else's.
 */
export function foreignTypedInputAt(
  record: TypedInputProvenance,
  owner: string
): number | undefined {
  const owned = record.lastOwnedInput;
  const foreign = record.lastForeignInputAt;
  if (owned === undefined && foreign === undefined) return record.lastTypedInputAt;
  const other = owned !== undefined && owned.owner !== owner ? owned.at : undefined;
  if (other === undefined) return foreign;
  return foreign === undefined ? other : Math.max(foreign, other);
}

export function typedSinceSettle(record: TypedInputProvenance, owner: string): TypedSinceSettle {
  const since = (at: number | undefined): boolean =>
    at !== undefined && (record.lastStateChange === undefined || at >= record.lastStateChange);
  if (since(foreignTypedInputAt(record, owner))) return "someone";
  return since(record.lastTypedInputAt) ? "own-keys" : "nothing";
}

/** Whether someone other than `owner` typed after the `before` reading of {@link foreignTypedInputAt}. */
export function foreignInputMoved(
  record: TypedInputProvenance,
  owner: string,
  before: number | undefined
): boolean {
  const now = foreignTypedInputAt(record, owner);
  return now !== undefined && (before === undefined || now > before);
}
