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
const UNORDERED_ARRAY_FIELDS = new Set<keyof CopyTreeOptions>(["exclude", "always", "scopePaths"]);

/**
 * `filter` and `includePaths` are two spellings of one thing. `CopyTreeService`
 * unions them into the SDK's single `filter` set, and `mergeCopyTreeOptions`
 * back-fills neither from project settings, so the two carry no independent
 * meaning by the time a run happens. Hashing them separately would file the
 * same run under two history entries.
 */
const SELECTION_FIELDS = ["filter", "includePaths"] as const;

function toArray(value: unknown): string[] | null {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value as string[];
  return null;
}

/**
 * Normalize runtime options into the object that gets hashed for the dedupe
 * key. Absent fields are dropped (they let project settings back-fill at
 * merge time), while an explicit empty array is preserved — it blocks that
 * back-fill and so means something different from omission.
 *
 * The result is a hash input, not a usable options object: the selection fields
 * are folded into one synthetic key. Only the shape is normalized here; key
 * ordering is handled downstream by the stable hash.
 */
export function canonicalizeCopyTreeOptions(options?: CopyTreeOptions): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!options) return { options: out };

  for (const [key, value] of Object.entries(options)) {
    if (value === undefined) continue;
    // Explicit `false` is the default spelled out, and builds a byte-identical
    // bundle to omitting it — so it must dedupe onto the same entry rather than
    // splitting one run into two history rows (#11750). Only the exact boolean
    // is folded away: `true` changes the bundle, and any other value is a shape
    // the schemas rejected and stays verbatim so two malformed inputs differ.
    if (key === "scopeIgnoresIgnoreFiles" && value === false) continue;
    if ((SELECTION_FIELDS as readonly string[]).includes(key)) continue;

    if (!UNORDERED_ARRAY_FIELDS.has(key as keyof CopyTreeOptions)) {
      out[key] = value;
      continue;
    }

    const list = toArray(value);
    if (!list) {
      // Shape the schema should have rejected. Keep it verbatim rather than
      // coercing, so two genuinely different malformed inputs stay distinct.
      out[key] = value;
      continue;
    }

    out[key] = [...new Set(list)].sort();
  }

  const selection: string[] = [];
  let hasSelection = false;
  for (const field of SELECTION_FIELDS) {
    const value = options[field];
    if (value === undefined) continue;
    hasSelection = true;
    const list = toArray(value);
    if (list) selection.push(...list);
  }

  // Two namespaces rather than a synthetic key alongside the real ones: a
  // future `CopyTreeOptions.selection` field would otherwise canonicalize into
  // the same slot as today's folded `filter`/`includePaths` and either collide
  // with it or be overwritten by it.
  return hasSelection
    ? { options: out, selection: [...new Set(selection)].sort() }
    : { options: out };
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
  // Deduplicate on the source value, not the rendered one: two folders that
  // share a basename (`src/a`, `lib/a`) are two selections, and collapsing them
  // would under-report the count rather than merely being ambiguous.
  const rendered = [...new Set(values)]
    .sort()
    .map(render)
    .filter((label) => label.length > 0);

  // Destructured rather than indexed: under `noUncheckedIndexedAccess` a
  // `rendered[0]` read stays `string | undefined` however the length was
  // checked, and this function promises `string | null`.
  const [first, ...rest] = rendered;
  if (first === undefined) return null;

  return rest.length > 0 ? `${first} +${rest.length} more` : first;
}

/**
 * Bound the stored name without cutting through a character. A plain `slice`
 * splits a surrogate pair — an emoji straddling the limit would persist as a
 * lone surrogate, which renders as a replacement glyph and breaks equality
 * against the same name derived elsewhere.
 */
function truncateName(name: string): string {
  if (name.length <= COPY_TREE_HISTORY_NAME_MAX_LENGTH) return name;

  let out = "";
  for (const char of name) {
    if (out.length + char.length > COPY_TREE_HISTORY_NAME_MAX_LENGTH - 1) break;
    out += char;
  }
  return `${out.trimEnd()}…`;
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
