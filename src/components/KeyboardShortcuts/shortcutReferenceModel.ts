import Fuse from "fuse.js";
import { KEYBINDING_CATEGORY_ORDER } from "@shared/config/defaultKeybindings";

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

const MODIFIER_NAMES: ReadonlyMap<string, string> = new Map([
  ["⌘", "cmd"],
  ["cmd", "cmd"],
  ["command", "cmd"],
  ["meta", "cmd"],
  ["⌃", "ctrl"],
  ["ctrl", "ctrl"],
  ["control", "ctrl"],
  ["⌥", "alt"],
  ["alt", "alt"],
  ["option", "alt"],
  ["opt", "alt"],
  ["⇧", "shift"],
  ["shift", "shift"],
]);

const KEY_NAMES: ReadonlyMap<string, string> = new Map([
  ["⏎", "enter"],
  ["↩", "enter"],
  ["return", "enter"],
  ["enter", "enter"],
  ["⎋", "escape"],
  ["esc", "escape"],
  ["escape", "escape"],
  ["⌫", "backspace"],
  ["backspace", "backspace"],
  ["⌦", "delete"],
  ["del", "delete"],
  ["delete", "delete"],
  ["⇥", "tab"],
  ["tab", "tab"],
  ["↑", "up"],
  ["arrowup", "up"],
  ["up", "up"],
  ["↓", "down"],
  ["arrowdown", "down"],
  ["down", "down"],
  ["←", "left"],
  ["arrowleft", "left"],
  ["left", "left"],
  ["→", "right"],
  ["arrowright", "right"],
  ["right", "right"],
  ["space", "space"],
]);

const GLYPH = /[⌘⌃⌥⇧⏎↩⎋⌫⌦⇥↑↓←→]/;
const FUNCTION_KEY = /^f\d{1,2}$/;

type KeyStep = { modifiers: Set<string>; key: string | null };

function canonicalKey(token: string, mac: boolean): { modifier?: string; key?: string } {
  const lower = token.toLowerCase();
  const modifier = MODIFIER_NAMES.get(lower);
  // Off macOS the stored "Cmd" is the physical Ctrl key, so the two are one key.
  if (modifier) return { modifier: !mac && modifier === "cmd" ? "ctrl" : modifier };
  return { key: KEY_NAMES.get(lower) ?? lower };
}

/** A stored combo ("Cmd+K Cmd+S") as comparable steps. */
function comboSteps(combo: string, mac: boolean): KeyStep[] {
  return combo
    .trim()
    .replace(/\s*\+\s*/g, "+")
    .split(/\s+/)
    .map((step) => {
      const modifiers = new Set<string>();
      let key: string | null = null;
      const literalPlus = step.endsWith("++");
      const parts = (literalPlus ? step.slice(0, -1) : step).split("+").filter(Boolean);
      if (literalPlus) parts.push("+");
      for (const part of parts) {
        const canonical = canonicalKey(part, mac);
        if (canonical.modifier) modifiers.add(canonical.modifier);
        else key = canonical.key ?? null;
      }
      return { modifiers, key };
    });
}

/**
 * Read a query as keys, or return null when it reads as words. Keys are what
 * the reference prints (⌘⇧P, ⌘K, ⌘S, ⇧F6) or what people type (cmd+k, Ctrl+Tab,
 * "cmd k", F6). A modifier after a key starts the next chord step, and so does
 * a comma — except straight after a modifier, where the comma is the key (⌘,).
 */
