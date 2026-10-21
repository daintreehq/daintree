import type {
  AnyForgeProviderImpl,
  ForgeIssueProviderImpl,
  ForgeProviderBaseImpl,
  ForgeProviderContribution,
  ForgeProviderImpl,
  RegisteredForgeProvider,
  RepoRef,
} from "../../shared/types/forge.js";
import { makeForgeProviderId } from "../../shared/utils/forgeProviderIds.js";
import { forgeProviderServesRole } from "../../shared/utils/forgeProviderRoles.js";
import {
  extractHostname,
  hostnameMatchesAny,
  normalizeHostname,
  type ForgeProviderMatcher,
} from "../../shared/utils/forgeHostnames.js";

export type { RegisteredForgeProvider } from "../../shared/types/forge.js";
export type { ForgeProviderMatcher } from "../../shared/utils/forgeHostnames.js";

/**
 * Listeners notified whenever the registry's descriptor or impl tables
 * change. Drives the provider-health relay (subscribe/unsubscribe a
 * provider's `healthEvents`) and the workspace-host matcher relay (re-push
 * the hostname table) without those services polling the registry.
 */
const REGISTRY_CHANGE_LISTENERS = new Set<() => void>();
const MATCHER_CHANGE_LISTENERS = new Set<() => void>();

export function onForgeProviderRegistryChanged(listener: () => void): () => void {
  REGISTRY_CHANGE_LISTENERS.add(listener);
  return () => {
    REGISTRY_CHANGE_LISTENERS.delete(listener);
  };
}

/**
 * Subscribe only to descriptor-table changes that can alter hostname routing.
 * Runtime impl binding is intentionally excluded: it changes health/RPC
 * availability, but cannot change the manifest-owned matcher table.
 */
export function onForgeProviderMatchersChanged(listener: () => void): () => void {
  MATCHER_CHANGE_LISTENERS.add(listener);
  return () => {
    MATCHER_CHANGE_LISTENERS.delete(listener);
  };
}

function notifyRegistryChanged(): void {
  for (const listener of [...REGISTRY_CHANGE_LISTENERS]) {
    try {
      listener();
    } catch {
      // A throwing listener must not break registration or other listeners.
    }
  }
}

function notifyMatchersChanged(): void {
  for (const listener of [...MATCHER_CHANGE_LISTENERS]) {
    try {
      listener();
    } catch {
      // A throwing listener must not break registration or other listeners.
    }
  }
}

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
const PLUGIN_FORGE_PROVIDER_IMPLS = new Map<string, AnyForgeProviderImpl>();

export function registerForgeProviders(
  pluginId: string,
  contributions: ForgeProviderContribution[]
): void {
  if (typeof pluginId !== "string" || pluginId.length === 0) return;
  if (!Array.isArray(contributions) || contributions.length === 0) {
    PLUGIN_FORGE_PROVIDERS.delete(pluginId);
    notifyRegistryChanged();
    notifyMatchersChanged();
    return;
  }
  PLUGIN_FORGE_PROVIDERS.set(pluginId, contributions.map(freezeContribution));
  notifyRegistryChanged();
  notifyMatchersChanged();
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
  if (c.roles) {
    frozen.roles = Object.freeze([...c.roles]) as unknown as ForgeProviderContribution["roles"];
  }
  return Object.freeze(frozen);
}

export function unregisterForgeProviders(pluginId: string): void {
  if (typeof pluginId !== "string" || pluginId.length === 0) return;
  PLUGIN_FORGE_PROVIDERS.delete(pluginId);
  notifyRegistryChanged();
  notifyMatchersChanged();
}

