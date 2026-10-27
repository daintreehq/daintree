import { createHash } from "node:crypto";

/**
 * Cleanup started while a dictation still runs. At each pause the renderer
 * sends the passages a stop right then would send, and this starts them. A
 * stop whose passage is the same request takes the run already on its way
 * instead of starting another, so the wait after the stop shrinks by however
 * far it got: OpenAI's first token alone takes over a second. Any difference,
 * words said since, an edit, a prompt sent, a setting changed, is a different
 * key, and the stop starts its own as it always has.
 */

// The stop-time request follows its drain within a second or two; one this
// old belongs to a pause the speaker talked on past.
const PREFETCH_TTL_MS = 30_000;
// A dictation's tail is one passage, or a few split by paragraph breaks.
const MAX_PER_OWNER = 6;
const MAX_ENTRIES = 24;

interface Entry<T> {
  owner: string;
  key: string;
  controller: AbortController;
  value: T;
  latest: string | null;
  listener: ((text: string) => void) | null;
  timer: ReturnType<typeof setTimeout>;
}

export interface PrefetchStart<T> {
  key: string;
  /** Starts the run; `onText` hears its text so far as it streams. */
  start: (onText: (text: string) => void, signal: AbortSignal) => T;
}

/** A prefetched run, taken by the request it was made for. */
export interface TakenPrefetch<T> {
  value: T;
  /** The streamed text so far, for the stop to show at once. */
  latest: string | null;
  /** Hears the text streamed so far at once, then the rest as it comes. */
  follow: (listener: (text: string) => void) => void;
  /** Cancels a run the stop found it can't use after all. */
  cancel: () => void;
}

/**
 * The key a cleanup request is matched by: everything that shapes its reply
 * except the stream id, plus the settings it is answered with. Dictated text,
 * so it is hashed and never logged.
 */
export function prefetchKey(request: object, settings: object): string {
  const { streamId: _streamId, ...rest } = request as { streamId?: unknown };
  return createHash("sha256")
    .update(JSON.stringify([rest, settings], sortedKeys))
    .digest("hex");
}

// The same request built or parsed in another key order is the same request.
function sortedKeys(_key: string, value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
      a < b ? -1 : a > b ? 1 : 0
    )
  );
}

export class CorrectionPrefetcher<T> {
  private readonly entries = new Map<string, Entry<T>>();

  /**
   * Makes `requests` the owner's prefetches: one it already has keeps going,
   * and one it no longer asks for is cancelled, since the dictation moved on.
   * At most `budget` new runs start; returns how many did.
   */
  replace(owner: string, requests: readonly PrefetchStart<T>[], budget = Infinity): number {
    const wanted = new Set(requests.map((request) => request.key));
    for (const entry of [...this.entries.values()]) {
      if (entry.owner === owner && !wanted.has(entry.key)) this.drop(entry, true);
    }
    let started = 0;
    for (const request of requests.slice(0, MAX_PER_OWNER)) {
      const id = `${owner}\n${request.key}`;
      if (this.entries.has(id)) continue;
      if (started >= budget) break;
      this.evictOldest();
      const controller = new AbortController();
      const entry: Entry<T> = {
        owner,
        key: request.key,
        controller,
        value: undefined as T,
        latest: null,
        listener: null,
        timer: setTimeout(() => this.drop(entry, true), PREFETCH_TTL_MS),
      };
      entry.timer.unref?.();
      entry.value = request.start((text) => {
        entry.latest = text;
        entry.listener?.(text);
      }, controller.signal);
      this.entries.set(id, entry);
      started++;
    }
    return started;
  }

  /** The run prefetched for this request, if any. Taken once: the stop owns it from here. */
  take(owner: string, key: string): TakenPrefetch<T> | null {
    const entry = this.entries.get(`${owner}\n${key}`);
    if (!entry) return null;
    this.drop(entry, false);
    return {
      value: entry.value,
      latest: entry.latest,
      // The text so far is read as the listener joins, not as the run was
      // taken, so nothing streamed in between is missed.
      follow: (listener) => {
        entry.listener = listener;
        if (entry.latest !== null) listener(entry.latest);
      },
      cancel: () => entry.controller.abort(),
    };
  }

  /** Cancels every prefetch an owner holds, such as a session that ended without a stop. */
  clear(owner: string): void {
    for (const entry of [...this.entries.values()]) {
      if (entry.owner === owner) this.drop(entry, true);
    }
  }

  dispose(): void {
    for (const entry of [...this.entries.values()]) this.drop(entry, true);
  }

  get size(): number {
    return this.entries.size;
  }

  private evictOldest(): void {
    while (this.entries.size >= MAX_ENTRIES) {
      const oldest = this.entries.values().next().value;
      if (!oldest) return;
      this.drop(oldest, true);
    }
  }

  private drop(entry: Entry<T>, cancel: boolean): void {
    clearTimeout(entry.timer);
    this.entries.delete(`${entry.owner}\n${entry.key}`);
    if (cancel) entry.controller.abort();
  }
}
