import type {
  ForgeProviderContribution,
  ForgeProviderImpl,
  RegisteredForgeProvider,
  RepoRef,
} from "../../shared/types/forge.js";
import { makeForgeProviderId } from "../../shared/utils/forgeProviderIds.js";

export type { RegisteredForgeProvider } from "../../shared/types/forge.js";

/**
 * Host-side registry of `forgeProviders` contributions, keyed by pluginId.
 *
 * Populated eagerly from each plugin's manifest during `loadPlugin` so the
 * Preferences UI and remote-URL routing table are usable before any plugin's
 * `activate()` runs. Cleared on plugin unload via the existing disposable
 * cascade in `PluginService.unloadPlugin`.
 *
 * The runtime implementation handler (`ForgeProviderImpl`) is wired separately
 * via `host.registerForgeProvider` and stored in
 * {@link PLUGIN_FORGE_PROVIDER_IMPLS} keyed by namespaced id.
 */
const PLUGIN_FORGE_PROVIDERS = new Map<string, ForgeProviderContribution[]>();

/**
 * Runtime implementation handlers bound via `host.registerForgeProvider`.
 * Keyed by the canonical provider id `{pluginId}.{contributionId}` (#8451) so
 * the router can resolve an impl from a descriptor without a second lookup.
 * Separate from {@link PLUGIN_FORGE_PROVIDERS} because descriptors register
 * eagerly from the manifest while impls bind lazily during `activate()` —
 * callers must handle "descriptor present but impl not yet bound" by treating
 * an `undefined` result as absent.
 */
const PLUGIN_FORGE_PROVIDER_IMPLS = new Map<string, ForgeProviderImpl>();

export function registerForgeProviders(
  pluginId: string,
  contributions: ForgeProviderContribution[]
): void {
  if (typeof pluginId !== "string" || pluginId.length === 0) return;
  if (!Array.isArray(contributions) || contributions.length === 0) {
    PLUGIN_FORGE_PROVIDERS.delete(pluginId);
    return;
  }
  PLUGIN_FORGE_PROVIDERS.set(pluginId, contributions.map(freezeContribution));
}

function freezeContribution(c: ForgeProviderContribution): ForgeProviderContribution {
  const frozen: ForgeProviderContribution = {
    ...c,
    matches: Object.freeze([...c.matches]) as unknown as string[],
  };
  if (c.capabilities) {
    frozen.capabilities = Object.freeze([
      ...c.capabilities,
    ]) as unknown as ForgeProviderContribution["capabilities"];
  }
  if (c.viewRefs) {
    frozen.viewRefs = Object.freeze([...c.viewRefs]) as unknown as string[];
  }
  return Object.freeze(frozen);
}

export function unregisterForgeProviders(pluginId: string): void {
  if (typeof pluginId !== "string" || pluginId.length === 0) return;
  PLUGIN_FORGE_PROVIDERS.delete(pluginId);
}

export function clearForgeProviderRegistry(): void {
  PLUGIN_FORGE_PROVIDERS.clear();
}

/**
 * Bind a runtime {@link ForgeProviderImpl} to a descriptor declared by
 * `contributes.forgeProviders`. Keyed as `{pluginId}.{contributionId}` so a
 * later lookup by namespaced id resolves without joining two maps. Re-binding
 * the same key overwrites — plugins that re-register from a deferred callback
 * pick up the new impl on next call.
 */
export function registerForgeProviderImpl(
  pluginId: string,
  contributionId: string,
  impl: ForgeProviderImpl
): void {
  if (typeof pluginId !== "string" || pluginId.length === 0) return;
  if (typeof contributionId !== "string" || contributionId.length === 0) return;
  if (impl === null || typeof impl !== "object") return;
  PLUGIN_FORGE_PROVIDER_IMPLS.set(buildImplKey(pluginId, contributionId), impl);
}

/**
 * Unbind a single runtime impl. Silent no-op if the key was never bound.
 * Used by the per-provider disposer returned from `host.registerForgeProvider`
 * so a plugin can clean up one binding without unloading itself.
 *
 * Pass `expected` to make the removal conditional — the entry is deleted only
 * if it currently references that exact impl. This prevents a stale disposer
 * (from a prior `registerForgeProviderImpl` call on the same key that was
 * later overwritten) from removing the active impl.
 */
export function unregisterForgeProviderImpl(
  pluginId: string,
  contributionId: string,
  expected?: ForgeProviderImpl
): void {
  if (typeof pluginId !== "string" || pluginId.length === 0) return;
  if (typeof contributionId !== "string" || contributionId.length === 0) return;
  const key = buildImplKey(pluginId, contributionId);
  if (expected !== undefined) {
    const current = PLUGIN_FORGE_PROVIDER_IMPLS.get(key);
    if (current !== expected) return;
  }
  PLUGIN_FORGE_PROVIDER_IMPLS.delete(key);
}

