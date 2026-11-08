import { RECIPE_CONTROL_CHARS } from "@shared/utils/recipeSanitizer";
import { validateEnvRows, type EnvVarDraft } from "@/components/Settings/EnvVarRow";

export const ENV_VALUE_CONTROL_CHAR_MESSAGE =
  "Values can't contain tabs or other control characters";

/** One editable row per variable, in the order the step stores them. */
export function envToDrafts(env: Record<string, string> | undefined): EnvVarDraft[] {
  return Object.entries(env ?? {}).map(([key, value]) => ({
    id: `recipe-env-${crypto.randomUUID()}`,
    key,
    value,
  }));
}

/**
 * The env a step saves. A row with no name is dropped, as the settings editors
 * drop one; a named row with an empty value is kept, since an empty variable
 * still overrides an inherited one. Built from entries rather than assigned
 * key by key, so a name like `__proto__` lands as the variable it is.
 */
export function draftsToEnv(rows: readonly EnvVarDraft[]): Record<string, string> {
  return Object.fromEntries(
    rows.filter((row) => row.key.trim()).map((row) => [row.key.trim(), row.value])
  );
}

/** What a row's error is about, so the field it names is the one marked and focused. */
export interface RecipeEnvRowError {
  message: string;
  field: "key" | "value";
}

/**
 * Per-row errors, keyed by row id: the settings editors' name rules, then a
 * value the sanitizer would refuse. That refusal drops the whole step on the
 * next load, so it is caught here rather than saved.
 */
export function validateRecipeEnvRows(
  rows: readonly EnvVarDraft[]
): Record<string, RecipeEnvRowError> {
  const errors: Record<string, RecipeEnvRowError> = {};
  for (const [id, message] of Object.entries(validateEnvRows(rows))) {
    errors[id] = { message, field: "key" };
  }
  for (const row of rows) {
    if (errors[row.id] || !row.key.trim()) continue;
    if (RECIPE_CONTROL_CHARS.test(row.value)) {
      errors[row.id] = { message: ENV_VALUE_CONTROL_CHAR_MESSAGE, field: "value" };
    }
  }
  return errors;
}

/**
 * What the dirty check compares: every row holding anything, invalid or not,
 * so an unsaved name the save would refuse still asks before it is discarded.
 * Sorted, so the order rows were added in doesn't read as a change.
 */
export function serializeEnvDrafts(rows: readonly EnvVarDraft[]): Array<[string, string]> {
  return rows
    .filter((row) => row.key.trim() || row.value)
    .map((row): [string, string] => [row.key.trim(), row.value])
    .sort(([a, av], [b, bv]) => a.localeCompare(b) || av.localeCompare(bv));
}
