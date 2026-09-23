// Readable, collision-free names for worktree ids, which are absolute paths.
// Shared by every surface that has to name a worktree it may not have a stored
// name for: the Pilot's group headings and the dev server dashboard.

function pathSegments(id: string): string[] {
  return id.split(/[/\\]+/).filter((segment) => segment.length > 0);
}

function trailingSegments(segments: readonly string[], depth: number): string {
  return segments.slice(Math.max(0, segments.length - depth)).join("/");
}

/**
 * The shortest trailing path fragment that tells each worktree from the others.
 *
 * A basename alone is the label worth reading — "feature-auth", not four levels
 * of checkout directory — but two worktrees in one project sharing a basename
 * is ordinary (`repos/a/feature-x` beside `repos/b/feature-x`), and two headers
 * reading the same word file their agents under a distinction the user cannot
 * see. Each colliding id grows one segment at a time until it stands alone, so
 * only the ids that actually collide pay for the disambiguation.
 *
 * Collisions are detected case-insensitively because the case-preserving
 * filesystems this runs on treat those paths as the same name to read, even
 * where they are distinct paths to open. Anything still ambiguous at full depth
 * differs only in case or above its own root, and falls back to the whole id —
 * the one string guaranteed to be unique, since the ids were map keys.
 */
export function worktreeLabels(ids: readonly string[]): Map<string, string> {
  const segments = new Map(ids.map((id) => [id, pathSegments(id)]));
  const labels = new Map<string, string>();
  const unresolved = new Set(ids);

  let maxDepth = 1;
  for (const parts of segments.values()) maxDepth = Math.max(maxDepth, parts.length);

  for (let depth = 1; depth <= maxDepth && unresolved.size > 0; depth++) {
    const byLabel = new Map<string, string[]>();
    for (const id of unresolved) {
      const label = trailingSegments(segments.get(id) ?? [], depth) || id;
      const bucket = byLabel.get(label.toLowerCase());
      if (bucket) bucket.push(id);
      else byLabel.set(label.toLowerCase(), [id]);
    }
    for (const contenders of byLabel.values()) {
      const only = contenders.length === 1 ? contenders[0] : undefined;
      if (only === undefined) continue;
      labels.set(only, trailingSegments(segments.get(only) ?? [], depth) || only);
      unresolved.delete(only);
    }
  }

  for (const id of unresolved) labels.set(id, id);
  return labels;
}
