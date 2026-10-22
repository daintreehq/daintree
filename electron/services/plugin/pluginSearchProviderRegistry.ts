import type {
  PluginSearchProvider,
  PluginSearchResolvedTarget,
  PluginSearchResultTarget,
} from "../../../shared/types/plugin.js";
import type { DeclarativeSearchRunner } from "./pluginSearchDatabase.js";

/** A search provider as main registered it from a loaded plugin's manifest (#13792). */
export interface RegisteredSearchProvider {
  /** `{pluginId}.{provider id}`. */
  key: string;
  pluginId: string;
  providerId: string;
  pluginName: string;
  title: string;
  keyword: string;
  /** Resolved for rendering: a generic icon id or the plugin's custom-icon key. */
  iconId: string;
  blend: boolean;
  kind: "declarative" | "runtime";
  /** The project a project plugin belongs to; null for an installed plugin, which any project can see. */
  projectId: string | null;
  /** The manifest's `target`: required for a declarative provider, the default for a runtime one. */
  defaultTarget?: PluginSearchResultTarget;
  /**
   * A manifest-terms target as runtime ids, or null when it names nothing of
   * this plugin's own. Results come from plugin code, so every one is held to
   * this, not just the manifest's.
   */
  resolveTarget: (
    target: PluginSearchResultTarget,
    args: Record<string, unknown>
  ) => PluginSearchResolvedTarget | null;
  /**
   * A result's `iconId` as a renderable id: a generic icon id, or one of this
   * plugin's custom icons that loaded. Undefined falls back to {@link iconId}.
   */
  resolveResultIcon: (iconId: string) => string | undefined;
  /** Declarative only. */
  runDeclarative?: DeclarativeSearchRunner;
}

/** A keyword two plugins both claimed for a project both can be seen in. */
export interface SearchKeywordCollision {
  /** The provider that is refused. */
  provider: RegisteredSearchProvider;
  /** The provider registered first, which keeps the keyword. */
  takenBy: RegisteredSearchProvider;
}

/**
 * Registered providers in registration order, which is also keyword priority:
 * the first provider to claim a keyword in a project keeps it.
 */
const PROVIDERS = new Map<string, RegisteredSearchProvider>();

/**
 * Runtime functions bound in `activate()`. Separate because descriptors
 * register eagerly from the manifest while functions bind lazily: a missing
 * one means "not running", which a blended search must not change.
 */
const IMPLS = new Map<string, { impl: PluginSearchProvider }>();

/**
 * When each provider key was first registered this session. A plugin that
 * reloads keeps its place, so reloading the plugin that holds a keyword never
 * hands it to the one that was refused.
 */
const FIRST_SEEN = new Map<string, number>();
let seq = 0;

/**
 * The keyword each provider key last registered with this session. Kept across
 * an unload like {@link FIRST_SEEN}, because a reload unregisters before it
 * registers again: only a keyword the provider didn't hold last time can
 * displace another plugin's.
 */
const LAST_KEYWORD = new Map<string, string>();

/** Two providers can collide only where both can be seen: any installed plugin, or the same project. */
function audiencesOverlap(a: RegisteredSearchProvider, b: RegisteredSearchProvider): boolean {
  return a.projectId === null || b.projectId === null || a.projectId === b.projectId;
}

function byFirstSeen(a: RegisteredSearchProvider, b: RegisteredSearchProvider): number {
  return (FIRST_SEEN.get(a.key) ?? 0) - (FIRST_SEEN.get(b.key) ?? 0);
}

/**
 * Where two overlapping providers are both seen: everywhere (null) when both
 * are installed, else the one project the project-scoped side belongs to.
 */
function sharedAudience(a: RegisteredSearchProvider, b: RegisteredSearchProvider): string | null {
  return a.projectId ?? b.projectId;
}

/** Whether `provider` is seen everywhere `audience` reaches. */
function covers(provider: RegisteredSearchProvider, audience: string | null): boolean {
  return provider.projectId === null || provider.projectId === audience;
}

/** The earliest of `among` that claims `provider`'s keyword before it, where both can be seen. */
function earlierClaim(
  provider: RegisteredSearchProvider,
  among: readonly RegisteredSearchProvider[]
): RegisteredSearchProvider | undefined {
  return among
    .filter(
      (other) =>
        other.key !== provider.key &&
        other.keyword === provider.keyword &&
        audiencesOverlap(other, provider) &&
        byFirstSeen(other, provider) < 0
    )
    .sort(byFirstSeen)[0];
}

