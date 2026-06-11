import type { LoadedPluginInfo } from "@shared/types/plugin";
import { resolvePluginCategory } from "@shared/config/pluginCategoryRegistry";
import { scoreSubsequence } from "./actionPaletteSearch";

const NAME_WEIGHT = 3;
const DESCRIPTION_WEIGHT = 0.5;

/**
 * Filter operators recognized by the plugin manager search (#9557). VS
 * Code–style `@token` flags that narrow the list before free-text scoring.
 * `@cap:<value>` and `@cat:<value>` carry a value (a capability id / a
 * category id from `PLUGIN_CATEGORY_IDS`); the boolean flags don't.
 */
export type PluginFilterOperator = "builtin" | "installed" | "enabled" | "disabled" | "cap" | "cat";

const KNOWN_OPERATORS: ReadonlySet<string> = new Set([
  "builtin",
  "installed",
  "enabled",
  "disabled",
  "cap",
  "cat",
]);

function isKnownOperator(key: unknown): key is PluginFilterOperator {
  return typeof key === "string" && KNOWN_OPERATORS.has(key);
}

export interface ParsedPluginQuery {
  /** Recognized `@token` operators, in source order. */
  operators: { key: PluginFilterOperator; value: string | null }[];
  /** Everything that wasn't a recognized operator, joined for fuzzy matching. */
  freeText: string;
}

// `@token` or `@token:value`; the value runs to the next whitespace or `@`.
const OPERATOR_RE = /@([a-z]+)(?::([^\s@]*))?/gi;

/**
 * Split a raw query into recognized operators and residual free text. Unknown
 * `@foo` tokens are treated as free text (kept verbatim) rather than silently
 * dropped, so a user who misremembers a token still gets a name/description
 * match attempt instead of an empty list.
 */
export function parsePluginQuery(raw: string): ParsedPluginQuery {
  const operators: ParsedPluginQuery["operators"] = [];
  const textParts: string[] = [];
  let lastIndex = 0;

  const matches = Array.from(raw.matchAll(OPERATOR_RE));
  for (const match of matches) {
    // matchAll with a regex containing a capturing group always populates index and [1]
    const matchIndex = match.index ?? 0;
    const keyRaw = match[1];
    if (keyRaw === undefined) continue; // safeguard

    const key = keyRaw.toLowerCase();
    if (!isKnownOperator(key)) continue; // leave unknown tokens in the free text

    // Capture any free text sitting between the previous token and this one.
    const between = raw.slice(lastIndex, matchIndex);
    if (between.trim()) textParts.push(between.trim());
    lastIndex = matchIndex + match[0].length;

    const rawValue = match[2];
    operators.push({
      key,
      value: rawValue ? rawValue.toLowerCase() : null,
    });
  }

  const tail = raw.slice(lastIndex);
  if (tail.trim()) textParts.push(tail.trim());

  return { operators, freeText: textParts.join(" ").trim() };
}

/** True when the parsed query would narrow the list (any operator or text). */
export function isQueryActive(parsed: ParsedPluginQuery): boolean {
  return parsed.operators.length > 0 || parsed.freeText.length > 0;
}

function matchesOperator(
  plugin: LoadedPluginInfo,
  op: { key: PluginFilterOperator; value: string | null }
): boolean {
  switch (op.key) {
    case "builtin":
      return plugin.isBuiltin && !plugin.disabled;
    case "installed":
      return !plugin.isBuiltin && !plugin.disabled;
    case "enabled":
      return !plugin.disabled;
    case "disabled":
      return plugin.disabled === true;
    case "cap": {
      if (!op.value) return false; // `@cap:` with no value matches nothing
      return (plugin.manifest.capabilities ?? []).some((c) => c.toLowerCase() === op.value);
    }
    case "cat": {
      if (!op.value) return false; // `@cat:` with no value matches nothing
      return resolvePluginCategory(plugin.manifest) === op.value;
    }
  }
}

/**
 * Fuzzy score for a plugin against free text. Name (displayName ?? name) is
 * weighted well above description so a name hit always ranks first. Returns 0
 * when neither field matches.
 */
export function scorePlugin(plugin: LoadedPluginInfo, freeText: string): number {
  if (!freeText) return 0;
  const lowerQuery = freeText.toLowerCase();

  const name = plugin.manifest.displayName ?? plugin.manifest.name;
  const nameScore = scoreSubsequence(lowerQuery, name, name.toLowerCase());

  // Tagline and description score as one secondary field — the tagline is just
  // the short form of the same copy, so it shouldn't out-rank or double-count.
  const description = [plugin.manifest.tagline, plugin.manifest.description]
    .filter(Boolean)
    .join(" ");
  const descriptionScore =
    description.length > 0
      ? scoreSubsequence(lowerQuery, description, description.toLowerCase())
      : 0;

  if (nameScore <= 0 && descriptionScore <= 0) return 0;
  return Math.max(0, nameScore) * NAME_WEIGHT + Math.max(0, descriptionScore) * DESCRIPTION_WEIGHT;
}

/**
 * Apply a raw search query to the plugin list. Operators AND-combine as a
 * pre-filter; free text then scores the survivors and drops non-matches,
 * sorting by descending score with a name tie-break. With no free text the
 * operator-filtered list keeps the caller's incoming order.
 */
export function filterPlugins(
  plugins: readonly LoadedPluginInfo[],
  raw: string
): LoadedPluginInfo[] {
  const parsed = parsePluginQuery(raw);
  if (!isQueryActive(parsed)) return [...plugins];

  const gated = plugins.filter((plugin) =>
    parsed.operators.every((op) => matchesOperator(plugin, op))
  );

  if (!parsed.freeText) return gated;

  const scored: Array<{ plugin: LoadedPluginInfo; score: number }> = [];
  for (const plugin of gated) {
    const score = scorePlugin(plugin, parsed.freeText);
    if (score > 0) scored.push({ plugin, score });
  }

  scored.sort((a, b) => {
    if (a.score !== b.score) return b.score - a.score;
    const an = a.plugin.manifest.displayName ?? a.plugin.manifest.name;
    const bn = b.plugin.manifest.displayName ?? b.plugin.manifest.name;
    return an.localeCompare(bn, "en", { sensitivity: "base" });
  });

  return scored.map((entry) => entry.plugin);
}
