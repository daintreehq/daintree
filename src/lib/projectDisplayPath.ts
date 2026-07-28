/** Longest suffix rendered before falling back to the full path. */
const MAX_SUFFIX_SEGMENTS = 4;

function segmentsOf(path: string): string[] {
  return path.replace(/\\/g, "/").split("/").filter(Boolean);
}

/**
 * Shortest trailing path fragment that tells each project apart from every
 * other registered project.
 *
 * A monorepo produces a dozen projects whose folders are `api`, `web`,
 * `service` — identical basenames under different parents. Showing the bare
 * basename makes them indistinguishable and showing the absolute path buries
 * the distinguishing segment behind a long shared prefix, so this grows each
 * project's suffix leftward only until it stops colliding: `payments/api` and
 * `identity/api` rather than `api`/`api` or two 60-character paths.
 *
 * Ties that survive {@link MAX_SUFFIX_SEGMENTS} (genuinely duplicated tails)
 * fall back to the full normalized path, which is unique by construction — the
 * project store canonicalizes paths, so two rows cannot share one.
 */
export function buildDisplayPaths(
  projects: ReadonlyArray<{ id: string; path: string }>
): Map<string, string> {
  const segmentsById = new Map<string, string[]>();
  for (const project of projects) {
    segmentsById.set(project.id, segmentsOf(project.path));
  }

  const result = new Map<string, string>();
  // Group by candidate suffix at each depth; anything still sharing a suffix
  // with another project grows one segment and is re-tested next round.
  let unresolved = projects.map((p) => p.id);

  for (let depth = 1; depth <= MAX_SUFFIX_SEGMENTS && unresolved.length > 0; depth++) {
    const bySuffix = new Map<string, string[]>();
    for (const id of unresolved) {
      const segments = segmentsById.get(id) ?? [];
      const suffix = segments.slice(-depth).join("/");
      const bucket = bySuffix.get(suffix);
      if (bucket) bucket.push(id);
      else bySuffix.set(suffix, [id]);
    }

    const stillUnresolved: string[] = [];
    for (const [suffix, ids] of bySuffix) {
      if (ids.length === 1) {
        result.set(ids[0]!, suffix);
        continue;
      }
      // Still colliding. Each id is judged on its own remaining depth: one that
      // has run out of segments cannot be grown further and settles here, while
      // its longer neighbours keep going. Testing only the bucket's first entry
      // would hand every id in the bucket that entry's verdict — which is how a
      // one-segment path silently stole the label from a deeper sibling.
      for (const id of ids) {
        const segments = segmentsById.get(id) ?? [];
        if (segments.length <= depth) result.set(id, suffix);
        else stillUnresolved.push(id);
      }
    }
    unresolved = stillUnresolved;
  }

  for (const id of unresolved) {
    const segments = segmentsById.get(id) ?? [];
    result.set(id, segments.join("/"));
  }

  // A filesystem root (or an empty path) has no segments at all, and an empty
  // label would render as a blank line the user can't act on.
  for (const project of projects) {
    if (!result.get(project.id)) result.set(project.id, project.path || "/");
  }

  return result;
}
