import type {
  ContextProviderContribution,
  ContextProviderEntry,
  ContextProviderImpl,
} from "../../shared/types/pluginContextProvider.js";
import { projectIdFromPluginInstanceKey } from "../../shared/types/plugin.js";

/**
 * Host-side registry of `contextProviders` contributions (#13795), keyed by
 * plugin instance id. Same two-map shape as `fileDecorationRegistry.ts`:
 * descriptors register eagerly from the manifest during `loadPlugin`, so a
 * project's prefixes are known before any plugin code runs, and impls bind
 * lazily during `activate()` via `host.registerContextProvider`.
 */
interface PluginContextProviders {
  pluginName: string;
  contributions: readonly ContextProviderContribution[];
}

const PLUGIN_CONTEXT_PROVIDERS = new Map<string, PluginContextProviders>();

/** Runtime impls, keyed `{pluginId}.{providerId}`. A missing impl means "not yet bound". */
const PLUGIN_CONTEXT_PROVIDER_IMPLS = new Map<string, ContextProviderImpl>();

function buildImplKey(pluginId: string, providerId: string): string {
  return `${pluginId}.${providerId}`;
}

/**
 * Whether two plugins can ever be visible in the same project: a project
 * plugin is visible only in its own project, an installed one in all of them.
 */
function canShareAProject(a: string, b: string): boolean {
  const projectA = projectIdFromPluginInstanceKey(a);
  const projectB = projectIdFromPluginInstanceKey(b);
  return projectA === null || projectB === null || projectA === projectB;
}

/**
 * Report, once at registration, a prefix the incoming plugin will be refused
 * because a plugin registered earlier already claims it. Best-effort: never
 * throws, so a diagnostic can't block the load.
 */
function warnOnPrefixCollision(
  pluginId: string,
  contributions: readonly ContextProviderContribution[]
): void {
  try {
    for (const [existingId, existing] of PLUGIN_CONTEXT_PROVIDERS) {
      if (existingId === pluginId || !canShareAProject(existingId, pluginId)) continue;
      for (const contribution of contributions) {
        if (!existing.contributions.some((c) => c.prefix === contribution.prefix)) continue;
        console.warn(
          `[Plugin] context provider "${pluginId}.${contribution.id}" is refused the prefix ` +
            `"@${contribution.prefix}:" in projects where "${existingId}" already provides it.`
        );
      }
    }
  } catch {
    // Diagnostics are best-effort.
  }
}

export function registerContextProviders(
  pluginId: string,
  pluginName: string,
  contributions: readonly ContextProviderContribution[]
): void {
  if (typeof pluginId !== "string" || pluginId.length === 0) return;
  if (!Array.isArray(contributions) || contributions.length === 0) {
    PLUGIN_CONTEXT_PROVIDERS.delete(pluginId);
    return;
  }
  // A plugin re-registering on reload keeps its place in the claim order only
  // if it never left; `set` on an existing key preserves insertion order.
  if (!PLUGIN_CONTEXT_PROVIDERS.has(pluginId)) warnOnPrefixCollision(pluginId, contributions);
  PLUGIN_CONTEXT_PROVIDERS.set(pluginId, {
    pluginName,
    contributions: Object.freeze(contributions.map((c) => Object.freeze({ ...c }))),
  });
}

export function unregisterContextProviders(pluginId: string): void {
  PLUGIN_CONTEXT_PROVIDERS.delete(pluginId);
}

export function clearContextProviderRegistry(): void {
  PLUGIN_CONTEXT_PROVIDERS.clear();
}

/**
 * Bind a runtime impl to a declared provider. Re-binding the same key
 * overwrites, so a plugin that registers again picks up the new impl.
 */
export function registerContextProviderImpl(
  pluginId: string,
  providerId: string,
  impl: ContextProviderImpl
): void {
  if (typeof pluginId !== "string" || pluginId.length === 0) return;
  if (typeof providerId !== "string" || providerId.length === 0) return;
  if (impl === null || typeof impl !== "object") return;
  PLUGIN_CONTEXT_PROVIDER_IMPLS.set(buildImplKey(pluginId, providerId), impl);
}

/**
 * Unbind one impl. With `expected`, only if that exact impl is still bound, so
 * a stale disposer from an overwritten binding can't remove the live one.
 */
export function unregisterContextProviderImpl(
  pluginId: string,
  providerId: string,
  expected?: ContextProviderImpl
): void {
  const key = buildImplKey(pluginId, providerId);
  if (expected !== undefined && PLUGIN_CONTEXT_PROVIDER_IMPLS.get(key) !== expected) return;
  PLUGIN_CONTEXT_PROVIDER_IMPLS.delete(key);
}

/** Unbind every impl the plugin owns. Fires on unload and worker teardown. Idempotent. */
export function unregisterContextProviderImpls(pluginId: string): void {
  const prefix = `${pluginId}.`;
  for (const key of [...PLUGIN_CONTEXT_PROVIDER_IMPLS.keys()]) {
    if (key.startsWith(prefix)) PLUGIN_CONTEXT_PROVIDER_IMPLS.delete(key);
  }
}

export function clearContextProviderImplRegistry(): void {
  PLUGIN_CONTEXT_PROVIDER_IMPLS.clear();
}

export function getContextProviderImpl(
  pluginId: string,
  providerId: string
): ContextProviderImpl | undefined {
  return PLUGIN_CONTEXT_PROVIDER_IMPLS.get(buildImplKey(pluginId, providerId));
}

/** One registered provider, in claim order. */
export interface RegisteredContextProvider {
  pluginId: string;
  pluginName: string;
  contribution: ContextProviderContribution;
}

/** Every declared provider, in plugin registration order — the order prefixes are claimed in. */
export function getRegisteredContextProviders(): RegisteredContextProvider[] {
  const result: RegisteredContextProvider[] = [];
  for (const [pluginId, { pluginName, contributions }] of PLUGIN_CONTEXT_PROVIDERS) {
    for (const contribution of contributions) result.push({ pluginId, pluginName, contribution });
  }
  return result;
}

/**
 * Who holds each prefix among the providers one project can see. The first
 * registered claimant that is switched on holds it; a later one is refused and
 * names the holder. A provider switched off claims nothing, so turning the
 * holder off is how the user hands a prefix to the next plugin in line.
 */
export function arbitrateContextProviders(
  visible: readonly RegisteredContextProvider[],
  isOff: (pluginId: string) => boolean
): ContextProviderEntry[] {
  const holders = new Map<string, RegisteredContextProvider>();
  return visible.map(({ pluginId, pluginName, contribution }) => {
    const base = {
      pluginId,
      pluginName,
      providerId: contribution.id,
      prefix: contribution.prefix,
      label: contribution.label,
      scope: projectIdFromPluginInstanceKey(pluginId) === null ? "global" : "project",
    } as const;
    if (isOff(pluginId)) return { ...base, status: "off" };
    const holder = holders.get(contribution.prefix);
    if (holder) {
      return {
        ...base,
        status: "refused",
        heldBy: { pluginId: holder.pluginId, pluginName: holder.pluginName },
      };
    }
    holders.set(contribution.prefix, { pluginId, pluginName, contribution });
    return { ...base, status: "active" };
  });
}
