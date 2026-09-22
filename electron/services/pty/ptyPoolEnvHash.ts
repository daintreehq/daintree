import { filterSensitiveOnly, isSensitiveVar } from "./EnvironmentFilter.js";

/**
 * Volatile env keys that change with shell session state but don't change the
 * effective execution environment. Excluded from the pool key so that two
 * spawns whose only differences are these keys still share a pool slot.
 */
export const VOLATILE_ENV_KEYS: ReadonlySet<string> = new Set(["SHLVL", "PWD", "OLDPWD", "_"]);

/**
 * DAINTREE_* keys that `injectDaintreeMetadata` always overwrites on the
 * fresh-spawn path. Excluded from the pool key because the caller's value
 * (if any) gets overridden by injection — two callers differing only in
 * these keys functionally share a slot. Other DAINTREE_* keys (e2e probes,
 * caller-defined metadata) are NOT excluded — they reach the child intact
 * and must therefore key the slot.
 */
const AUTO_INJECTED_DAINTREE_KEYS: ReadonlySet<string> = new Set([
  "DAINTREE_PANE_ID",
  "DAINTREE_CWD",
  "DAINTREE_PROJECT_ID",
  "DAINTREE_WORKTREE_ID",
]);

const EMPTY_HASH = "env-empty";

/**
 * True when the caller's intentional env carries a variable the pool strips
 * from both the key and the warm shell. A pooled shell for such a spawn would
 * silently lack the credential — the pooled return path never applies the
 * freshly built env — so these spawns must take a fresh process instead. Uses
 * the same predicate as `filterSensitiveOnly` so "pool-strippable" and
 * "pool-ineligible" can never drift apart.
 */
export function carriesPoolStrippedEnv(
  env: Record<string, string | undefined> | undefined
): boolean {
  if (!env) return false;
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined && isSensitiveVar(key)) return true;
  }
  return false;
}

/**
 * Stable identifier for a pool slot keyed by env. Two calls with the same
 * post-filter env additions (modulo volatile keys) return the same string.
 *
 * The hash runs over the post-`filterSensitiveOnly` view of the caller env,
 * matching what `PtyPool.buildSpawnEnv` actually writes into the spawned
 * shell. Two important consequences:
 *
 *   - Secrets (API keys, tokens) are stripped before hashing, so two callers
 *     that differ only in stripped-away secrets share a slot — correct,
 *     because the stripped secrets never reach the pre-warmed shell anyway.
 *   - `DAINTREE_*` keys ARE kept in the hash. Caller-supplied DAINTREE_*
 *     vars (e.g. agent preset metadata, e2e probe vars) reach the child
 *     intact and must therefore key the slot, otherwise a warm slot
 *     populated for caller A would be served to caller B whose preset
 *     intentionally set different DAINTREE_* values (#7625 family).
 */
export function computePoolEnvHash(env: Record<string, string | undefined> | undefined): string {
  if (!env) {
    return EMPTY_HASH;
  }

  const filtered = filterSensitiveOnly(env);
  const entries: string[] = [];
  for (const [key, value] of Object.entries(filtered)) {
    if (VOLATILE_ENV_KEYS.has(key)) continue;
    if (AUTO_INJECTED_DAINTREE_KEYS.has(key)) continue;
    entries.push(`${key}=${value}`);
  }

  if (entries.length === 0) {
    return EMPTY_HASH;
  }

  entries.sort();

  let hash = 5381;
  for (const entry of entries) {
    for (let i = 0; i < entry.length; i++) {
      hash = ((hash << 5) + hash + entry.charCodeAt(i)) | 0;
    }
    hash = ((hash << 5) + hash + 10) | 0;
  }

  const u32 = hash >>> 0;
  return `env-${u32.toString(36)}`;
}

export const POOL_ENV_EMPTY_HASH = EMPTY_HASH;
