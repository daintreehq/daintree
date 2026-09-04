/**
 * Pulls Tailwind candidate classes out of plugin view source text.
 *
 * This is the speculative half of candidate discovery. It runs once, before the
 * view module is imported, so the first paint of a plugin panel is already
 * styled — including anything a `useLayoutEffect` measures, which runs before
 * the DOM observer's microtask gets a turn. The observer in `pluginStyleRuntime`
 * is the authoritative source; this pass only buys the first frame, so it is
 * allowed to be approximate in both directions. Over-collecting costs a little
 * compile time and nothing else (Tailwind drops non-utilities silently);
 * under-collecting is corrected by the observer before the class matters.
 *
 * Tailwind's real extractor is the Rust scanner in `@tailwindcss/oxide`, which
 * cannot run in the renderer. Rather than approximate a byte scanner over
 * arbitrary JavaScript — where every identifier (`useState`, `className`) is a
 * syntactically valid candidate — this reads only string-literal contents.
 * Class names essentially always live in a quoted string, and restricting to
 * them removes the identifier noise that would otherwise dominate the candidate
 * set. It is also exactly the rule the plugin docs give authors: a conditional
 * class must be a complete string, never a concatenated fragment.
 */

/** Source larger than this is not tokenised; the DOM observer still covers it. */
export const MAX_SOURCE_BYTES = 4 * 1024 * 1024;

/** Longest plausible utility. Beyond this it is a data URI or minified blob. */
export const MAX_TOKEN_LENGTH = 128;

/** Ceiling on one source pass, so a pathological bundle cannot stall a mount. */
export const MAX_CANDIDATES = 8192;

/**
 * Characters a Tailwind candidate may contain outside an arbitrary-value
 * bracket: identifier characters plus variant (`:`), opacity (`/`), decimal
 * (`.`), important (`!`), container-query (`@`), wildcard (`*`), percentage,
 * and the `(...)` of v4's CSS-variable shorthand (`bg-(--my-token)`).
 */
const CANDIDATE_CHARACTER = /[A-Za-z0-9_\-:./!@*%()#]/;

/**
 * A token has to start like a utility. Excludes bare numbers and punctuation
 * runs without excluding variants (`hover:`), negatives (`-mt-1`), important
 * (`!p-4`), container queries (`@sm:flex`) or arbitrary variants (`[&>*]:p-0`).
 */
const CANDIDATE_START = /^[A-Za-z@\-!['*]/;

/**
 * Extract every candidate-shaped token from plugin source text.
 *
 * Returns a de-duplicated array in first-seen order. Order is not significant to
 * the compiler — Tailwind sorts its own output — but stability keeps the
 * diagnostics report readable and the tests deterministic.
 */
export function tokenizePluginSource(source: string): string[] {
  const candidates = new Set<string>();
  if (source.length === 0 || source.length > MAX_SOURCE_BYTES) return [];

  for (const literal of stringLiteralContents(source)) {
    for (const token of splitCandidates(literal)) {
      if (candidates.size >= MAX_CANDIDATES) return [...candidates];
      candidates.add(token);
    }
  }
  return [...candidates];
}

/**
 * Contents of every string literal in `source`.
 *
 * A deliberately forgiving scanner, not a JavaScript parser: it recognises the
 * three quote forms and backslash escapes, and treats `${` inside a template as
 * a boundary so an interpolated expression is never mistaken for class text. It
 * does not track comments or regex literals — a class-looking token harvested
 * from a comment is harmless, and the alternative is parsing the language.
 */
function* stringLiteralContents(source: string): Generator<string> {
  let index = 0;

  while (index < source.length) {
    const quote = source[index];
    if (quote !== '"' && quote !== "'" && quote !== "`") {
      index++;
      continue;
    }

    index++;
    let start = index;
    let closed = false;

    while (index < source.length) {
      const char = source[index];

      if (char === "\\") {
        index += 2;
        continue;
      }
      if (char === quote) {
        yield source.slice(start, index);
        index++;
        closed = true;
        break;
      }
      // A non-template literal never spans a newline; an unterminated quote is
      // far more likely a lone apostrophe in prose than a real string, so end
      // the literal at the line break rather than swallowing the rest of the file.
      if (quote !== "`" && (char === "\n" || char === "\r")) {
        yield source.slice(start, index);
        closed = true;
        break;
      }
      // `${expr}` is not class text itself, but it very often CONTAINS class
      // text — `${active ? "bg-surface-active" : ""}` is the ordinary way to
      // write a conditional class. So yield the static run before it, then
      // scan the expression for its own string literals rather than skipping
      // it, and resume after the matching brace. Recursing handles nesting
      // (a template inside a template) for free.
      if (quote === "`" && char === "$" && source[index + 1] === "{") {
        yield source.slice(start, index);
        const expressionStart = index + 2;
        index = skipInterpolation(source, expressionStart);
        // `index` sits past the closing brace; the expression is what precedes it.
        yield* stringLiteralContents(
          source.slice(expressionStart, Math.max(expressionStart, index - 1))
        );
        start = index;
        continue;
      }
      index++;
    }

    if (!closed && start < source.length) yield source.slice(start);
  }
}

/** Index just past the `}` closing an interpolation opened at `index`. */
function skipInterpolation(source: string, index: number): number {
  let depth = 1;
  while (index < source.length && depth > 0) {
    const char = source[index];
    if (char === "{") depth++;
    else if (char === "}") depth--;
    index++;
  }
  return index;
}

/**
 * Split one string literal into candidate tokens.
 *
 * Splits on any character a candidate cannot contain, except inside `[...]`,
 * where an arbitrary value may hold spaces, commas and quotes
 * (`grid-cols-[1fr_auto]`, `shadow-[0_1px_2px_rgb(0,0,0,.1)]`). Bracket depth is
 * counted rather than matched with a regex, which is the one part of oxide's
 * behaviour that genuinely cannot be approximated by splitting on whitespace.
 */
function* splitCandidates(literal: string): Generator<string> {
  let token = "";
  let bracketDepth = 0;

  const flush = function* (): Generator<string> {
    if (token.length > 0 && token.length <= MAX_TOKEN_LENGTH && CANDIDATE_START.test(token)) {
      yield token;
    }
    token = "";
  };

  for (const char of literal) {
    if (char === "[") {
      bracketDepth++;
      token += char;
      continue;
    }
    if (char === "]") {
      bracketDepth = Math.max(0, bracketDepth - 1);
      token += char;
      continue;
    }
    if (bracketDepth > 0) {
      token += char;
      continue;
    }
    if (CANDIDATE_CHARACTER.test(char)) {
      token += char;
      continue;
    }
    yield* flush();
  }
  yield* flush();
}
