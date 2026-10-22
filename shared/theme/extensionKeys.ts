import { EXTENSION_KEYS, type ExtensionKey } from "./types.js";

const EXTENSION_KEY_SET: ReadonlySet<string> = new Set(EXTENSION_KEYS);

export function isExtensionKey(key: string): key is ExtensionKey {
  return EXTENSION_KEY_SET.has(key);
}

/**
 * Keeps only registered extension keys with string values. Extensions are
 * emitted as bare `--<key>` variables, so an unregistered key could name a
 * `--theme-*` token or an engine variable and replace a value the contrast
 * gate already checked. Every key in the registry is component-scoped, which
 * makes shadowing impossible once the map is filtered here.
 */
export function sanitizeThemeExtensions(
  extensions: Readonly<Record<string, unknown>> | null | undefined
): Partial<Record<ExtensionKey, string>> {
  const sanitized: Partial<Record<ExtensionKey, string>> = {};
  if (!extensions || typeof extensions !== "object") return sanitized;
  for (const [key, value] of Object.entries(extensions)) {
    if (typeof value === "string" && isExtensionKey(key)) sanitized[key] = value;
  }
  return sanitized;
}
