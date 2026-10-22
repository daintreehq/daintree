/**
 * A plugin recipe's own variables (#13797): names it declares, written
 * `{{plugin.<name>}}` in its prompts and filled by `host.runRecipe`. The
 * `plugin.` prefix keeps them apart from the host's variables, so a plugin can
 * never supply `{{branch_name}}`, and a `{{plugin.x}}` the host doesn't know
 * stays out of every other recipe's way.
 */
import { RECIPE_PROMPT_CONTROL_CHARS } from "./recipeSanitizer.js";

/** Lowercase letters, digits and underscores, starting with a letter — prompt template argument names. */
export const PLUGIN_RECIPE_VARIABLE_NAME_PATTERN = /^[a-z][a-z0-9_]*$/;
export const PLUGIN_RECIPE_VARIABLE_NAME_MAX_LENGTH = 64;
export const MAX_PLUGIN_RECIPE_VARIABLES = 20;
export const PLUGIN_RECIPE_VARIABLE_MAX_LENGTH = 8192;
export const PLUGIN_RECIPE_VARIABLES_MAX_TOTAL = 32768;

/** `{{plugin.<name>}}`, the same token launch substitutes. */
const PLUGIN_VARIABLE_TOKEN = /\{\{plugin\.(\w+)\}\}/gi;

/** The plugin variable names a template uses, lowercased, each once. */
export function pluginVariableReferences(text: string): string[] {
  const names = new Set<string>();
  for (const match of text.matchAll(PLUGIN_VARIABLE_TOKEN)) names.add(match[1]!.toLowerCase());
  return [...names];
}

export type PluginRecipeVariablesResult =
  { ok: true; values: Record<string, string> } | { ok: false; reason: string };

/**
 * Check values a plugin passes for its recipe's variables, returning a copy
 * with a null prototype. Only own keys are read and only declared names are
 * accepted, so `__proto__` or an inherited key can neither slip in nor
 * resolve through the prototype later.
 */
export function validatePluginRecipeVariables(
  raw: unknown,
  declared: readonly string[]
): PluginRecipeVariablesResult {
  const values = Object.create(null) as Record<string, string>;
  if (raw === undefined) return { ok: true, values };
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, reason: "variables must be an object of strings" };
  }
  const allowed = new Set(declared);
  let total = 0;
  for (const name of Object.keys(raw)) {
    if (!allowed.has(name)) {
      return {
        ok: false,
        reason:
          allowed.size === 0
            ? `the recipe declares no variables, but "${name}" was given`
            : `"${name}" isn't one of the recipe's variables (${[...allowed].join(", ")})`,
      };
    }
    const value = (raw as Record<string, unknown>)[name];
    if (typeof value !== "string") return { ok: false, reason: `"${name}" must be a string` };
    if (value.length > PLUGIN_RECIPE_VARIABLE_MAX_LENGTH) {
      return {
        ok: false,
        reason: `"${name}" is longer than ${PLUGIN_RECIPE_VARIABLE_MAX_LENGTH} characters`,
      };
    }
    if (RECIPE_PROMPT_CONTROL_CHARS.test(value)) {
      return { ok: false, reason: `"${name}" holds control characters` };
    }
    total += value.length;
    if (total > PLUGIN_RECIPE_VARIABLES_MAX_TOTAL) {
      return {
        ok: false,
        reason: `variables are longer than ${PLUGIN_RECIPE_VARIABLES_MAX_TOTAL} characters in all`,
      };
    }
    values[name] = value;
  }
  return { ok: true, values };
}
