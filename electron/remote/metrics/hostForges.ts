import type { HostForgeObservation } from "../../../shared/types/remoteHosts.js";
import { makeForgeProviderId } from "../../../shared/utils/forgeProviderIds.js";
import {
  getForgeProviderImpl,
  getRegisteredForgeProviders,
} from "../../services/forgeProviderRegistry.js";
import { store } from "../../store.js";

/** How long an account the provider reported stands before it is asked again. */
const FORGE_ACCOUNT_TTL_MS = 10 * 60_000;
const FORGE_ACCOUNT_TIMEOUT_MS = 5_000;
/** The summary schema's own caps. */
const MAX_FORGES = 64;

/** True when the saved credential record has any non-empty value. */
function hasSavedCredential(raw: string | undefined): boolean {
  if (!raw) return false;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") return false;
    return Object.values(parsed as Record<string, unknown>).some(
      (value) => typeof value === "string" && value.trim().length > 0
    );
  } catch {
    return false;
  }
}

async function askAccount(providerId: string): Promise<string | null> {
  const identity = getForgeProviderImpl(providerId)?.identity;
  if (!identity) return null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const user = await Promise.race([
      identity.getCurrentUser(),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), FORGE_ACCOUNT_TIMEOUT_MS);
        timer.unref?.();
      }),
    ]);
    return typeof user?.login === "string" && user.login ? user.login.slice(0, 256) : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * This host's forge providers, each with whether a credential is saved here
 * and the account its provider says that credential signs in as. Presence is
 * read every sample from the settings; the account is asked of the provider
 * at most every {@link FORGE_ACCOUNT_TTL_MS}, and again whenever the saved
 * credential changes. Nothing about the credential itself is reported.
 */
export function createForgeObserver(now: () => number = Date.now) {
  const accounts = new Map<string, { credential: string; account: string | null; at: number }>();
  return async function observeForges(): Promise<HostForgeObservation[]> {
    const saved = store.get("forgeCredentials") ?? {};
    // Within the summary's wire limits, so a long list or name can't cost the whole summary.
    const providers = getRegisteredForgeProviders()
      .filter(
        ({ pluginId, contribution }) =>
          contribution.kind !== "local" &&
          makeForgeProviderId(pluginId, contribution.id).length <= 256
      )
      .slice(0, MAX_FORGES);
    const seen = new Set<string>();
    const observed = await Promise.all(
      providers.map(async ({ pluginId, contribution }) => {
        const providerId = makeForgeProviderId(pluginId, contribution.id);
        seen.add(providerId);
        const raw = saved[providerId];
        const hasCredential = hasSavedCredential(raw);
        let account: string | null = null;
        if (hasCredential && raw) {
          const cached = accounts.get(providerId);
          if (cached && cached.credential === raw && now() - cached.at < FORGE_ACCOUNT_TTL_MS) {
            account = cached.account;
          } else {
            account = await askAccount(providerId);
            accounts.set(providerId, { credential: raw, account, at: now() });
          }
        } else {
          accounts.delete(providerId);
        }
        return { providerId, name: contribution.name.slice(0, 256), hasCredential, account };
      })
    );
    for (const providerId of [...accounts.keys()]) {
      if (!seen.has(providerId)) accounts.delete(providerId);
    }
    return observed;
  };
}
