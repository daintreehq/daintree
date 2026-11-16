import Fuse, { type FuseResult, type IFuseOptions } from "fuse.js";

interface IndexEntry {
  options: IFuseOptions<unknown>;
  fuse: Fuse<unknown>;
  query: string | null;
  hits: FuseResult<unknown>[];
}

// Keyed by the item array's identity, so an index lives exactly as long as
// the list it was built over. One entry per list: a caller that changes its
// options gets a rebuild rather than a second index held beside the first.
const indexes = new WeakMap<readonly unknown[], IndexEntry>();

/**
 * Searches `items` through a Fuse index built on the first search that needs
 * it, not when the list is produced: a palette that is closed, or open but
 * only browsed, builds nothing. The last query's hits are kept beside the
 * index, so a re-render that asks the same question again (a plugin reply, a
 * selection move, a second consumer of the same query) does not rerun Bitap.
 *
 * The returned array is shared between those callers and must not be mutated.
 */
export function searchFuseIndex<T>(
  items: readonly T[],
  options: IFuseOptions<T>,
  query: string
): readonly FuseResult<T>[] {
  let entry = indexes.get(items);
  if (!entry || entry.options !== options) {
    entry = {
      options: options as IFuseOptions<unknown>,
      fuse: new Fuse(items as unknown[], options as IFuseOptions<unknown>),
      query: null,
      hits: [],
    };
    indexes.set(items, entry);
  }
  if (entry.query !== query) {
    entry.hits = entry.fuse.search(query);
    entry.query = query;
  }
  return entry.hits as FuseResult<T>[];
}