function parseKeyQuery(query: string, mac: boolean): KeyStep[] | null {
  const raw = query.trim();
  if (!raw) return null;

  const tokens: string[] = [];
  let word = "";
  const flush = () => {
    if (word) tokens.push(word);
    word = "";
  };
  for (const char of raw) {
    if (GLYPH.test(char)) {
      flush();
      tokens.push(char);
    } else if (char === "+" || /\s/.test(char)) {
      flush();
      if (char === "+") tokens.push("+");
    } else if (char === ",") {
      flush();
      tokens.push(",");
    } else {
      word += char;
    }
  }
  flush();

  const words = tokens.filter((t) => t !== "+" && t !== ",");
  const hasGlyph = tokens.some((t) => GLYPH.test(t));
  const hasPlus = tokens.includes("+");
  const firstIsModifier = words.length > 0 && MODIFIER_NAMES.has(words[0]!.toLowerCase());
  const singleFunctionKey = words.length === 1 && FUNCTION_KEY.test(words[0]!.toLowerCase());
  const looksLikeKeys =
    hasGlyph ||
    hasPlus ||
    singleFunctionKey ||
    // "cmd k", "cmd shift p", or a lone "shift": every word a modifier or one key.
    (firstIsModifier &&
      words.every(
        (w) =>
          MODIFIER_NAMES.has(w.toLowerCase()) ||
          w.length === 1 ||
          FUNCTION_KEY.test(w.toLowerCase())
      ));
  if (!looksLikeKeys) return null;
  // A multi-letter word that is neither a modifier nor a named key means words.
  if (
    words.some(
      (w) =>
        w.length > 1 &&
        !MODIFIER_NAMES.has(w.toLowerCase()) &&
        !KEY_NAMES.has(w.toLowerCase()) &&
        !FUNCTION_KEY.test(w.toLowerCase()) &&
        !/^[^a-z0-9]+$/i.test(w)
    )
  ) {
    return null;
  }

  const steps: KeyStep[] = [{ modifiers: new Set(), key: null }];
  for (const token of tokens) {
    const step = steps[steps.length - 1]!;
    if (token === "+") continue;
    if (token === ",") {
      if (step.key === null && step.modifiers.size > 0) step.key = ",";
      else if (step.key !== null || step.modifiers.size > 0)
        steps.push({ modifiers: new Set(), key: null });
      continue;
    }
    const canonical = canonicalKey(token, mac);
    if (canonical.modifier) {
      if (step.key !== null) steps.push({ modifiers: new Set([canonical.modifier]), key: null });
      else step.modifiers.add(canonical.modifier);
    } else if (step.key === null) {
      step.key = canonical.key ?? null;
    } else {
      steps.push({ modifiers: new Set(), key: canonical.key ?? null });
    }
  }
  const filled = steps.filter((step) => step.key !== null || step.modifiers.size > 0);
  return filled.length > 0 ? filled : null;
}

function sameModifiers(a: Set<string>, b: Set<string>): boolean {
  return a.size === b.size && [...a].every((m) => b.has(m));
}

/**
 * Whether a combo starts with the queried keys. Every finished step must match
 * exactly; the last step may be partial — modifiers only ("⌘⇧") match any key
 * held with at least those modifiers, while a step with its key must match
 * exactly, so "⌘K" finds the ⌘K family and not ⌘⇧K.
 */
function comboMatches(combo: string, query: KeyStep[], mac: boolean): boolean {
  const steps = comboSteps(combo, mac);
  if (query.length > steps.length) return false;
  return query.every((q, i) => {
    const step = steps[i]!;
    const last = i === query.length - 1;
    if (q.key === null) {
      if (!last) return false;
      return [...q.modifiers].every((m) => step.modifiers.has(m));
    }
    return q.key === step.key && sameModifiers(q.modifiers, step.modifiers);
  });
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
 * A query that reads as keys ("⌘K", "⌘⇧P", "Ctrl+Tab", F6) filters to the keys
 * that start with it, in the platform's own terms. A query
 * that reads as words ranks, strongest first: the phrase at the start of a word
 * in the name, the phrase anywhere in the name, then every word found at a word
 * start across the name, category and tags. Fuzzy matching is only the
 * fallback when none of those find anything — mixed in, it ranks near-misses
 * ("another terminal" for "agent") above the real matches.
 */
export function searchShortcuts(
  entries: readonly ShortcutEntry[],
  query: string,
  mac: boolean
): ShortcutEntry[] | null {
  const trimmed = query.trim();
  if (!trimmed) return null;

  const keys = parseKeyQuery(trimmed, mac);
  if (keys) {
    return entries.filter((entry) =>
      entry.alternatives.some((alt) => comboMatches(alt.combo, keys, mac))
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

  // One character is as likely a key as the start of a word: a row bound to
  // exactly that key, unmodified (the worktree grid's X), leads.
  const bareKey = [...trimmed].length === 1 ? parseKeyQuery(`+${trimmed}`, mac) : null;
  const keyed = bareKey
    ? entries.filter((entry) =>
        entry.alternatives.some((alt) => comboMatches(alt.combo, bareKey, mac))
      )
    : [];
  const ranked = [...new Set([...keyed, ...tiers.flat()])];
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