export function clearForgeProviderRegistry(): void {
  PLUGIN_FORGE_PROVIDERS.clear();
  notifyRegistryChanged();
  notifyMatchersChanged();
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
  impl: AnyForgeProviderImpl
): void {
  if (typeof pluginId !== "string" || pluginId.length === 0) return;
  if (typeof contributionId !== "string" || contributionId.length === 0) return;
  if (impl === null || typeof impl !== "object") return;
  PLUGIN_FORGE_PROVIDER_IMPLS.set(buildImplKey(pluginId, contributionId), impl);
  notifyRegistryChanged();
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
  expected?: AnyForgeProviderImpl
): void {
  if (typeof pluginId !== "string" || pluginId.length === 0) return;
  if (typeof contributionId !== "string" || contributionId.length === 0) return;
  const key = buildImplKey(pluginId, contributionId);
  if (expected !== undefined) {
    const current = PLUGIN_FORGE_PROVIDER_IMPLS.get(key);
    if (current !== expected) return;
  }
  PLUGIN_FORGE_PROVIDER_IMPLS.delete(key);
  notifyRegistryChanged();
}

/**
 * Unbind every impl owned by the given plugin. Fires from `unloadPlugin`
 * alongside descriptor cleanup. Idempotent — calling after the per-provider
 * disposers have already fired is a safe no-op.
 */
export function unregisterForgeProviderImpls(pluginId: string): void {
  if (typeof pluginId !== "string" || pluginId.length === 0) return;
  const prefix = `${pluginId}.`;
  let removed = false;
  for (const key of [...PLUGIN_FORGE_PROVIDER_IMPLS.keys()]) {
    if (key.startsWith(prefix)) {
      PLUGIN_FORGE_PROVIDER_IMPLS.delete(key);
      removed = true;
    }
  }
  if (removed) notifyRegistryChanged();
}

/**
 * Look up a full (issues + code) runtime impl by its canonical id
 * (`{pluginId}.{contributionId}`) — the code-role lookup every PR, CI and
 * repository surface uses. Returns `undefined` when the descriptor is
 * registered but the plugin's `activate()` has not yet bound an impl, after
 * the plugin unloads, and for an issues-only provider, which has no code
 * surface to serve. Callers must treat `undefined` as "no impl currently
 * available" and avoid throwing.
 */
export function getForgeProviderImpl(namespacedId: string): ForgeProviderImpl | undefined {
  const impl = lookupImpl(namespacedId);
  if (!impl) return undefined;
  const contribution = findContribution(namespacedId);
  if (contribution && !forgeProviderServesRole(contribution, "code")) return undefined;
  // Registration checked this impl against its manifest roles, and a provider
  // serving code serves both (`validateForgeImplRoles`).
  return impl as ForgeProviderImpl;
}

/** The issues-role lookup: any bound impl whose manifest roles include issues. */
export function getForgeIssueProviderImpl(
  namespacedId: string
): ForgeIssueProviderImpl | undefined {
  const impl = lookupImpl(namespacedId);
  if (!impl) return undefined;
  const contribution = findContribution(namespacedId);
  if (contribution && !forgeProviderServesRole(contribution, "issues")) return undefined;
  return impl as ForgeIssueProviderImpl;
}

/**
 * Role-agnostic lookup for what every provider implements — credentials,
 * identity, health events. Credential save and token health must reach an
 * issues-only provider too.
 */
export function getForgeProviderBaseImpl(namespacedId: string): ForgeProviderBaseImpl | undefined {
  return lookupImpl(namespacedId);
}

function lookupImpl(namespacedId: string): AnyForgeProviderImpl | undefined {
  if (typeof namespacedId !== "string" || namespacedId.length === 0) return undefined;
  return PLUGIN_FORGE_PROVIDER_IMPLS.get(namespacedId);
}

function findContribution(namespacedId: string): ForgeProviderContribution | undefined {
  for (const [pluginId, contributions] of PLUGIN_FORGE_PROVIDERS) {
    for (const contribution of contributions) {
      if (makeForgeProviderId(pluginId, contribution.id) === namespacedId) return contribution;
    }
  }
  return undefined;
}

const ISSUE_ROLE_METHODS = [
  "listIssues",
  "getIssue",
  "buildIssueUrl",
  "buildIssuesUrl",
  "createIssue",
  "assignIssue",
  "unassignIssue",
  "closeIssue",
  "reopenIssue",
  "editIssue",
  "addIssueComment",
  "addIssueLabel",
  "removeIssueLabel",
] as const;

