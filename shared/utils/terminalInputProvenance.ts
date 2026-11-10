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

/**
 * Input the agent could have taken as a prompt (#16187), with whose it was:
 * keys typed anywhere but an approval dialog, and a submission someone made
 * through the lane. Recorded when the input arrives, from the state the host
 * held then, so a later approval key can't hide an earlier prompt.
 */
export interface PromptInputProvenance {
  /** The last such input an assistant wrote, and whose. */
  lastOwnedPromptInput?: { owner: string; at: number };
  /** The last such input anyone but `lastOwnedPromptInput`'s owner wrote. */
  lastForeignPromptInputAt?: number;
}

/** Whether keys arriving now reach the agent's prompt rather than an approval dialog's selector. */
export function keysReachPrompt(state: { agentState?: string; waitingReason?: string }): boolean {
  return !(state.agentState === "waiting" && state.waitingReason === "approval");
}

/** As {@link stampTypedInput}, for {@link PromptInputProvenance}. */
export function stampPromptInput(
  record: PromptInputProvenance,
  at: number,
  inputOwner?: string
): void {
  if (inputOwner === undefined) {
    record.lastForeignPromptInputAt = at;
    return;
  }
  const previous = record.lastOwnedPromptInput;
  if (previous !== undefined && previous.owner !== inputOwner) {
    record.lastForeignPromptInputAt = Math.max(
      record.lastForeignPromptInputAt ?? previous.at,
      previous.at
    );
  }
  record.lastOwnedPromptInput = { owner: inputOwner, at };
}

/** The last prompt-capable input anyone but `owner` wrote. */
export function foreignPromptInputAt(
  record: PromptInputProvenance,
  owner: string
): number | undefined {
  const owned = record.lastOwnedPromptInput;
  const other = owned !== undefined && owned.owner !== owner ? owned.at : undefined;
  const foreign = record.lastForeignPromptInputAt;
  if (other === undefined) return foreign;
  return foreign === undefined ? other : Math.max(foreign, other);
}

/** Whether someone other than `owner` wrote prompt-capable input after the `before` reading of {@link foreignPromptInputAt}. */
export function foreignPromptInputMoved(
  record: PromptInputProvenance,
  owner: string,
  before: number | undefined
): boolean {
  const now = foreignPromptInputAt(record, owner);
  return now !== undefined && (before === undefined || now > before);
}

/**
 * The owner a held composer send's line is filed under once written (#16379):
 * the person's prompt, so an Assistant's prompt held for the same pane drops
 * as overtaken. NUL-led, so no Assistant principal can spell it.
 */
export const COMPOSER_PROMPT_OWNER = "\u0000composer";
