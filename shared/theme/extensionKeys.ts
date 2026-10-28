import { EXTENSION_KEYS, type ExtensionKey } from "./types.js";

const EXTENSION_KEY_SET: ReadonlySet<string> = new Set(EXTENSION_KEYS);

export function isExtensionKey(key: string): key is ExtensionKey {
  return EXTENSION_KEY_SET.has(key);
}

/**
 * Whether `value` is a single CSS declaration value: no top-level `;` or `!`,
 * no braces or comments, balanced brackets, closed strings and well-formed
 * `url()` tokens. The skeleton writes theme values into stylesheet text, where
 * a value failing this could end its declaration and start another (say, a
 * `--theme-*` token marked `!important`) or close the rule and open its own.
 *
 * It tokenizes the way CSS does where that matters: an unquoted `url(` runs to
 * the first `)` whatever quotes it holds, so a quote inside one is rejected
 * rather than read as a string. Backslashes are rejected outside strings,
 * since an escape can spell `url` and no theme value needs one there.
 */
export function isCssDeclarationValue(value: string): boolean {
  const closers: string[] = [];
  let quote: string | null = null;
  for (let i = 0; i < value.length; i++) {
    const char = value[i]!;
    if (char === "\n" || char === "\r" || char === "\f") return false;
    if (quote) {
      if (char === "\\") i++;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
    } else if (char === "\\") {
      return false;
    } else if (char === "/" && value[i + 1] === "*") {
      return false;
    } else if (char === "(" && isUrlFunction(value, i)) {
      const end = unquotedUrlEnd(value, i + 1);
      if (end === -1) return false;
      if (end > i) i = end;
      else closers.push(")");
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

// Characters that fold a following `url` into a longer token: name characters
// make it part of an ident or dimension, `#` a hash and `@` an at-keyword.
const URL_PREFIX_JOINER = /[\w\u0080-\uffff#@-]/;

/** Whether the `(` at `open` follows the bare ident `url`, which CSS tokenizes as a URL. */
function isUrlFunction(value: string, open: number): boolean {
  if (open < 3 || value.slice(open - 3, open).toLowerCase() !== "url") return false;
  return open === 3 || !URL_PREFIX_JOINER.test(value[open - 4]!);
}

/**
 * For a `url(` whose argument starts at `start`: the index of the `)` closing
 * an unquoted URL, `start - 1` when the argument is a quoted string (an
 * ordinary function), or -1 when the URL is malformed, which CSS would turn
 * into a bad-url token that swallows text up to the next `)`.
 */
function unquotedUrlEnd(value: string, start: number): number {
  let i = start;
  while (value[i] === " " || value[i] === "\t") i++;
  if (value[i] === '"' || value[i] === "'") return start - 1;
  for (; i < value.length; i++) {
    const char = value[i]!;
    if (char === ")") return i;
    if (char === " " || char === "\t") {
      while (value[i + 1] === " " || value[i + 1] === "\t") i++;
      return value[i + 1] === ")" ? i + 1 : -1;
    }
    if (char === '"' || char === "'" || char === "(" || char === "\\") return -1;
    const code = char.charCodeAt(0);
    if (code < 0x20 || code === 0x7f) return -1;
  }
  return -1;
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
