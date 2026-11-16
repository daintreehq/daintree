import Fuse, { type FuseResult, type IFuseOptions } from "fuse.js";

interface IndexEntry<T> {
  fuse: Fuse<T>;
  query: string | null;
  hits: readonly FuseResult<T>[];
}

export type FuseSearch<T> = (items: readonly T[], query: string) => readonly FuseResult<T>[];

/**
 * A search over `options` that indexes a list on the first search that needs
 * it, not when the list is produced: a palette that is closed, or open but
 * only browsed, builds nothing. Indexes are keyed by the list's identity, so
 * each lives exactly as long as the list it was built over, and the last
 * query's hits are kept beside it, so a re-render that asks the same question
 * again (a plugin reply, a selection move) does not rerun Bitap.
 *
 * Returned arrays are shared between those callers and must not be mutated.
 */
export function createFuseSearch<T>(options: IFuseOptions<T>): FuseSearch<T> {
  const indexes = new WeakMap<readonly T[], IndexEntry<T>>();
  return (items, query) => {
    let entry = indexes.get(items);
    if (!entry) {
      entry = { fuse: new Fuse(items, options), query: null, hits: [] };
      indexes.set(items, entry);
    }
    if (entry.query !== query) {
      entry.hits = entry.fuse.search(query);
      entry.query = query;
    }
    return entry.hits;
  };
}
