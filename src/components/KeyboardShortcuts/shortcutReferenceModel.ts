import Fuse from "fuse.js";
import { KEYBINDING_CATEGORY_ORDER } from "@shared/config/defaultKeybindings";
import { MODIFIER_SEARCH_MAP, isChordPrefix, normalizeQuery } from "@/lib/kbdShortcut";

/** The slice of a registered binding the reference needs. */
export interface ReferenceBinding {
  actionId: string;
  scope: string;
  description?: string;
  category?: string;
  effectiveCombo: string;
}

export interface ShortcutAlternative {
  combo: string;
  scope: string;
}

/**
 * One row of the reference: an action (or several actions that do the same
 * thing) with every key that currently fires it.
 */
export interface ShortcutEntry {
  id: string;
  actionIds: string[];
  description: string;
  category: string;
  /** Bound keys only; empty means nothing is bound. */
  alternatives: ShortcutAlternative[];
  /** The user changed or cleared at least one of the keys. */
  isCustom: boolean;
  /** Set when a numbered family ("Focus terminal 1…9") was folded into this row. */
  collapsedFrom?: string[];
}

const FALLBACK_CATEGORY = "Other";

/**
 * Build the reference rows. An action registered twice (⌘W and ⌃F4) is one row
 * with both keys, and so are distinct actions described identically in the same
 * category (the two ways to open this dialog) — listing either twice reads as a
 * duplicate at best, and as a conflict at worst.
 */
export function buildShortcutEntries(
  bindings: readonly ReferenceBinding[],
  hasOverride: (actionId: string) => boolean
): ShortcutEntry[] {
  const entries: ShortcutEntry[] = [];
  const byAction = new Map<string, ShortcutEntry>();
  const byDescription = new Map<string, ShortcutEntry>();

  for (const binding of bindings) {
    const category = binding.category || FALLBACK_CATEGORY;
    const description = binding.description || binding.actionId;
    const descriptionKey = `${category}\u0000${description}`;

    let entry = byAction.get(binding.actionId) ?? byDescription.get(descriptionKey);
    if (!entry) {
      entry = {
        id: `${category}\u0000${binding.actionId}`,
        actionIds: [],
        description,
        category,
        alternatives: [],
        isCustom: false,
      };
      entries.push(entry);
      byDescription.set(descriptionKey, entry);
    }
    byAction.set(binding.actionId, entry);

    if (!entry.actionIds.includes(binding.actionId)) entry.actionIds.push(binding.actionId);
    if (hasOverride(binding.actionId)) entry.isCustom = true;

    const combo = binding.effectiveCombo.trim();
    if (!combo) continue;
    const duplicate = entry.alternatives.find(
      (alt) => alt.combo.toLowerCase() === combo.toLowerCase()
    );
    if (duplicate) {
      // The same key reached through two scopes is effectively unscoped.
      if (duplicate.scope !== binding.scope) duplicate.scope = "global";
      continue;
    }
    entry.alternatives.push({ combo, scope: binding.scope });
  }

  return entries;
}

const SERIES_DESCRIPTION = /^(.*\S) (\d)$/;
const SERIES_COMBO = /^(.*\+)(\d)$/;
const MIN_SERIES = 3;

interface SeriesMember {
  stem: string;
  prefix: string;
  digit: number;
  scope: string;
}

function seriesMember(entry: ShortcutEntry): SeriesMember | null {
  if (entry.isCustom || entry.alternatives.length !== 1) return null;
  const alt = entry.alternatives[0]!;
  const description = SERIES_DESCRIPTION.exec(entry.description);
  const combo = SERIES_COMBO.exec(alt.combo);
  if (!description || !combo || description[2] !== combo[2]) return null;
  return {
    stem: description[1]!,
    prefix: combo[1]!,
    digit: Number(description[2]),
    scope: alt.scope,
  };
}

/**
 * Fold a run of numbered rows ("Switch to worktree 1" … "9", on ⌥⌘1 … ⌥⌘9)
 * into one row. Only an intact run folds: consecutive digits, one key each on
 * a shared prefix, nothing customised. A family the user has changed stays
 * expanded, so the changed member is never hidden inside a range.
 */
export function collapseNumberedSeries(entries: readonly ShortcutEntry[]): ShortcutEntry[] {
  const out: ShortcutEntry[] = [];
  let i = 0;
  while (i < entries.length) {
    const first = seriesMember(entries[i]!);
    let end = i + 1;
    if (first) {
      while (end < entries.length) {
        const next = seriesMember(entries[end]!);
        const previousDigit = first.digit + (end - i - 1);
        if (
          !next ||
          entries[end]!.category !== entries[i]!.category ||
          next.stem !== first.stem ||
          next.prefix !== first.prefix ||
          next.scope !== first.scope ||
          next.digit !== previousDigit + 1
        ) {
          break;
        }
        end++;
      }
    }

    if (first && end - i >= MIN_SERIES) {
      const run = entries.slice(i, end);
      const lastDigit = first.digit + run.length - 1;
      out.push({
        id: `${run[0]!.id}\u0000series`,
        actionIds: run.flatMap((entry) => entry.actionIds),
        description: `${first.stem} ${first.digit}–${lastDigit}`,
        category: run[0]!.category,
        alternatives: [{ combo: `${first.prefix}${first.digit}–${lastDigit}`, scope: first.scope }],
        isCustom: false,
        collapsedFrom: run.map((entry) => entry.description),
      });
      i = end;
    } else {
      out.push(entries[i]!);
      i++;
    }
  }
  return out;
}