/**
 * Unbind every impl owned by the given plugin. Fires from `unloadPlugin`
 * alongside descriptor cleanup. Idempotent — calling after the per-provider
 * disposers have already fired is a safe no-op.
 */
export function unregisterForgeProviderImpls(pluginId: string): void {
  if (typeof pluginId !== "string" || pluginId.length === 0) return;
  const prefix = `${pluginId}.`;
  for (const key of [...PLUGIN_FORGE_PROVIDER_IMPLS.keys()]) {
    if (key.startsWith(prefix)) {
      PLUGIN_FORGE_PROVIDER_IMPLS.delete(key);
    }
  }
}

/**
 * Look up a runtime impl by its canonical id (`{pluginId}.{contributionId}`).
 * Returns `undefined` when the descriptor is registered but the plugin's
 * `activate()` has not yet bound an impl, or after the plugin unloads.
 * Callers must treat `undefined` as "no impl currently available" and avoid
 * throwing.
 */
export function getForgeProviderImpl(namespacedId: string): ForgeProviderImpl | undefined {
  if (typeof namespacedId !== "string" || namespacedId.length === 0) return undefined;
  return PLUGIN_FORGE_PROVIDER_IMPLS.get(namespacedId);
}

/** Test-isolation helper paralleling {@link clearForgeProviderRegistry}. */
export function clearForgeProviderImplRegistry(): void {
  PLUGIN_FORGE_PROVIDER_IMPLS.clear();
}

function buildImplKey(pluginId: string, contributionId: string): string {
  return makeForgeProviderId(pluginId, contributionId);
}

export function getRegisteredForgeProviders(): RegisteredForgeProvider[] {
  const result: RegisteredForgeProvider[] = [];
  for (const [pluginId, contributions] of PLUGIN_FORGE_PROVIDERS) {
    for (const contribution of contributions) {
      result.push({ pluginId, contribution });
    }
  }
  return result;
}

export function listMatchingProviders(remoteUrl: string): RegisteredForgeProvider[] {
  const hostname = extractHostname(remoteUrl);
  if (hostname === null) return [];
  return listProvidersByHostname(hostname);
}

export function getActiveProvider(remoteUrl: string): RegisteredForgeProvider | undefined;
export function getActiveProvider(repoRef: RepoRef): RegisteredForgeProvider | undefined;
export function getActiveProvider(arg: string | RepoRef): RegisteredForgeProvider | undefined {
  if (typeof arg === "string") {
    return listMatchingProviders(arg)[0];
  }
  if (arg === null || typeof arg !== "object" || typeof arg.host !== "string") {
    return undefined;
  }
  const hostname = normalizeHostname(arg.host);
  if (hostname === null) return undefined;
  return listProvidersByHostname(hostname)[0];
}

function listProvidersByHostname(hostname: string): RegisteredForgeProvider[] {
  const matches: RegisteredForgeProvider[] = [];
  for (const [pluginId, contributions] of PLUGIN_FORGE_PROVIDERS) {
    for (const contribution of contributions) {
      if (hostnameMatchesAny(hostname, contribution.matches)) {
        matches.push({ pluginId, contribution });
      }
    }
  }
  return matches;
}

function hostnameMatchesAny(hostname: string, patterns: string[]): boolean {
  for (const pattern of patterns) {
    const normalized = normalizeHostname(pattern);
    if (normalized !== null && normalized === hostname) return true;
  }
  return false;
}

function normalizeHostname(host: string): string | null {
  if (typeof host !== "string") return null;
  const trimmed = host.trim().toLowerCase();
  if (trimmed.length === 0) return null;
  return trimmed.startsWith("www.") ? trimmed.slice(4) : trimmed;
}

/**
 * Extract a normalized hostname from a git remote URL. Handles SCP form
 * (`user@host:path`), HTTPS, and SSH (`ssh://...`). Returns `null` for
 * malformed input — callers treat that as "no match".
 */
function extractHostname(url: string): string | null {
  if (typeof url !== "string") return null;
  const trimmed = url.trim();
  if (trimmed.length === 0) return null;

  // SCP form: `user@host:path` — no scheme, host terminated by the first colon.
  // The `!includes("://")` discriminator distinguishes this from URLs that
  // carry a port (`https://host:443/...`), which never have an SCP shape.
  if (!trimmed.includes("://") && trimmed.includes(":")) {
    const match = /^(?:[^@/:]+@)?([^:/]+):/.exec(trimmed);
    if (match) return normalizeHostname(match[1]);
    return null;
  }

  try {
    const parsed = new URL(trimmed);
    return normalizeHostname(parsed.hostname);
  } catch {
    return null;
  }
}
