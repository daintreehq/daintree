import type { ElementPickerProviderId } from "./source.js";

/** What a declared marker is looked for on: a page global, an expando on a node, an attribute, or a tag name. */
export const ELEMENT_PICKER_DETECTION_KINDS = ["global", "expando", "attribute", "tag"] as const;
export type ElementPickerDetectionKind = (typeof ELEMENT_PICKER_DETECTION_KINDS)[number];

/**
 * Declarations are data, never code: a plugin names markers and how to compare
 * them, so the host can detect a framework without loading the plugin or
 * running anything it supplied.
 */
export const ELEMENT_PICKER_PROVIDER_LIMITS = {
  rulesPerProvider: 16,
  markerNameLength: 128,
  entryPathLength: 256,
} as const;

export interface ElementPickerDetectionRule {
  kind: ElementPickerDetectionKind;
  name: string;
  /** `prefix` matches names that start with `name`; `exact` only `name`. */
  match: "exact" | "prefix";
}

/** The `contributes.elementPickerProviders` entry. `id` is local; the registry namespaces it with the plugin name. */
export interface ElementPickerProviderContribution {
  id: string;
  name: string;
  /** Any rule matching is a detection. */
  detection: ElementPickerDetectionRule[];
  /** Packaged, plugin-relative path to the guest extractor. Declared only: nothing loads it yet. */
  guestEntry: string;
  /** Packaged path to the source resolver. Declaring one needs `fs:project-read`. */
  resolverEntry?: string;
}

/** A registered declaration, as host code reads it. */
export interface RegisteredElementPickerProvider {
  /** `{pluginName}.{contributionId}`, the id pages and requests name. */
  id: ElementPickerProviderId;
  pluginId: string;
  pluginName: string;
  /** Null for an installed plugin, visible in every project. */
  projectId: string | null;
  name: string;
  detection: readonly ElementPickerDetectionRule[];
  guestEntry: string;
  resolverEntry?: string;
}

export function makeElementPickerProviderId(pluginName: string, contributionId: string): string {
  return `${pluginName}.${contributionId}`;
}
