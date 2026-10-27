import type { ForgeNumberReference } from "@shared/types/forge";
import { forgeClient } from "@/clients";

/**
 * What the bare `#N`s in composer drafts name (#14849), shared by every
 * composer. A number is asked about once until its answer goes stale, and each
 * repository has one request in flight at a time: numbers that come up while
 * it runs wait and go together in the next one. Keyed by the cwd main resolves
 * the repository from.
 */

/** The badges' tooltip TTL: a reference's title and state can't be staler than theirs. */
const FOUND_TTL_MS = 300_000;
/** A number that names nothing may be the next issue someone opens. */
const MISSING_TTL_MS = 60_000;
/** A failed or rate-limited lookup waits this long before it is tried again. */
const UNANSWERED_RETRY_MS = 60_000;
/** The badges' credential re-check: a token saved in Settings shows up within this. */
const UNAVAILABLE_TTL_MS = 30_000;
/** Main answers this many distinct numbers per request. */
const REQUEST_BATCH = 50;
/** Numbers remembered across all repositories before the oldest are forgotten. */
const MAX_REMEMBERED = 1000;

interface Answer {
  /** `null` for a number that names nothing; `undefined` until something was learned. */
  reference: ForgeNumberReference | null | undefined;
  askAfter: number;
}

interface Scope {
  /** Numbers waiting for the next request. */
  queued: Set<number>;
  /** Numbers the request in flight carries. */
  asking: Set<number>;
  running: Promise<void> | null;
}

const answers = new Map<string, Answer>();
const scopes = new Map<string, Scope>();
const unavailableUntil = new Map<string, number>();
const invalidationListeners = new Set<() => void>();
// Bumped by every invalidation, so a request in flight then can't write back
// what the invalidation just cleared.
let generation = 0;

const keyOf = (cwd: string, number: number) => `${cwd}\0${number}`;

function remember(key: string, answer: Answer): void {
  answers.delete(key);
  answers.set(key, answer);
  if (answers.size > MAX_REMEMBERED) {
    const oldest = answers.keys().next().value;
    if (oldest !== undefined) answers.delete(oldest);
  }
}

function isUnavailable(cwd: string, now: number): boolean {
  const until = unavailableUntil.get(cwd);
  if (until === undefined) return false;
  if (now < until) return true;
  unavailableUntil.delete(cwd);
  return false;
}

/**
 * The references known for `numbers`, stale ones included: one being re-read
 * keeps its look until an answer replaces it, rather than flickering plain.
 */
export function knownForgeReferences(
  cwd: string,
  numbers: readonly number[]
): Map<number, ForgeNumberReference> {
  const known = new Map<number, ForgeNumberReference>();
  if (isUnavailable(cwd, Date.now())) return known;
  for (const number of numbers) {
    const reference = answers.get(keyOf(cwd, number))?.reference;
    if (reference) known.set(number, reference);
  }
  return known;
}

/**
 * Ask about the numbers in `numbers` with no fresh answer, and settle once the
 * repository's queue has drained. Nothing is asked while lookups are
 * unavailable for `cwd`.
 */
export async function lookUpForgeReferences(
  cwd: string,
  numbers: readonly number[]
): Promise<void> {
  subscribeToRemoteChanges();
  const now = Date.now();
  if (isUnavailable(cwd, now)) return;

  let scope = scopes.get(cwd);
  for (const number of numbers) {
    if (scope?.queued.has(number) || scope?.asking.has(number)) continue;
    const answer = answers.get(keyOf(cwd, number));
    if (answer && now < answer.askAfter) continue;
    if (!scope) {
      scope = { queued: new Set(), asking: new Set(), running: null };
      scopes.set(cwd, scope);
    }
    scope.queued.add(number);
  }
  if (!scope) return;

  // A drain that is just finishing can miss what was queued after its last
  // check, so keep draining until nothing is queued or running.
  while (scopes.get(cwd) === scope && (scope.queued.size > 0 || scope.running)) {
    await (scope.running ?? drain(cwd, scope));
  }
}

function drain(cwd: string, scope: Scope): Promise<void> {
  const askedIn = generation;
  scope.running = (async () => {
    while (scope.queued.size > 0 && askedIn === generation) {
      const batch = [...scope.queued].slice(0, REQUEST_BATCH);
      for (const number of batch) {
        scope.queued.delete(number);
        scope.asking.add(number);
      }
      try {
        await askMain(cwd, batch, askedIn);
      } finally {
        scope.asking.clear();
      }
      if (isUnavailable(cwd, Date.now())) scope.queued.clear();
    }
  })().finally(() => {
    scope.running = null;
  });
  return scope.running;
}

async function askMain(cwd: string, numbers: number[], askedIn: number): Promise<void> {
  let results: Awaited<ReturnType<typeof forgeClient.getReferencesByNumbers>> | undefined;
  try {
    results = await forgeClient.getReferencesByNumbers(cwd, numbers);
  } catch {
    results = undefined;
  }
  if (askedIn !== generation) return;
  const now = Date.now();

  if (results === null) {
    unavailableUntil.set(cwd, now + UNAVAILABLE_TTL_MS);
    return;
  }

  const outcomes = new Map((results ?? []).map((result) => [result.number, result]));
  for (const number of numbers) {
    const key = keyOf(cwd, number);
    const outcome = outcomes.get(number);
    if (outcome?.status === "found") {
      remember(key, { reference: outcome.reference, askAfter: now + FOUND_TTL_MS });
    } else if (outcome?.status === "not_found") {
      remember(key, { reference: null, askAfter: now + MISSING_TTL_MS });
    } else {
      // No answer says nothing about the number: keep what was known.
      remember(key, {
        reference: answers.get(key)?.reference,
        askAfter: now + UNANSWERED_RETRY_MS,
      });
    }
  }
}

/**
 * Forget everything and tell the composers holding marks, so they draw from
 * scratch: a sidebar refresh re-reads references as it re-reads the badges,
 * and a changed remote may point at another repository altogether.
 */
export function invalidateForgeReferences(): void {
  generation += 1;
  answers.clear();
  scopes.clear();
  unavailableUntil.clear();
  for (const listener of [...invalidationListeners]) listener();
}

/** Hear about {@link invalidateForgeReferences}; returns the unsubscribe. */
export function onForgeReferencesInvalidated(listener: () => void): () => void {
  invalidationListeners.add(listener);
  return () => {
    invalidationListeners.delete(listener);
  };
}

let unsubscribeRemote: (() => void) | null = null;

// Subscribed on first use rather than at import, when the bridge may not be up.
function subscribeToRemoteChanges(): void {
  if (unsubscribeRemote) return;
  const forge = typeof window !== "undefined" ? window.electron?.forge : undefined;
  if (typeof forge?.onRemoteChanged !== "function") return;
  unsubscribeRemote = forge.onRemoteChanged(invalidateForgeReferences);
}

if (typeof window !== "undefined") {
  window.addEventListener("daintree:refresh-sidebar", invalidateForgeReferences);
  import.meta.hot?.dispose(() => {
    window.removeEventListener("daintree:refresh-sidebar", invalidateForgeReferences);
    unsubscribeRemote?.();
  });
}
