import Fuse, { type IFuseOptions } from "fuse.js";
import type { FuseResultMatch } from "@/hooks/useSearchablePalette";
import type { AppColorScheme } from "@shared/types/appTheme";

export type ThemeMode = AppColorScheme["type"];

/** Dark first: the default theme and most of the built-ins are dark. */
export const THEME_MODE_ORDER: readonly ThemeMode[] = ["dark", "light"];

export const THEME_MODE_LABEL: Record<ThemeMode, string> = {
  dark: "Dark",
  light: "Light",
};

export interface ThemeSearchResult {
  items: AppColorScheme[];
  matches: Map<string, readonly FuseResultMatch[]>;
}

/**
 * Every built-in is named for a place, and the place is on the row, so a search
 * for "japan" has to find Arashiyama and Hokkaido. The name outranks the place
 * so "bali" still leads with Bali rather than anything that happens to be in
 * Indonesia.
 */
const FUSE_OPTIONS: IFuseOptions<AppColorScheme> = {
  keys: [
    { name: "name", weight: 2 },
    { name: "location", weight: 1 },
  ],
  threshold: 0.4,
  ignoreLocation: true,
  includeMatches: true,
};

function asMode(word: string): ThemeMode | null {
  const lower = word.toLowerCase();
  return lower === "light" || lower === "dark" ? lower : null;
}

/**
 * "light" and "dark" are filters, not text. Fuzzily, "light" matched
 * Highlands — a dark theme — and none of the light ones. A whole-word mode
 * token narrows to that band and the rest of the query searches as usual, so
 * "light japan" finds Hokkaido.
 */
export function parseThemeQuery(query: string): { mode: ThemeMode | null; text: string } {
  let mode: ThemeMode | null = null;
  const rest: string[] = [];
  for (const word of query.trim().split(/\s+/).filter(Boolean)) {
    const wordMode = asMode(word);
    if (wordMode) mode = wordMode;
    else rest.push(word);
  }
  return { mode, text: rest.join(" ") };
}

/**
 * Stable-sorts into mode bands, keeping the incoming order inside each band:
 * registry order when browsing, rank order when searching.
 */
export function orderByMode(items: readonly AppColorScheme[]): AppColorScheme[] {
  return THEME_MODE_ORDER.flatMap((mode) => items.filter((s) => s.type === mode));
}

const fuseCache = new WeakMap<readonly AppColorScheme[], Fuse<AppColorScheme>>();

function fuseFor(items: readonly AppColorScheme[]): Fuse<AppColorScheme> {
  let fuse = fuseCache.get(items);
  if (!fuse) {
    fuse = new Fuse(items, FUSE_OPTIONS);
    fuseCache.set(items, fuse);
  }
  return fuse;
}

type MatchKey = "name" | "location";
const MATCH_KEYS: readonly MatchKey[] = ["name", "location"];

/**
 * Whole-substring hits, with their ranges. When any exist they are the answer:
 * Fuse's typo tolerance let "japan" pull in Fiordland through "Zealand" and
 * mark "aland" as the reason. Fuzzy only runs when nothing contains the text.
 */
function substringMatches(
  items: readonly AppColorScheme[],
  text: string
): { items: AppColorScheme[]; matches: Map<string, readonly FuseResultMatch[]> } {
  const needle = text.toLowerCase();
  const hits: { item: AppColorScheme; rank: number }[] = [];
  const matches = new Map<string, readonly FuseResultMatch[]>();
  for (const item of items) {
    const found: FuseResultMatch[] = [];
    let rank = Infinity;
    MATCH_KEYS.forEach((key, k) => {
      const value = item[key];
      const at = value ? value.toLowerCase().indexOf(needle) : -1;
      if (value && at >= 0) {
        found.push({ key, value, indices: [[at, at + needle.length - 1]] });
        rank = Math.min(rank, k * 1000 + at);
      }
    });
    if (found.length > 0) {
      hits.push({ item, rank });
      matches.set(item.id, found);
    }
  }
  hits.sort((a, b) => a.rank - b.rank);
  return { items: hits.map((h) => h.item), matches };
}

export function searchThemes(items: readonly AppColorScheme[], query: string): ThemeSearchResult {
  const { mode, text } = parseThemeQuery(query);
  const pool = mode ? items.filter((s) => s.type === mode) : items;
  if (!text) return { items: orderByMode(pool), matches: new Map() };
  const exact = substringMatches(pool, text);
  if (exact.items.length > 0) return { items: orderByMode(exact.items), matches: exact.matches };
  const matches = new Map<string, readonly FuseResultMatch[]>();
  const ranked: AppColorScheme[] = [];
  for (const r of fuseFor(items).search(text)) {
    if (mode && r.item.type !== mode) continue;
    ranked.push(r.item);
    if (r.matches?.length) matches.set(r.item.id, r.matches);
  }
  return { items: orderByMode(ranked), matches };
}
