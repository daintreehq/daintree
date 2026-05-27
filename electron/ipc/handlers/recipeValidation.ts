import type { RecipeTerminal } from "../../../shared/types/project.js";
import { findSecretInValue } from "../../utils/secretScrubber.js";

const USAGE_HISTORY_LIMIT = 20;

export function assertRecipeUsageFields(value: {
  lastUsedAt?: unknown;
  usageHistory?: unknown;
}): void {
  if (value.lastUsedAt !== undefined && !Number.isFinite(value.lastUsedAt)) {
    throw new Error("Recipe lastUsedAt must be a finite number");
  }
  if (value.usageHistory !== undefined) {
    if (!Array.isArray(value.usageHistory)) {
      throw new Error("Recipe usageHistory must be an array");
    }
    if (value.usageHistory.length > USAGE_HISTORY_LIMIT) {
      throw new Error(`Recipe usageHistory must not exceed ${USAGE_HISTORY_LIMIT} entries`);
    }
    for (const entry of value.usageHistory) {
      if (!Number.isFinite(entry)) {
        throw new Error("Recipe usageHistory entries must be finite numbers");
      }
    }
  }
}

/**
 * Refuses to save a recipe whose terminal env values contain a detectable
 * secret. Recipe JSON is persisted to `.daintree/recipes/*.json`, which is
 * git-tracked — pasting a token into an env value would commit the credential
 * on the next push. We reject (rather than silently blank) so the user gets a
 * useful error naming the offending key and pattern instead of a recipe that
 * mysteriously runs with an empty env var. The in-repo write path already
 * blanks env values as a defense-in-depth backstop; this is the primary guard.
 *
 * Fails fast on the first match, matching the throw-on-first-violation
 * convention of {@link assertRecipeUsageFields}.
 */
export function assertNoSecretEnvValues(terminals: RecipeTerminal[]): void {
  for (let i = 0; i < terminals.length; i++) {
    const env = terminals[i]?.env;
    if (!env) continue;
    for (const [key, rawValue] of Object.entries(env)) {
      if (typeof rawValue !== "string") {
        throw new Error(`Recipe terminal ${i} env "${key}" must be a string`);
      }
      // Several scrubber patterns are context-dependent — they only match when
      // the key name precedes the value (e.g. `AWS_SECRET_ACCESS_KEY=...`,
      // `DD_API_KEY=...`, `api_key=...`). Test the bare value first, then the
      // `KEY=value` form so those patterns can anchor on the surrounding name.
      const match = findSecretInValue(rawValue) ?? findSecretInValue(`${key}=${rawValue}`);
      if (match) {
        throw new Error(
          `Recipe terminal ${i} env "${key}" contains a secret (pattern: ${match.name}). ` +
            `Credentials must not be saved in recipes — they would be committed to git. ` +
            `Remove the value and set it as a secure env var instead.`
        );
      }
    }
  }
}