const BASE_METHODS = ["getCredentials", "validateCredentials", "validateToken"] as const;

const CODE_ROLE_METHODS = [
  "parseRemote",
  "listPRs",
  "getPR",
  "findPRByBranch",
  "getCIStatus",
  "getRepoMetadata",
  "buildPRUrl",
  "buildPRsUrl",
  "buildCommitsUrl",
  "createPR",
  "closePR",
  "reopenPR",
  "mergePR",
  "convertPRToDraft",
  "markPRReadyForReview",
  "commentOnPR",
  "editPR",
] as const;

/**
 * Check an impl against the roles its manifest entry declares, returning a
 * human-readable reason when it can't serve them (or `null` when it can). The
 * role lookups above cast on the strength of this check, so the host must run
 * it before {@link registerForgeProviderImpl}.
 *
 * Checks every required method of each declared role (optional members and
 * capabilities stay optional), so a provider registered against the wrong
 * roles fails here rather than as a `not a function` deep inside a PR poll.
 */
export function validateForgeImplRoles(
  contribution: Pick<ForgeProviderContribution, "roles">,
  impl: AnyForgeProviderImpl
): string | null {
  const record = impl as unknown as Record<string, unknown>;
  const required: string[] = [...BASE_METHODS];
  const servesCode = forgeProviderServesRole(contribution, "code");
  if (forgeProviderServesRole(contribution, "issues")) required.push(...ISSUE_ROLE_METHODS);
  if (servesCode) required.push(...CODE_ROLE_METHODS);
  // An issues-only provider has no remote for the host to parse, so it must
  // build its own repository reference.
  if (!servesCode) required.push("resolveIssueRepo");
  const missing = required.filter((name) => typeof record[name] !== "function");
  return missing.length > 0 ? `missing ${missing.join(", ")}` : null;
}

/**
 * Whether any forge provider has bound a runtime impl. Synchronous, repo-agnostic
 * presence signal for surfaces (command `isEnabled` gates, etc.) that need to know
 * "can any forge answer at all?" before a `cwd` is available to resolve a specific
 * provider. Returns `false` when descriptors are registered but no plugin's
 * `activate()` has bound an impl yet.
 */
export function hasActivatedForgeProvider(): boolean {
  return PLUGIN_FORGE_PROVIDER_IMPLS.size > 0;
}

/** Test-isolation helper paralleling {@link clearForgeProviderRegistry}. */
export function clearForgeProviderImplRegistry(): void {
  PLUGIN_FORGE_PROVIDER_IMPLS.clear();
  notifyRegistryChanged();
}

/**
 * Snapshot of every bound impl keyed by canonical provider id. Used by the
 * provider-health relay to diff subscriptions on registry changes.
 */
export function getForgeProviderImplEntries(): Array<[string, AnyForgeProviderImpl]> {
  return [...PLUGIN_FORGE_PROVIDER_IMPLS.entries()];
}

/**
 * Hostname-matcher table for every registered contribution (manifest-driven,
 * present even before `activate()` binds an impl). Relayed into workspace
 * hosts so monitors resolve remote URLs to provider ids without registry
 * access.
 */
export function listForgeProviderMatchers(): ForgeProviderMatcher[] {
  const matchers: ForgeProviderMatcher[] = [];
  for (const [pluginId, contributions] of PLUGIN_FORGE_PROVIDERS) {
    for (const contribution of contributions) {
      // Hostnames route the code role only (#13700).
      if (!forgeProviderServesRole(contribution, "code")) continue;
      matchers.push({
        providerId: makeForgeProviderId(pluginId, contribution.id),
        hostnames: [...contribution.matches],
      });
    }
  }
  return matchers;
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
      // Hostname matching picks a code forge; an issues-only provider has no
      // remote to match, whatever its manifest lists (#13700).
      if (!forgeProviderServesRole(contribution, "code")) continue;
      if (hostnameMatchesAny(hostname, contribution.matches)) {
        matches.push({ pluginId, contribution });
      }
    }
  }
  return matches;
}