const CATEGORY_RANK = new Map(KEYBINDING_CATEGORY_ORDER.map((name, index) => [name, index]));

/** Browse order: the curated sequence, then anything else (a plugin's) alphabetically. */
export function orderCategories(categories: Iterable<string>): string[] {
  return [...new Set(categories)].sort((a, b) => {
    const rankA = CATEGORY_RANK.get(a);
    const rankB = CATEGORY_RANK.get(b);
    if (rankA !== undefined && rankB !== undefined) return rankA - rankB;
    if (rankA !== undefined) return -1;
    if (rankB !== undefined) return 1;
    return a.localeCompare(b);
  });
}

export interface ShortcutGroup {
  category: string;
  entries: ShortcutEntry[];
}

export function groupByCategory(entries: readonly ShortcutEntry[]): ShortcutGroup[] {
  const groups = new Map<string, ShortcutEntry[]>();
  for (const entry of entries) {
    const list = groups.get(entry.category) ?? [];
    list.push(entry);
    groups.set(entry.category, list);
  }
  return orderCategories(groups.keys()).map((category) => ({
    category,
    entries: collapseNumberedSeries(groups.get(category)!),
  }));
}

const SCOPE_LABELS: Record<string, string> = {
  portal: "In the portal",
  worktreeGrid: "In the worktree grid",
  "dev-preview": "In dev preview",
};

/** The context a non-global key works in, or null for a key that works everywhere. */
export function scopeLabel(scope: string): string | null {
  if (!scope || scope === "global") return null;
  if (SCOPE_LABELS[scope]) return SCOPE_LABELS[scope]!;
  const words = scope
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[-_]+/g, " ")
    .toLowerCase();
  return `In ${words}`;
}

/** The one scope every key in a group shares, when they all share one. */
export function sharedScope(entries: readonly ShortcutEntry[]): string | null {
  const scopes = new Set(entries.flatMap((entry) => entry.alternatives.map((alt) => alt.scope)));
  if (scopes.size !== 1) return null;
  const [scope] = scopes;
  return scope && scope !== "global" ? scope : null;
}

function normalizedCombo(combo: string): string {
  let normalized = combo.toLowerCase().replace(/[\s+]+/g, "");
  for (const [symbol, text] of Object.entries(MODIFIER_SEARCH_MAP)) {
    normalized = normalized.replace(new RegExp(symbol, "g"), text);
  }
  return normalized;
}

function searchKeywords(entry: ShortcutEntry): string {
  const words: string[] = [];
  if (entry.alternatives.length === 0) words.push("not set", "unbound", "unassigned");
  if (entry.isCustom) words.push("custom", "customized", "changed");
  return words.join(" ");
}

function wordStarts(haystack: string, needle: string): boolean {
  return haystack === needle || haystack.startsWith(needle) || haystack.includes(` ${needle}`);
}

/**
 * Ranked matches for a query, best first — or `null` when there is no query.
 *
 * A query that reads as keys ("⌘K", "cmd+shift") filters by key prefix. A query
 * that reads as words ranks, strongest first: the phrase at the start of a word
 * in the name, the phrase anywhere in the name, then every word found at a word
 * start across the name, category and tags. Fuzzy matching is only the
 * fallback when none of those find anything — mixed in, it ranks near-misses
 * ("another terminal" for "agent") above the real matches.
 */
export function searchShortcuts(
  entries: readonly ShortcutEntry[],
  query: string
): ShortcutEntry[] | null {
  const trimmed = query.trim();
  if (!trimmed) return null;

  if (isChordPrefix(trimmed)) {
    const prefix = normalizeQuery(trimmed).replace(/\+/g, "");
    return entries.filter((entry) =>
      entry.alternatives.some((alt) => normalizedCombo(alt.combo).startsWith(prefix))
    );
  }

  // A lone modifier ("cmd", "⌘", "shift+") lists every key that uses it.
  const modifierKey = normalizeQuery(trimmed).replace(/\+$/, "");
  // Own keys only: the map is a plain object, and "constructor" is a word
  // someone could type.
  const modifier = Object.hasOwn(MODIFIER_SEARCH_MAP, modifierKey)
    ? MODIFIER_SEARCH_MAP[modifierKey]
    : undefined;
  if (modifier) {
    return entries.filter((entry) =>
      entry.alternatives.some((alt) =>
        alt.combo
          .toLowerCase()
          .split(/[\s+]+/)
          .some(
            (key) =>
              Object.hasOwn(MODIFIER_SEARCH_MAP, key) && MODIFIER_SEARCH_MAP[key] === modifier
          )
      )
    );
  }

  const phrase = trimmed.toLowerCase().replace(/\s+/g, " ");
  const words = phrase.split(" ");
  const tiers: ShortcutEntry[][] = [[], [], []];

  for (const entry of entries) {
    const name = entry.description.toLowerCase();
    const haystack = `${name} ${entry.category.toLowerCase()} ${searchKeywords(entry)}`;
    if (wordStarts(name, phrase)) tiers[0]!.push(entry);
    else if (name.includes(phrase)) tiers[1]!.push(entry);
    else if (words.every((word) => wordStarts(haystack, word))) tiers[2]!.push(entry);
  }

  const ranked = tiers.flat();
  if (ranked.length > 0) return ranked;

  const fuse = new Fuse([...entries], {
    keys: [
      { name: "description", weight: 2 },
      { name: "category", weight: 0.5 },
      { name: "actionIds", weight: 0.5 },
    ],
    threshold: 0.3,
    ignoreLocation: true,
  });
  return fuse.search(trimmed).map((result) => result.item);
}
