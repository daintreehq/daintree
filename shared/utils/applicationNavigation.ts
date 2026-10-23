import {
  PLUGIN_APPLICATION_NAVIGATION_LIMITS as LIMITS,
  type PluginApplicationNavigation,
  type PluginApplicationNavigationParam,
  type PluginNavigationLocation,
  type PluginNavigationParamValue,
} from "../types/plugin.js";

/** What a string parameter may hold: the manifest's own id vocabulary, so no free text. */
export const NAVIGATION_STRING_VALUE_PATTERN = /^[a-zA-Z0-9._-]+$/;

const RESERVED_PARAM_NAMES: ReadonlySet<string> = new Set([
  "__proto__",
  "constructor",
  "prototype",
]);

/** A name that would read or write an object's prototype machinery rather than a key of its own. */
export function isReservedNavigationParamName(name: string): boolean {
  return RESERVED_PARAM_NAMES.has(name);
}

export type NavigationLocationDecode =
  | { ok: true; location: PluginNavigationLocation }
  | { ok: false; reason: "unknown-section" | "invalid-params" | "too-large" };

/** One project's history: every entry already resolved against the declaration. */
export interface NavigationHistory {
  readonly entries: readonly PluginNavigationLocation[];
  readonly index: number;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function admitsValue(declared: PluginApplicationNavigationParam, value: unknown): boolean {
  switch (declared.type) {
    case "string":
      return (
        typeof value === "string" &&
        value.length > 0 &&
        value.length <= (declared.maxLength ?? LIMITS.defaultStringLength) &&
        NAVIGATION_STRING_VALUE_PATTERN.test(value)
      );
    case "integer":
      return typeof value === "number" && Number.isSafeInteger(value);
    case "boolean":
      return typeof value === "boolean";
    default:
      return false;
  }
}

function serializedBytes(location: PluginNavigationLocation): number {
  return new TextEncoder().encode(JSON.stringify(location)).length;
}

/**
 * Admit a location against the application's declaration (#14108): the one
 * check every write goes through — an intent, a restore, a history step.
 *
 * Only declared parameters of their declared type survive, so nothing beyond
 * what the manifest names can ride the location onto disk. The result is a
 * detached, frozen object with its parameters in a stable order, so two equal
 * locations serialize the same. A parameter set to `undefined` is absent.
 */
export function decodeNavigationLocation(
  navigation: PluginApplicationNavigation,
  sectionId: unknown,
  params: unknown
): NavigationLocationDecode {
  const section = navigation.sections.find((entry) => entry.id === sectionId);
  if (section === undefined) return { ok: false, reason: "unknown-section" };
  if (params !== undefined && !isPlainRecord(params))
    return { ok: false, reason: "invalid-params" };
  const declared = section.params ?? {};
  const admitted: Record<string, PluginNavigationParamValue> = {};
  const names = params === undefined ? [] : Object.keys(params).sort();
  for (const name of names) {
    const value = params?.[name];
    if (value === undefined) continue;
    if (isReservedNavigationParamName(name) || !Object.hasOwn(declared, name)) {
      return { ok: false, reason: "invalid-params" };
    }
    const declaration = declared[name];
    if (declaration === undefined || !admitsValue(declaration, value)) {
      return { ok: false, reason: "invalid-params" };
    }
    admitted[name] = value as PluginNavigationParamValue;
  }
  for (const [name, declaration] of Object.entries(declared)) {
    if (declaration.required === true && !Object.hasOwn(admitted, name)) {
      return { ok: false, reason: "invalid-params" };
    }
  }
  const location: PluginNavigationLocation = Object.freeze({
    sectionId: section.id,
    params: Object.freeze(admitted),
  });
  // The declaration's own bounds keep a location under this; the check holds
  // the line if those are ever widened.
  if (serializedBytes(location) > LIMITS.maxLocationBytes)
    return { ok: false, reason: "too-large" };
  return { ok: true, location };
}

/** The declared default section, with no parameters: the schema keeps it from requiring any. */
export function defaultNavigationLocation(
  navigation: PluginApplicationNavigation
): PluginNavigationLocation {
  return Object.freeze({ sectionId: navigation.defaultSectionId, params: Object.freeze({}) });
}

export function navigationLocationsEqual(
  left: PluginNavigationLocation,
  right: PluginNavigationLocation
): boolean {
  if (left === right) return true;
  if (left.sectionId !== right.sectionId) return false;
  const leftNames = Object.keys(left.params);
  if (leftNames.length !== Object.keys(right.params).length) return false;
  return leftNames.every(
    (name) => Object.hasOwn(right.params, name) && right.params[name] === left.params[name]
  );
}

/** Whether a stored entry is already exactly the frozen location it decodes to, and nothing more. */
function isSameLocation(
  entry: Record<string, unknown>,
  location: PluginNavigationLocation
): entry is Record<string, unknown> & PluginNavigationLocation {
  // Only a frozen entry — one this module made — is handed out again: a view
  // holding a mutable one could rewrite the host's history through it.
  return (
    Object.isFrozen(entry) &&
    Object.isFrozen(entry.params) &&
    Object.keys(entry).length === 2 &&
    isPlainRecord(entry.params) &&
    navigationLocationsEqual(entry as unknown as PluginNavigationLocation, location)
  );
}

/** Drop adjacent repeats, keeping the cursor on the entry it was on. */
function collapse(entries: readonly PluginNavigationLocation[], index: number): NavigationHistory {
  const kept: PluginNavigationLocation[] = [];
  let cursor = 0;
  entries.forEach((entry, position) => {
    const previous = kept[kept.length - 1];
    if (previous === undefined || !navigationLocationsEqual(previous, entry)) kept.push(entry);
    if (position === index) cursor = kept.length - 1;
  });
  return { entries: kept, index: cursor };
}

/**
 * Hold the history to its cap without losing the current entry: the oldest
 * back entries go first, then the most distant forward ones.
 */
function trim(history: NavigationHistory): NavigationHistory {
  let entries = [...history.entries];
  let index = history.index;
  while (entries.length > LIMITS.maxHistoryEntries) {
    if (index > 0) {
      entries = entries.slice(1);
      index -= 1;
    } else {
      entries = entries.slice(0, -1);
    }
  }
  return { entries, index };
}

/**
 * Rebuild a history from what was stored, against the declaration as it is
 * now. An entry that no longer resolves is dropped; the current one, if it no
 * longer resolves, becomes the default section, so a restore always lands
 * somewhere the application declares. An entry that resolves unchanged keeps
 * its identity, so re-reading an unchanged history hands views the same
 * location object.
 */
export function restoreNavigationHistory(
  navigation: PluginApplicationNavigation,
  entries: unknown,
  index: unknown
): NavigationHistory {
  const stored = Array.isArray(entries) ? entries : [];
  const cursor =
    typeof index === "number" && Number.isSafeInteger(index) && index >= 0 && index < stored.length
      ? index
      : stored.length - 1;
  const resolved: PluginNavigationLocation[] = [];
  let resolvedCursor = -1;
  stored.forEach((entry: unknown, position) => {
    const record = isPlainRecord(entry) ? entry : {};
    const decoded = decodeNavigationLocation(navigation, record.sectionId, record.params);
    if (decoded.ok) {
      resolved.push(isSameLocation(record, decoded.location) ? record : decoded.location);
    } else if (position === cursor) {
      resolved.push(defaultNavigationLocation(navigation));
    } else {
      return;
    }
    if (position === cursor) resolvedCursor = resolved.length - 1;
  });
  if (resolved.length === 0 || resolvedCursor < 0) {
    return { entries: [defaultNavigationLocation(navigation)], index: 0 };
  }
  return trim(collapse(resolved, resolvedCursor));
}

/**
 * Move to `location`. Going somewhere new drops the forward entries, as a
 * browser does; `replace` swaps the current entry instead. Returns the same
 * history object when nothing would change, so the caller can tell a no-op.
 */
export function pushNavigationHistory(
  history: NavigationHistory,
  location: PluginNavigationLocation,
  replace: boolean
): NavigationHistory {
  const current = history.entries[history.index];
  if (current !== undefined && navigationLocationsEqual(current, location)) return history;
  if (replace) {
    const entries = [...history.entries];
    entries[history.index] = location;
    return trim(collapse(entries, history.index));
  }
  const entries = [...history.entries.slice(0, history.index + 1), location];
  return trim({ entries, index: entries.length - 1 });
}

/**
 * The part of a history that may be written to disk: each entry keeps only
 * the parameters its section marks `persist`. One that then lacks a required
 * parameter can't be restored as it was, so it becomes the default section.
 */
export function persistableNavigationHistory(
  navigation: PluginApplicationNavigation,
  history: NavigationHistory
): NavigationHistory {
  const entries = history.entries.map((entry) => {
    const declared = navigation.sections.find((section) => section.id === entry.sectionId)?.params;
    const kept: Record<string, PluginNavigationParamValue> = {};
    for (const [name, value] of Object.entries(entry.params)) {
      if (declared?.[name]?.persist === true) kept[name] = value;
    }
    const decoded = decodeNavigationLocation(navigation, entry.sectionId, kept);
    return decoded.ok ? decoded.location : defaultNavigationLocation(navigation);
  });
  return collapse(entries, history.index);
}
