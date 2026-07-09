import type { Migration } from "../StoreMigrations.js";
import { BUILTIN_GITHUB_PROVIDER_ID } from "../../../shared/utils/forgeProviderIds.js";

const LEGACY_TOKEN_KEY = "userConfig.githubToken";

/**
 * Carry a pre-cutover GitHub token from the legacy `userConfig.githubToken`
 * key into the provider-keyed `forgeCredentials` map (#11033).
 *
 * The forge-neutral refactor (#10347) moved the connection gate to
 * `forgeCredentials`, but the token save/read path kept writing the legacy key.
 * Users who saved a token before the cutover ended up authenticated (the
 * toolbar issue/PR counts read the legacy key via `GitHubAuth.getToken()`) yet
 * shown a "GitHub not connected" empty state in every panel, because that gate
 * reads `forgeCredentials` and found nothing.
 *
 * `forgeCredentials` is not just a UI flag — `PluginHostFactory` replays it into
 * freshly bound provider impls (and utility-process hosts, which cannot reach
 * secure storage at all), so the fix has to persist rather than paper over the
 * read.
 *
 * The legacy key is always removed once a token is found there, even when the
 * destination already holds a credential. `forge:clear-credential` only deletes
 * the `forgeCredentials` entry, so a surviving legacy key would resurrect the
 * token on the next boot via the plugin's `initializeTokenStorage()`.
 */

/**
 * Deliberately duplicated from `forgeSettings.ts` rather than imported: a
 * migration is a snapshot of the schema as it was, and must not drift when the
 * live reader changes. Importing the handler module would also drag the IPC
 * registry into the boot path.
 */
function recordHasCredential(raw: unknown): boolean {
  if (typeof raw !== "string" || raw.length === 0) return false;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") return false;
    return Object.values(parsed as Record<string, unknown>).some(
      (v) => typeof v === "string" && v.trim().length > 0
    );
  } catch {
    return false;
  }
}

export const migration024: Migration = {
  version: 24,
  description: "Backfill the legacy GitHub token into the forge credentials map",
  up: (store) => {
    const get = store.get.bind(store) as (key: string) => unknown;
    const set = store.set.bind(store) as (key: string, value: unknown) => void;
    const del = store.delete.bind(store) as (key: string) => void;

    const rawToken = get(LEGACY_TOKEN_KEY);
    if (rawToken === undefined || rawToken === null) return;

    if (typeof rawToken !== "string") {
      // Mirrors `SecureStorage.get`, which clears a corrupt non-string entry
      // rather than handing it to a caller that expects a token.
      console.warn(`[Migrations] Dropping corrupt non-string ${LEGACY_TOKEN_KEY}`);
      del(LEGACY_TOKEN_KEY);
      return;
    }

    const token = rawToken.trim();
    if (token.length === 0) {
      // Readers treat a blank credential as absent, so copying it would only
      // leave a phantom entry behind. Drop the key and stop.
      del(LEGACY_TOKEN_KEY);
      return;
    }

    const rawMap = get("forgeCredentials");
    let map: Record<string, unknown> = {};
    if (rawMap !== undefined && rawMap !== null) {
      if (typeof rawMap === "object" && !Array.isArray(rawMap)) {
        map = rawMap as Record<string, unknown>;
      } else {
        // Repair rather than throw: a corrupt sibling key shouldn't trip the
        // runner's restore-from-backup path for the whole migration chain.
        console.warn("[Migrations] Replacing corrupt non-object forgeCredentials");
      }
    }

    // Guard the destination, not the source: a token saved after the cutover
    // wins over the stale legacy copy, and a replay after a partial failure
    // cannot clobber it.
    if (!recordHasCredential(map[BUILTIN_GITHUB_PROVIDER_ID])) {
      set("forgeCredentials", {
        ...map,
        [BUILTIN_GITHUB_PROVIDER_ID]: JSON.stringify({ token }),
      });
    }

    del(LEGACY_TOKEN_KEY);
  },
};
