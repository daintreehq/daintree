/**
 * Pure helpers behind the per-project copy-tree run history (#11732).
 *
 * Both live in `shared/` because the fallback label is needed by the main
 * process when it records a run, by the toolbar dropdown that renders it
 * (#11733), and by the MCP naming surface (#11734) — one derivation, three
 * consumers, no drift.
 */

import { basename } from "./path.js";
import {
  COPY_TREE_HISTORY_NAME_MAX_LENGTH,
  type CopyTreeHistoryRecord,
} from "../types/ipc/copyTreeHistory.js";
import type { CopyTreeOptions } from "../types/ipc/copyTree.js";

/**
 * Option fields whose array order carries no meaning: every one is an
 * any-match pattern or path set, so `["a","b"]` and `["b","a"]` select the same
 * files and must dedupe to one history entry.
 *
 * Deliberately an allowlist rather than a recursive sort of every array — a
 * future option whose order *is* significant then keeps its order by default
 * instead of being silently canonicalized into a different run.
 */
const UNORDERED_ARRAY_FIELDS = new Set<keyof CopyTreeOptions>([
  "filter",
  "exclude",
  "always",
  "includePaths",
  "scopePaths",
]);

/**
 * Normalize runtime options into the object that gets hashed for the dedupe
 * key. Absent fields are dropped (they let project settings back-fill at
 * merge time), while an explicit empty array is preserved — it blocks that
 * back-fill and so means something different from omission.
 *
 * Only the shape is normalized here; key ordering is handled downstream by the
 * stable hash.
 */
export function canonicalizeCopyTreeOptions(options?: CopyTreeOptions): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!options) return out;

  for (const [key, value] of Object.entries(options)) {
    if (value === undefined) continue;

    if (!UNORDERED_ARRAY_FIELDS.has(key as keyof CopyTreeOptions)) {
      out[key] = value;
      continue;
    }

    const list = typeof value === "string" ? [value] : value;
    if (!Array.isArray(list)) {
      // Shape the schema should have rejected. Keep it verbatim rather than
      // coercing, so two genuinely different malformed inputs stay distinct.
      out[key] = value;
      continue;
    }

    out[key] = [...new Set(list)].sort();
  }

  return out;
}

function toList(value: string | string[] | undefined): string[] {
  if (value === undefined) return [];
  return typeof value === "string" ? [value] : value;
}

/**
 * Label a set of values by its first entry (in canonical order, so the label is
 * stable across two runs that dedupe together) plus a count of the rest.
 */
function labelList(values: string[], render: (value: string) => string): string | null {
  const sorted = [...new Set(values)].sort();
  const first = sorted.find((value) => render(value).length > 0);
  if (first === undefined) return null;

  const label = render(first);
  return sorted.length > 1 ? `${label} +${sorted.length - 1} more` : label;
}

function truncateName(name: string): string {
  return name.length > COPY_TREE_HISTORY_NAME_MAX_LENGTH
    ? `${name.slice(0, COPY_TREE_HISTORY_NAME_MAX_LENGTH - 1).trimEnd()}…`
    : name;
}

/**
 * Fallback display name for a run, derived from its options.
 *
 * Ordered from the most concrete narrowing the caller chose to the least: an
 * explicit path selection beats a pattern, which beats a git-derived filter,
 * and a run that narrowed nothing is the full context.
 */
export function deriveCopyTreeRunName(options?: CopyTreeOptions): string {
  const scoped = labelList(toList(options?.scopePaths), (value) => basename(value));
  if (scoped) return truncateName(scoped);

  const included = labelList(toList(options?.includePaths), (value) => basename(value));
  if (included) return truncateName(included);

  const filtered = labelList(toList(options?.filter), (value) => value.trim());
  if (filtered) return truncateName(filtered);

  if (options?.modified) return "Modified files";
  if (options?.changed) return truncateName(`Changed since ${options.changed}`);

  return "Full context";
}

/**
 * Resolve the name to persist. A blank supplied name counts as absent so a
 * caller passing `""` gets the derived label rather than an unlabelled entry.
 */
export function resolveCopyTreeRunName(
  suppliedName: string | undefined,
  options: CopyTreeOptions | undefined
): string {
  const trimmed = suppliedName?.trim();
  return trimmed ? truncateName(trimmed) : deriveCopyTreeRunName(options);
}

/** Newest-first, as persisted. Exported for consumers that re-sort a snapshot. */
export function sortCopyTreeHistory(records: CopyTreeHistoryRecord[]): CopyTreeHistoryRecord[] {
  return [...records].sort((a, b) => b.lastUsedAt - a.lastUsedAt);
}
