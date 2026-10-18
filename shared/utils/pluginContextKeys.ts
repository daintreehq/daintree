import {
  PLUGIN_CONTEXT_KEYS_MAX,
  PLUGIN_CONTEXT_KEY_LENGTH_MAX,
  PLUGIN_CONTEXT_VALUE_LENGTH_MAX,
  parseProjectPluginInstanceKey,
  type PluginContextValue,
} from "../types/plugin.js";
import type { WhenClauseContext } from "./whenClause/types.js";

/**
 * One `when`-clause path segment, as the parser reads it. No dots: a key is a
 * single leaf under the plugin's `publisher.name`, so `a` and `a.b` can never
 * both be set and fight over whether `a` is a value or a branch.
 */
const CONTEXT_KEY_RE = /^[A-Za-z_][\w-]*$/;
const RESERVED_KEYS = new Set(["__proto__", "constructor", "prototype"]);

export type PluginContextEntryResult =
  { ok: true; key: string; value: PluginContextValue | null } | { ok: false; error: string };

/**
 * Vet one `host.setContext(key, value)` call (#13506). `null` and `undefined`
 * both clear. Shared by the in-process host, the worker proxy and the mock host
 * so every host accepts and refuses exactly the same calls.
 */
export function validatePluginContextEntry(key: unknown, value: unknown): PluginContextEntryResult {
  if (typeof key !== "string" || key.length === 0) {
    return { ok: false, error: "key must be a non-empty string" };
  }
  if (key.length > PLUGIN_CONTEXT_KEY_LENGTH_MAX) {
    return {
      ok: false,
      error: `key must be at most ${PLUGIN_CONTEXT_KEY_LENGTH_MAX} characters`,
    };
  }
  if (!CONTEXT_KEY_RE.test(key) || RESERVED_KEYS.has(key)) {
    return {
      ok: false,
      error: `key "${key}" must start with a letter or "_", hold only letters, digits, "_" and "-" (no dots), and not be a reserved name`,
    };
  }
  if (value === null || value === undefined) return { ok: true, key, value: null };
  if (typeof value === "boolean") return { ok: true, key, value };
  if (typeof value === "string") {
    if (value.length > PLUGIN_CONTEXT_VALUE_LENGTH_MAX) {
      return {
        ok: false,
        error: `value must be at most ${PLUGIN_CONTEXT_VALUE_LENGTH_MAX} characters`,
      };
    }
    return { ok: true, key, value };
  }
  return { ok: false, error: `value must be a boolean, a string or null, got ${typeof value}` };
}

export type PluginContextApplyResult =
  { ok: true; changed: boolean } | { ok: false; error: string };

/**
 * Write a vetted entry into one plugin's key map: `null` deletes, a new key
 * past {@link PLUGIN_CONTEXT_KEYS_MAX} is refused. `changed` is false when the
 * map already held exactly this, so callers skip a redundant push.
 */
export function applyPluginContextEntry(
  keys: Map<string, PluginContextValue>,
  key: string,
  value: PluginContextValue | null
): PluginContextApplyResult {
  if (value === null) return { ok: true, changed: keys.delete(key) };
  if (keys.get(key) === value) return { ok: true, changed: false };
  if (!keys.has(key) && keys.size >= PLUGIN_CONTEXT_KEYS_MAX) {
    return { ok: false, error: `at most ${PLUGIN_CONTEXT_KEYS_MAX} keys per plugin` };
  }
  keys.set(key, value);
  return { ok: true, changed: true };
}

/**
 * Nest each plugin's published keys under its manifest name, so the evaluator's
 * dotted-path walk finds `acme.linear-planner.needsYou` at
 * `ctx.acme["linear-planner"].needsYou`. Keyed by instance key on the way in:
 * a project instance publishes under its bare `publisher.name`, exactly like
 * an installed one.
 *
 * An installed plugin and a project copy of it can both be loaded. The project
 * instance owns the namespace in its own views, wholesale — even with no keys
 * set — so its view never mixes in keys the installed copy published. Main
 * sends a project instance's events only to its project's views, so any one
 * here belongs to this view. Null-prototype objects throughout, so no key can
 * resolve through `Object.prototype`.
 */
export function buildPluginWhenContext(
  keysByPlugin: Readonly<Record<string, Readonly<Record<string, PluginContextValue>>>>
): WhenClauseContext {
  const root: WhenClauseContext = Object.create(null);
  const entries = Object.entries(keysByPlugin).map(([pluginId, keys]) => {
    const project = parseProjectPluginInstanceKey(pluginId);
    return { manifestId: project?.manifestId ?? pluginId, isProject: project !== null, keys };
  });
  // Installed first, so a project instance's leaf replaces it.
  entries.sort((a, b) => Number(a.isProject) - Number(b.isProject));
  for (const { manifestId, keys } of entries) {
    const dot = manifestId.indexOf(".");
    if (dot <= 0 || dot === manifestId.length - 1) continue;
    const publisher = manifestId.slice(0, dot);
    const name = manifestId.slice(dot + 1);
    let byName = root[publisher] as WhenClauseContext | undefined;
    if (!byName) {
      byName = Object.create(null) as WhenClauseContext;
      root[publisher] = byName;
    }
    const leaf: WhenClauseContext = Object.create(null);
    for (const [key, value] of Object.entries(keys)) leaf[key] = value;
    byName[name] = leaf;
  }
  return root;
}
