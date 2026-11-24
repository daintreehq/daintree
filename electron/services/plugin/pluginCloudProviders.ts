// Cloud providers contributed by plugins (#17351), as main knows them: the
// declarations of the plugins loaded now, the impls their activations bound,
// and the plugin service's word on why a provider's plugin can't serve it.
// The cloud runtime reads this and registers each declaration as a provider;
// the plugin service writes it. Neither imports the other, and with no plugin
// declaring a provider nothing here does any work.

import {
  cloudProviderNamespace,
  pluginCloudProviderId,
  type CloudProviderId,
} from "../../../shared/types/cloudHosts.js";
import type {
  CloudProviderContribution,
  CloudProviderImpl,
  CloudProviderMethod,
} from "../../../shared/types/pluginCloudProvider.js";
import { CLOUD_PROVIDER_METHODS } from "../../../shared/types/pluginCloudProvider.js";
import {
  PluginCloudProviderAnswerError,
  PluginCloudProviderTransportError,
  cloudProviderImplArgs,
  cloudProviderMethodsNeeded,
} from "./pluginCloudProviderCalls.js";
import { pluginCloudConsentFingerprint } from "./pluginCloudProviderConsent.js";

export interface PluginCloudProviderDeclaration {
  readonly pluginId: string;
  /** What the person knows the plugin as (its display name, or its id when it has none), and what its accounts keep calling it once it's gone. */
  readonly pluginName: string;
  readonly providerId: CloudProviderId;
  readonly contribution: CloudProviderContribution;
  /**
   * What a person agrees to before this plugin's providers get an account, the
   * same for each of its declarations from one load (`pluginCloudConsentFingerprint`).
   */
  readonly consentFingerprint: string;
}

/**
 * A bound impl as main calls it: the arguments that cross (credentials
 * without their signal), and the signal separately. Resolves with the
 * provider's answer; rejects with a {@link PluginCloudProviderAnswerError}
 * when the provider failed, and anything else when no answer came back.
 */
export interface PluginCloudProviderBinding {
  readonly methods: ReadonlySet<CloudProviderMethod>;
  call(
    method: CloudProviderMethod,
    args: readonly unknown[],
    signal: AbortSignal
  ): Promise<unknown>;
}

/** What only the plugin service knows. */
export interface PluginCloudProviderRuntime {
  /** Idempotent, and never rejects, like `PluginService.activatePlugin`. */
  activate(pluginId: string): Promise<void>;
  /** Whether the plugin's activation succeeded and still stands. */
  isActivated(pluginId: string): boolean;
  /** Why `providerId`, which no loaded plugin declares now, can't be used. */
  unavailableReason(pluginId: string, providerId: CloudProviderId): string;
  /** Why the plugin's worker failed to start this session, or null when it hasn't. */
  startFailure(pluginId: string): string | null;
}

interface Bound {
  /** The declaration it was bound under: a reload's fresh one never reaches it. */
  declaration: PluginCloudProviderDeclaration;
  binding: PluginCloudProviderBinding;
}

const DECLARATIONS = new Map<string, readonly PluginCloudProviderDeclaration[]>();
const BINDINGS = new Map<CloudProviderId, Bound>();
const LISTENERS = new Set<() => void>();
let runtime: PluginCloudProviderRuntime | null = null;
let consentForgetter: ((pluginId: string) => void) | null = null;
/** Uninstalled before the cloud runtime was there to hear it; forgotten once it is. */
const PENDING_FORGETS = new Set<string>();

function notify(): void {
  for (const listener of [...LISTENERS]) {
    try {
      listener();
    } catch (error) {
      console.error("[PluginCloudProviders] change listener failed:", error);
    }
  }
}

/**
 * Publish a loaded plugin's declared providers, replacing what an earlier load
 * of it published. Each entry gets a fresh declaration object, which is what
 * tells the cloud runtime a reload changed it.
 */
export function publishPluginCloudProviders(
  pluginId: string,
  contributions: readonly CloudProviderContribution[],
  pluginName: string = pluginId
): void {
  const entries: Array<{ providerId: CloudProviderId; contribution: CloudProviderContribution }> =
    [];
  for (const contribution of contributions) {
    const providerId = pluginCloudProviderId(pluginId, contribution.id);
    if (providerId !== null) entries.push({ providerId, contribution });
  }
  const consentFingerprint = pluginCloudConsentFingerprint(entries);
  const name = pluginName.trim() || pluginId;
  const declarations = entries.map(({ providerId, contribution }) =>
    Object.freeze({ pluginId, pluginName: name, providerId, contribution, consentFingerprint })
  );
  if (declarations.length === 0 && !DECLARATIONS.has(pluginId)) return;
  if (declarations.length === 0) DECLARATIONS.delete(pluginId);
  else DECLARATIONS.set(pluginId, declarations);
  // Every declaration is new, so nothing bound under the old ones answers for them.
  unbindPluginCloudProviders(pluginId);
  notify();
}

/** The plugin unloaded: its providers go, with their bindings. */
export function withdrawPluginCloudProviders(pluginId: string): void {
  const had = DECLARATIONS.delete(pluginId);
  unbindPluginCloudProviders(pluginId);
  if (had) notify();
}

/** Whether `pluginId`'s loaded manifest declares any cloud provider. */
export function pluginDeclaresCloudProviders(pluginId: string): boolean {
  return DECLARATIONS.has(pluginId);
}

