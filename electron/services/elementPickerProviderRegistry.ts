import {
  makeElementPickerProviderId,
  type ElementPickerDetectionRule,
  type ElementPickerProviderContribution,
  type RegisteredElementPickerProvider,
} from "../../shared/elementPicker/providers.js";
import { isCoreFramework } from "../../shared/elementPicker/source.js";
import { projectIdFromPluginInstanceKey } from "../../shared/types/plugin.js";

/**
 * Host-side registry of `elementPickerProviders` contributions (#14073), keyed
 * by plugin instance id. Descriptors register from the manifest during
 * `loadPlugin`, so they are readable before any plugin code runs, and are
 * dropped on unload (disable and uninstall both unload). Main-process only on
 * purpose: nothing here is mirrored into other processes, so a provider can't
 * be named anywhere main hasn't vetted it.
 */
const PLUGIN_ELEMENT_PICKER_PROVIDERS = new Map<
  string,
  readonly RegisteredElementPickerProvider[]
>();

/**
 * Where each registered provider's plugin lives, kept off the shared type so a
 * directory never rides along with a declaration. Keyed by the frozen record,
 * so a provider replaced by a reload loses its entry with the old object.
 */
const PROVIDER_PLUGIN_DIRS = new WeakMap<RegisteredElementPickerProvider, string>();

const CHANGE_LISTENERS = new Set<() => void>();

/** Notified whenever the set of registered providers changes, so cached allowlists can be retired. */
export function onElementPickerProvidersChanged(listener: () => void): () => void {
  CHANGE_LISTENERS.add(listener);
  return () => {
    CHANGE_LISTENERS.delete(listener);
  };
}

function notifyChanged(): void {
  for (const listener of [...CHANGE_LISTENERS]) {
    try {
      listener();
    } catch {
      // A throwing listener must not break registration or other listeners.
    }
  }
}

export function registerElementPickerProviders(
  pluginId: string,
  pluginName: string,
  contributions: readonly ElementPickerProviderContribution[],
  pluginDir?: string
): void {
  if (typeof pluginId !== "string" || pluginId.length === 0) return;
  if (!Array.isArray(contributions) || contributions.length === 0) {
    unregisterElementPickerProviders(pluginId);
    return;
  }
  const projectId = projectIdFromPluginInstanceKey(pluginId);
  const registered = contributions.map((contribution) =>
    Object.freeze({
      id: makeElementPickerProviderId(pluginName, contribution.id),
      pluginId,
      pluginName,
      projectId,
      name: contribution.name,
      detection: Object.freeze(
        contribution.detection.map((rule: ElementPickerDetectionRule) => Object.freeze({ ...rule }))
      ),
      guestEntry: contribution.guestEntry,
      ...(contribution.resolverEntry !== undefined
        ? { resolverEntry: contribution.resolverEntry }
        : {}),
    })
  );
  if (pluginDir !== undefined) {
    for (const provider of registered) PROVIDER_PLUGIN_DIRS.set(provider, pluginDir);
  }
  PLUGIN_ELEMENT_PICKER_PROVIDERS.set(pluginId, Object.freeze(registered));
  notifyChanged();
}

export function unregisterElementPickerProviders(pluginId: string): void {
  if (PLUGIN_ELEMENT_PICKER_PROVIDERS.delete(pluginId)) notifyChanged();
}

/** Providers a project's pages may use: installed plugins' everywhere, a project plugin's in its own project. */
export function listElementPickerProviders(
  projectId: string | null
): RegisteredElementPickerProvider[] {
  const visible: RegisteredElementPickerProvider[] = [];
  for (const providers of PLUGIN_ELEMENT_PICKER_PROVIDERS.values()) {
    for (const provider of providers) {
      if (provider.projectId === null || provider.projectId === projectId) visible.push(provider);
    }
  }
  return visible;
}

export function getElementPickerProvider(
  id: string,
  projectId: string | null
): RegisteredElementPickerProvider | undefined {
  return listElementPickerProviders(projectId).find((provider) => provider.id === id);
}

/**
 * Whether page or request data may name `id` in `projectId`: a core framework,
 * or a registered provider visible to that project. A well-formed id that
 * isn't registered (never installed, disabled, another project's) is refused.
 */
export function isElementPickerProviderAuthorized(id: string, projectId: string | null): boolean {
  return isCoreFramework(id) || getElementPickerProvider(id, projectId) !== undefined;
}

/** The installed plugin directory a registered provider's assets resolve from, or undefined for one registered without it. */
export function getElementPickerProviderPluginDir(
  provider: RegisteredElementPickerProvider
): string | undefined {
  return PROVIDER_PLUGIN_DIRS.get(provider);
}

/** Whether `provider` is still the live registration (not unloaded, disabled or replaced by a reload). */
export function isElementPickerProviderCurrent(provider: RegisteredElementPickerProvider): boolean {
  return PLUGIN_ELEMENT_PICKER_PROVIDERS.get(provider.pluginId)?.includes(provider) === true;
}

export interface ObservedMarker {
  kind: ElementPickerDetectionRule["kind"];
  name: string;
}

function ruleMatches(rule: ElementPickerDetectionRule, marker: ObservedMarker): boolean {
  if (rule.kind !== marker.kind) return false;
  return rule.match === "exact" ? marker.name === rule.name : marker.name.startsWith(rule.name);
}

/**
 * Every provider with a rule matching an observed marker, in registration
 * order. A page may match several (a mixed page); declarations are compared as
 * data, so nothing a plugin shipped runs.
 */
export function matchElementPickerProviders(
  markers: readonly ObservedMarker[],
  projectId: string | null
): RegisteredElementPickerProvider[] {
  return listElementPickerProviders(projectId).filter((provider) =>
    provider.detection.some((rule) => markers.some((marker) => ruleMatches(rule, marker)))
  );
}
