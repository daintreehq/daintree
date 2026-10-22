import { EXTENSION_KEYS, type ExtensionKey } from "./types.js";

const EXTENSION_KEY_SET: ReadonlySet<string> = new Set(EXTENSION_KEYS);

export function isExtensionKey(key: string): key is ExtensionKey {
  return EXTENSION_KEY_SET.has(key);
}

/**
 * Whether `value` is a single CSS declaration value: no top-level `;` or `!`,
 * no braces or comments, balanced brackets and closed strings. The skeleton
 * writes theme values into stylesheet text, where a value failing this could
 * end its declaration and start another (say, a `--theme-*` token marked
 * `!important`) or close the rule and open one of its own.
 */
export function isCssDeclarationValue(value: string): boolean {
  const closers: string[] = [];
  let quote: string | null = null;
  for (let i = 0; i < value.length; i++) {
    const char = value[i]!;
    if (char === "\n" || char === "\r" || char === "\f") return false;
    if (char === "\\") {
      // A trailing backslash would escape the `;` the serializer appends.
      if (i === value.length - 1) return false;
      i++;
      continue;
    }
    if (quote) {
      if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
    } else if (char === "/" && value[i + 1] === "*") {
      return false;
    } else if (char === "(" || char === "[") {
      closers.push(char === "(" ? ")" : "]");
    } else if (char === ")" || char === "]") {
      if (closers.pop() !== char) return false;
    } else if (char === "{" || char === "}") {
      return false;
    } else if ((char === ";" || char === "!") && closers.length === 0) {
      return false;
    }
  }
  return quote === null && closers.length === 0;
}

/**
 * Keeps only registered extension keys whose values are single CSS
 * declaration values. Extensions are emitted as bare `--<key>` variables, so
 * an unregistered key could name a `--theme-*` token or an engine variable and
 * replace a value the contrast gate already checked. Every key in the registry
 * is component-scoped, which makes shadowing impossible once the map is
 * filtered here.
 */
export function sanitizeThemeExtensions(
  extensions: Readonly<Record<string, unknown>> | null | undefined
): Partial<Record<ExtensionKey, string>> {
  const sanitized: Partial<Record<ExtensionKey, string>> = {};
  if (!extensions || typeof extensions !== "object") return sanitized;
  for (const [key, value] of Object.entries(extensions)) {
    if (typeof value === "string" && isExtensionKey(key) && isCssDeclarationValue(value)) {
      sanitized[key] = value;
    }
  }
  return sanitized;
}