export function listPluginCloudProviders(): PluginCloudProviderDeclaration[] {
  return [...DECLARATIONS.values()].flat();
}

function declarationFor(pluginId: string, id: string): PluginCloudProviderDeclaration | undefined {
  return DECLARATIONS.get(pluginId)?.find((declaration) => declaration.contribution.id === id);
}

/**
 * Bind `impl` to the provider `pluginId` declares as `id`. Throws when the
 * manifest doesn't declare it or the impl lacks a method the declaration
 * needs. Returns a disposer that unbinds this binding and never a later one.
 */
export function bindPluginCloudProvider(
  pluginId: string,
  id: string,
  impl: CloudProviderImpl
): () => void {
  const declaration = typeof id === "string" ? declarationFor(pluginId, id) : undefined;
  if (!declaration) {
    throw new Error(`"${id}" is not declared in contributes.cloudProviders`);
  }
  const methods = new Set<CloudProviderMethod>();
  for (const method of CLOUD_PROVIDER_METHODS) {
    if (typeof impl[method] === "function") methods.add(method);
  }
  const missing = cloudProviderMethodsNeeded(declaration.contribution).filter(
    (method) => !methods.has(method)
  );
  if (missing.length > 0) {
    throw new Error(`cloud provider "${id}" has no ${missing.join(", ")}`);
  }
  const binding: PluginCloudProviderBinding = {
    methods,
    async call(method, args, signal) {
      const run = impl[method] as ((...callArgs: unknown[]) => unknown) | undefined;
      if (typeof run !== "function") {
        throw new PluginCloudProviderAnswerError("unsupported", `It has no ${method}`);
      }
      try {
        return await run.apply(impl, cloudProviderImplArgs(method, args, signal));
      } catch (error) {
        // A worker's proxy already says which of the two it was; anything else is the impl's own throw.
        if (
          error instanceof PluginCloudProviderAnswerError ||
          error instanceof PluginCloudProviderTransportError
        ) {
          throw error;
        }
        throw PluginCloudProviderAnswerError.from(error);
      }
    },
  };
  const bound: Bound = { declaration, binding };
  BINDINGS.set(declaration.providerId, bound);
  return () => {
    if (BINDINGS.get(declaration.providerId) === bound) BINDINGS.delete(declaration.providerId);
  };
}

/** Drop every binding `pluginId` made: its worker stopped, or the plugin unloaded. */
export function unbindPluginCloudProviders(pluginId: string): void {
  for (const [providerId, bound] of [...BINDINGS]) {
    if (bound.declaration.pluginId === pluginId) BINDINGS.delete(providerId);
  }
}

/**
 * The impl bound for `declaration`, and only for that declaration: credentials
 * checked against one load's manifest never reach an impl bound under a later one.
 */
export function pluginCloudProviderBinding(
  declaration: PluginCloudProviderDeclaration
): PluginCloudProviderBinding | undefined {
  const bound = BINDINGS.get(declaration.providerId);
  return bound?.declaration === declaration ? bound.binding : undefined;
}

export function setPluginCloudProviderRuntime(next: PluginCloudProviderRuntime | null): void {
  runtime = next;
  notify();
}

export function getPluginCloudProviderRuntime(): PluginCloudProviderRuntime | null {
  return runtime;
}

/**
 * Why a plugin's provider that isn't registered can't be used, or null for an
 * id outside any plugin's namespace (a built-in's absence is the cloud side's
 * to word).
 */
export function pluginCloudProviderUnavailableReason(providerId: CloudProviderId): string | null {
  const namespace = cloudProviderNamespace(providerId);
  if (namespace?.kind !== "plugin") return null;
  return (
    runtime?.unavailableReason(namespace.pluginId, providerId) ??
    `Its cloud provider comes from the ${namespace.pluginId} plugin, which isn't running.`
  );
}

/**
 * The plugin was uninstalled: the person's agreement to its cloud providers
 * goes with it, so whatever installs under the same id later asks again. Its
 * accounts stay, unavailable, until then. An update never calls this.
 */
export function forgetPluginCloudProviderConsent(pluginId: string): void {
  if (!consentForgetter) {
    PENDING_FORGETS.add(pluginId);
    return;
  }
  consentForgetter(pluginId);
}

/** Set by the cloud runtime while it runs; it hears every uninstall made before it started too. */
export function setPluginCloudConsentForgetter(next: ((pluginId: string) => void) | null): void {
  consentForgetter = next;
  if (!next) return;
  for (const pluginId of [...PENDING_FORGETS]) {
    try {
      next(pluginId);
      // Dropped only once forgotten: a failed write is tried again by the next forgetter.
      PENDING_FORGETS.delete(pluginId);
    } catch (error) {
      console.error(
        `[PluginCloudProviders] forgetting the consent of "${pluginId}" failed:`,
        error
      );
    }
  }
}

/** A plugin's state changed in a way the reasons read (it failed to load, startup finished). */
export function pluginCloudProviderStatusChanged(): void {
  notify();
}

export function onPluginCloudProvidersChanged(listener: () => void): () => void {
  LISTENERS.add(listener);
  return () => LISTENERS.delete(listener);
}

/** Test isolation. */
export function clearPluginCloudProviders(): void {
  DECLARATIONS.clear();
  BINDINGS.clear();
  LISTENERS.clear();
  runtime = null;
  consentForgetter = null;
  PENDING_FORGETS.clear();
}