/**
 * Register one plugin's providers, replacing any it registered before. Returns
 * each keyword collision this registration creates, for the caller to report
 * to the refused provider's plugin: an incoming provider an earlier one
 * shadows, and an already-registered provider that an incoming one (keeping
 * its earlier place across a reload) newly shadows. Which provider is refused
 * in a given project is decided by {@link searchKeywordRefusals}.
 */
export function registerSearchProviders(
  pluginId: string,
  providers: readonly RegisteredSearchProvider[]
): SearchKeywordCollision[] {
  unregisterSearchProviders(pluginId);
  const collisions: SearchKeywordCollision[] = [];
  const previousKeyword = new Map<string, string | undefined>();
  for (const provider of providers) {
    if (!FIRST_SEEN.has(provider.key)) FIRST_SEEN.set(provider.key, seq++);
    previousKeyword.set(provider.key, LAST_KEYWORD.get(provider.key));
    LAST_KEYWORD.set(provider.key, provider.keyword);
  }
  const existing = [...PROVIDERS.values()];
  for (const provider of providers) {
    const owner = earlierClaim(provider, existing);
    if (owner) collisions.push({ provider, takenBy: owner });
    PROVIDERS.set(provider.key, provider);
  }
  for (const provider of providers) {
    // Only a keyword this provider didn't hold before can displace anyone; a
    // reload that keeps it changes nothing that wasn't already reported.
    if (previousKeyword.get(provider.key) === provider.keyword) continue;
    for (const other of existing) {
      if (byFirstSeen(provider, other) >= 0 || other.keyword !== provider.keyword) continue;
      if (!audiencesOverlap(provider, other)) continue;
      // Already refused wherever this provider now takes it from: nothing new.
      const audience = sharedAudience(provider, other);
      const alreadyRefused = existing.some(
        (third) =>
          third.key !== other.key &&
          third.keyword === other.keyword &&
          byFirstSeen(third, other) < 0 &&
          covers(third, audience)
      );
      if (alreadyRefused) continue;
      collisions.push({ provider: other, takenBy: provider });
    }
  }
  return collisions;
}

/** Drop a plugin's providers and their bound functions. */
export function unregisterSearchProviders(pluginId: string): void {
  for (const [key, provider] of PROVIDERS) {
    if (provider.pluginId !== pluginId) continue;
    PROVIDERS.delete(key);
    IMPLS.delete(key);
  }
}

export function getSearchProvider(key: string): RegisteredSearchProvider | undefined {
  return PROVIDERS.get(key);
}

/** Every registered provider, in keyword-priority order. */
export function getAllSearchProviders(): RegisteredSearchProvider[] {
  return [...PROVIDERS.values()].sort(byFirstSeen);
}

/**
 * Which provider owns each keyword among `visible` — the providers one project
 * can see. The earliest registered wins; every other provider with the same
 * keyword maps to the one that took it.
 */
export function searchKeywordRefusals(
  visible: readonly RegisteredSearchProvider[]
): Map<string, RegisteredSearchProvider> {
  const ownerByKeyword = new Map<string, RegisteredSearchProvider>();
  const takenBy = new Map<string, RegisteredSearchProvider>();
  for (const provider of [...visible].sort(byFirstSeen)) {
    const owner = ownerByKeyword.get(provider.keyword);
    if (owner) takenBy.set(provider.key, owner);
    else ownerByKeyword.set(provider.keyword, provider);
  }
  return takenBy;
}

/**
 * Bind a runtime provider's function. Returns a disposer that unbinds only
 * this binding: once a later one has replaced it — even with the same
 * function — the disposer does nothing. Throws for a key with no registered
 * runtime provider.
 */
export function bindSearchProviderImpl(key: string, impl: PluginSearchProvider): () => void {
  const provider = PROVIDERS.get(key);
  if (!provider || provider.kind !== "runtime") {
    throw new Error(`no runtime search provider "${key}" is declared`);
  }
  const binding = { impl };
  IMPLS.set(key, binding);
  return () => {
    if (IMPLS.get(key) === binding) IMPLS.delete(key);
  };
}

export function getSearchProviderImpl(key: string): PluginSearchProvider | undefined {
  return IMPLS.get(key)?.impl;
}

/** Test seam. */
export function clearSearchProviderRegistry(): void {
  PROVIDERS.clear();
  IMPLS.clear();
  FIRST_SEEN.clear();
  LAST_KEYWORD.clear();
  seq = 0;
}
