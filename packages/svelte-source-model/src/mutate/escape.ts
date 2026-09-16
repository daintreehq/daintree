/**
 * Escaping between plain text and Svelte source.
 *
 * Every value that reaches these functions is plain text from a user — a
 * heading they typed, an alt attribute, a class token. It is never markup, and
 * it is never a browser `innerHTML` read: round-tripping rendered HTML back
 * into source is how `&nbsp;` and normalised attribute quoting leak into a file
 * the user never edited.
 *
 * Svelte's text grammar adds `{` to HTML's list of dangerous characters,
 * because a brace opens an expression. `}` is legal on its own, but escaping it
 * too keeps a pasted `{"a": 1}` from depending on which half the parser saw
 * first.
 */

/**
 * Case-sensitive, because HTML's named references are: `&AMP;` is the ampersand
 * and `&Amp;` is five literal characters. Folding case here would let "remove
 * the token `&`" delete a class actually spelled `&Amp;`.
 */
const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  AMP: "&",
  lt: "<",
  LT: "<",
  gt: ">",
  GT: ">",
  quot: '"',
  QUOT: '"',
  apos: "'",
  nbsp: "\u00a0",
  lbrace: "{",
  rbrace: "}",
  Tab: "\t",
  NewLine: "\n",
};

/** Escapes plain text for a markup text node. */
export function escapeTextContent(text: string): string {
  return text.replace(/[&<>{}]/g, (char) => {
    switch (char) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case "{":
        return "&#123;";
      default:
        return "&#125;";
    }
  });
}

export type QuoteStyle = '"' | "'";

/**
 * Escapes plain text for an attribute value delimited by `quote`.
 *
 * Only the delimiter in use is escaped, so `class="[&>*]:p-2"` keeps its angle
 * bracket and a `title='it"s'` keeps its double quote — the alternative is a
 * diff full of entities on characters that were never ambiguous.
 */
export function escapeAttributeValue(value: string, quote: QuoteStyle): string {
  let out = "";
  for (const char of value) {
    if (char === "&") out += "&amp;";
    else if (char === "{") out += "&#123;";
    else if (char === "}") out += "&#125;";
    else if (char === quote) out += quote === '"' ? "&quot;" : "&#39;";
    else out += char;
  }
  return out;
}

/**
 * Decodes the entity subset this package emits, plus the handful a hand-written
 * file is likely to carry.
 *
 * Used for comparison only — to decide whether the token `[&>*]:p-2` is already
 * present in a value that spells it `[&amp;>*]:p-2`. Source bytes that survive
 * an edit are never round-tripped through this; they are copied verbatim.
 */
export function decodeEntities(raw: string): string {
  return raw.replace(/&(#[xX][0-9a-fA-F]+|#\d+|[a-zA-Z][a-zA-Z0-9]*);/g, (match, body: string) => {
    if (body.startsWith("#x") || body.startsWith("#X")) {
      const code = Number.parseInt(body.slice(2), 16);
      return Number.isFinite(code) && code >= 0 && code <= 0x10ffff
        ? String.fromCodePoint(code)
        : match;
    }
    if (body.startsWith("#")) {
      const code = Number.parseInt(body.slice(1), 10);
      return Number.isFinite(code) && code >= 0 && code <= 0x10ffff
        ? String.fromCodePoint(code)
        : match;
    }
    return NAMED_ENTITIES[body] ?? match;
  });
}

/**
 * Rewrites the line endings in `text` to whichever style `source` already uses.
 *
 * A value arriving from a browser input carries whatever the platform produced.
 * Writing a lone LF into a CRLF file is a one-line change that shows up as a
 * mixed-ending file in the next diff, and every offset after it shifts by one
 * against what the parser last reported.
 */
export function normaliseLineEndings(text: string, source: string): string {
  const normalised = text.replace(/\r\n?/g, "\n");
  return dominantLineEnding(source) === "\r\n" ? normalised.replace(/\n/g, "\r\n") : normalised;
}

function dominantLineEnding(source: string): "\r\n" | "\n" {
  const crlf = (source.match(/\r\n/g) ?? []).length;
  const lf = (source.match(/\n/g) ?? []).length;
  return crlf > 0 && crlf * 2 >= lf ? "\r\n" : "\n";
}

/**
 * True when `value` contains a character no source position can carry.
 *
 * Tab, LF and CR are real content in a `.svelte` file; the rest of C0 and DEL
 * are not, and a NUL that reaches disk is a file no editor will open cleanly.
 */
export function hasUnwritableCharacter(value: string): boolean {
  if (hasLoneSurrogate(value)) return true;
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code === 0x09 || code === 0x0a || code === 0x0d) continue;
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

/**
 * ASCII whitespace, which is the only whitespace HTML splits a space-separated
 * token list on. JavaScript's `\s` also matches NBSP and the Unicode spaces, so
 * using it here would read the single class `a\u00a0b` as the two classes `a`
 * and `b` and happily delete half of it.
 */
export const ASCII_WHITESPACE = /[ \t\n\f\r]/;

/**
 * True when `value` contains half a surrogate pair.
 *
 * Svelte's parser accepts one, so a candidate built from it verifies — and then
 * the UTF-8 encode on the way to disk replaces it with U+FFFD and the file no
 * longer says what the plan said it would. Inside a JavaScript string literal
 * `JSON.stringify` escapes it and it survives, which is why this is checked at
 * the markup writers rather than globally.
 */
export function hasLoneSurrogate(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(i + 1);
      if (Number.isNaN(next) || next < 0xdc00 || next > 0xdfff) return true;
      i++;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}
