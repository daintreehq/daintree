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
 *
 * The scanner tracks comments and regular-expression literals as well as
 * strings, because it must not merely be approximate — it must not DESYNCHRONISE.
 * A quote inside a regex (`.replace(/"/g, …)`) or an apostrophe in a comment
 * would otherwise be read as opening a string, and every real string after it
 * inverts: openers become closers, and the classes inside them vanish from the
 * pass. In a minified single-line bundle that is most of the file.
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
 * Words after which a `/` begins a regular expression rather than division.
 * The rest of the decision is made from the previous significant character.
 */
const REGEX_PRECEDING_KEYWORDS = new Set([
  "return",
  "typeof",
  "instanceof",
  "in",
  "of",
  "new",
  "delete",
  "void",
  "case",
  "do",
  "else",
  "yield",
  "await",
]);

/** Characters after which a `/` begins a regular expression. */
const REGEX_PRECEDING_PUNCTUATION = new Set([
  "",
  "(",
  ",",
  "=",
  ":",
  "[",
  "!",
  "&",
  "|",
  "?",
  "{",
  "}",
  ";",
  "+",
  "-",
  "*",
  "%",
  "^",
  "~",
  "<",
  ">",
]);

/** What the scanner is currently inside. */
type Frame =
  | { readonly kind: "code" }
  | { readonly kind: "template" }
  | { kind: "expression"; braceDepth: number };

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

  // An explicit stack, not recursion. Template literals nest without bound in
  // valid JavaScript (`` `${`${…}`}` ``), and a recursive scanner over a 4 MB
  // source both overflows the stack and rescans each parent expression — a
  // synchronous stall on the mount path, for a pass that is only an optimisation.
  const stack: Frame[] = [{ kind: "code" }];
  /** Last non-whitespace, non-comment character, for the regex/division call. */
  let previousSignificant = "";
  let index = 0;

  const collect = (start: number, end: number): boolean => {
    for (const token of splitCandidates(source.slice(start, end))) {
      if (candidates.size >= MAX_CANDIDATES) return false;
      candidates.add(token);
    }
    return true;
  };

  while (index < source.length) {
    const frame = stack[stack.length - 1]!;
    const char = source[index]!;

    if (frame.kind === "template") {
      if (char === "\\") {
        index += 2;
        continue;
      }
      if (char === "`") {
        stack.pop();
        previousSignificant = "`";
        index++;
        continue;
      }
      if (char === "$" && source[index + 1] === "{") {
        stack.push({ kind: "expression", braceDepth: 0 });
        previousSignificant = "{";
        index += 2;
        continue;
      }
      // Static run of the template, up to the next boundary.
      const start = index;
      while (index < source.length) {
        const c = source[index]!;
        if (c === "\\") {
          index += 2;
          continue;
        }
        if (c === "`" || (c === "$" && source[index + 1] === "{")) break;
        index++;
      }
      if (!collect(start, Math.min(index, source.length))) break;
      continue;
    }

    // `code` and `expression` behave identically except that an expression
    // closes on the `}` that balances its opening `${`.
    if (char === "/" && source[index + 1] === "/") {
      index += 2;
      while (index < source.length && source[index] !== "\n") index++;
      continue;
    }
    if (char === "/" && source[index + 1] === "*") {
      index += 2;
      while (index < source.length && !(source[index] === "*" && source[index + 1] === "/"))
        index++;
      index += 2;
      continue;
    }
    if (char === "/" && startsRegex(source, index, previousSignificant)) {
      index = skipRegex(source, index);
      previousSignificant = "/";
      continue;
    }
    if (char === '"' || char === "'") {
      const literal = skipQuoted(source, index, char);
      if (!collect(index + 1, literal.contentEnd)) break;
      index = literal.next;
      previousSignificant = char;
      continue;
    }
    if (char === "`") {
      stack.push({ kind: "template" });
      index++;
      continue;
    }
    if (frame.kind === "expression") {
      if (char === "{") {
        frame.braceDepth++;
      } else if (char === "}") {
        if (frame.braceDepth === 0) {
          stack.pop();
          previousSignificant = "}";
          index++;
          continue;
        }
        frame.braceDepth--;
      }
    }
    if (!/\s/.test(char)) previousSignificant = char;
    index++;
  }

  return [...candidates];
}

/**
 * Where the literal opening at `openIndex` ends: `contentEnd` is exclusive of
 * the closing quote, `next` is where scanning resumes.
 *
 * A single- or double-quoted literal cannot span a raw newline, so an
 * unterminated one ends at the line break rather than swallowing the rest of the
 * file — a lone apostrophe in prose is far likelier than a real string.
 */
function skipQuoted(
  source: string,
  openIndex: number,
  quote: string
): { contentEnd: number; next: number } {
  let index = openIndex + 1;
  while (index < source.length) {
    const char = source[index]!;
    if (char === "\\") {
      index += 2;
      continue;
    }
    if (char === quote) return { contentEnd: index, next: index + 1 };
    // Unterminated: the content ends at the line break and scanning resumes
    // there, rather than one character short of it.
    if (char === "\n" || char === "\r") return { contentEnd: index, next: index };
    index++;
  }
  return { contentEnd: source.length, next: source.length };
}

/**
 * Whether the `/` at `index` opens a regular expression rather than dividing.
 *
 * The standard heuristic: a regex can only appear where a value is expected, so
 * the previous significant character decides it. Getting this wrong in the
 * conservative direction (reading a regex as division) merely risks a
 * desynchronised quote; the point is to catch the common `/"/` and `/'/` forms.
 */
function startsRegex(source: string, index: number, previousSignificant: string): boolean {
  if (REGEX_PRECEDING_PUNCTUATION.has(previousSignificant)) return true;
  if (!/[A-Za-z0-9_$]/.test(previousSignificant)) return false;
  // An identifier before `/` is division (`total / count`) unless the identifier
  // is a keyword after which a value is expected (`return /".."/`).
  let end = index - 1;
  while (end >= 0 && /\s/.test(source[end]!)) end--;
  let start = end;
  while (start >= 0 && /[A-Za-z0-9_$]/.test(source[start]!)) start--;
  return REGEX_PRECEDING_KEYWORDS.has(source.slice(start + 1, end + 1));
}

/** Index just past the closing `/` of the regex literal opening at `openIndex`. */
function skipRegex(source: string, openIndex: number): number {
  let index = openIndex + 1;
  let inClass = false;
  while (index < source.length) {
    const char = source[index]!;
    if (char === "\\") {
      index += 2;
      continue;
    }
    if (char === "\n" || char === "\r") return index;
    if (char === "[") inClass = true;
    else if (char === "]") inClass = false;
    else if (char === "/" && !inClass) {
      index++;
      // Flags.
      while (index < source.length && /[a-z]/i.test(source[index]!)) index++;
      return index;
    }
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
