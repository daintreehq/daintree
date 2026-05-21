import type {
  FileDecorationContribution,
  FileDecorationProviderImpl,
  RegisteredFileDecorationProvider,
} from "../../shared/types/forge.js";

export type { RegisteredFileDecorationProvider } from "../../shared/types/forge.js";

/**
 * Host-side registry of `fileDecorationProviders` contributions, keyed by
 * pluginId. Mirrors the two-map structure of `forgeProviderRegistry.ts`:
 * descriptors register eagerly from each plugin's manifest during
 * `loadPlugin` (so scope routing is decidable before any plugin code runs),
 * while the runtime {@link FileDecorationProviderImpl} binds lazily during
 * `activate()` via `host.registerFileDecorationProvider`.
 *
 * The host treats decorations opaquely — it never inspects what a decoration
 * represents (review threads, lint state, …). That meaning belongs entirely
 * to the contributing plugin.
 */
const PLUGIN_FILE_DECORATION_PROVIDERS = new Map<string, FileDecorationContribution[]>();

/**
 * Runtime impls bound via `host.registerFileDecorationProvider`. Keyed by the
 * canonical id `{pluginId}.{contributionId}` so a scope lookup resolves an
 * impl without joining two maps. Separate from
 * {@link PLUGIN_FILE_DECORATION_PROVIDERS} because descriptors register
 * eagerly from the manifest while impls bind lazily during `activate()` —
 * callers must treat a missing impl as "not yet bound", not an error.
 */
const PLUGIN_FILE_DECORATION_IMPLS = new Map<string, FileDecorationProviderImpl>();

function buildImplKey(pluginId: string, contributionId: string): string {
  return `${pluginId}.${contributionId}`;
}

function freezeContribution(c: FileDecorationContribution): FileDecorationContribution {
  return Object.freeze({
    ...c,
    scopes: Object.freeze([...c.scopes]) as unknown as string[],
  });
}

export function registerFileDecorationProviders(
  pluginId: string,
  contributions: FileDecorationContribution[]
): void {
  if (typeof pluginId !== "string" || pluginId.length === 0) return;
  if (!Array.isArray(contributions) || contributions.length === 0) {
    PLUGIN_FILE_DECORATION_PROVIDERS.delete(pluginId);
    return;
  }
  PLUGIN_FILE_DECORATION_PROVIDERS.set(pluginId, contributions.map(freezeContribution));
}

export function unregisterFileDecorationProviders(pluginId: string): void {
  if (typeof pluginId !== "string" || pluginId.length === 0) return;
  PLUGIN_FILE_DECORATION_PROVIDERS.delete(pluginId);
}

export function clearFileDecorationRegistry(): void {
  PLUGIN_FILE_DECORATION_PROVIDERS.clear();
}

/**
 * Bind a runtime {@link FileDecorationProviderImpl} to a descriptor declared
 * by `contributes.fileDecorationProviders`. Re-binding the same key
 * overwrites — a plugin that re-registers from a deferred callback picks up
 * the new impl on the next decoration pull.
 */
export function registerFileDecorationProviderImpl(
  pluginId: string,
  contributionId: string,
  impl: FileDecorationProviderImpl
): void {
  if (typeof pluginId !== "string" || pluginId.length === 0) return;
  if (typeof contributionId !== "string" || contributionId.length === 0) return;
  if (impl === null || typeof impl !== "object") return;
  PLUGIN_FILE_DECORATION_IMPLS.set(buildImplKey(pluginId, contributionId), impl);
}

/**
 * Unbind a single runtime impl. Silent no-op if the key was never bound.
 * Pass `expected` to make the removal conditional — the entry is deleted only
 * if it currently references that exact impl, so a stale disposer (from a
 * prior binding that was overwritten) cannot remove the active impl.
 */
export function unregisterFileDecorationProviderImpl(
  pluginId: string,
  contributionId: string,
  expected?: FileDecorationProviderImpl
): void {
  if (typeof pluginId !== "string" || pluginId.length === 0) return;
  if (typeof contributionId !== "string" || contributionId.length === 0) return;
  const key = buildImplKey(pluginId, contributionId);
  if (expected !== undefined) {
    const current = PLUGIN_FILE_DECORATION_IMPLS.get(key);
    if (current !== expected) return;
  }
  PLUGIN_FILE_DECORATION_IMPLS.delete(key);
}

/**
 * Unbind every impl owned by the given plugin. Fires from `unloadPlugin`
 * alongside descriptor cleanup. Idempotent.
 */
export function unregisterFileDecorationProviderImpls(pluginId: string): void {
  if (typeof pluginId !== "string" || pluginId.length === 0) return;
  const prefix = `${pluginId}.`;
  for (const key of [...PLUGIN_FILE_DECORATION_IMPLS.keys()]) {
    if (key.startsWith(prefix)) {
      PLUGIN_FILE_DECORATION_IMPLS.delete(key);
    }
  }
}

/** Test-isolation helper paralleling {@link clearFileDecorationRegistry}. */
export function clearFileDecorationImplRegistry(): void {
  PLUGIN_FILE_DECORATION_IMPLS.clear();
}

/**
 * Match a runtime scope string against a declared scope pattern. Supports
 * exact equality and a single trailing `*` wildcard on a `prefix:*` form
 * (e.g. `worktree-diff:*` matches `worktree-diff:/abs/path`). A bare `*`
 * matches any scope. No regex — the pattern space is intentionally tiny so
 * the contract stays obvious to plugin authors.
 */
export function scopeMatchesPattern(scope: string, pattern: string): boolean {
  if (pattern === "*") return true;
  if (pattern.endsWith("*")) {
    return scope.startsWith(pattern.slice(0, -1));
  }
  return scope === pattern;
}

/**
 * Resolve the bound impls whose declared scopes match `scope`, in plugin
 * load order (stable per boot). Returns the contribution id and pluginId
 * alongside each impl so the IPC handler can attribute results. Descriptors
 * without a bound impl are skipped — the plugin's `activate()` may not have
 * run yet, or it unloaded; callers treat that as "no decorations".
 */
export function getFileDecorationImpls(scope: string): Array<{
  pluginId: string;
  contributionId: string;
  impl: FileDecorationProviderImpl;
}> {
  const result: Array<{
    pluginId: string;
    contributionId: string;
    impl: FileDecorationProviderImpl;
  }> = [];
  if (typeof scope !== "string" || scope.length === 0) return result;
  for (const [pluginId, contributions] of PLUGIN_FILE_DECORATION_PROVIDERS) {
    for (const contribution of contributions) {
      if (!contribution.scopes.some((p) => scopeMatchesPattern(scope, p))) continue;
      const impl = PLUGIN_FILE_DECORATION_IMPLS.get(buildImplKey(pluginId, contribution.id));
      if (impl) {
        result.push({ pluginId, contributionId: contribution.id, impl });
      }
    }
  }
  return result;
}

/** Flattened snapshot of all registered descriptors (manifest-level). */
export function getRegisteredFileDecorationProviders(): RegisteredFileDecorationProvider[] {
  const result: RegisteredFileDecorationProvider[] = [];
  for (const [pluginId, contributions] of PLUGIN_FILE_DECORATION_PROVIDERS) {
    for (const contribution of contributions) {
      result.push({ pluginId, contribution });
    }
  }
  return result;
}
