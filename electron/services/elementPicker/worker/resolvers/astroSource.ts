/**
 * Whether an `.astro` file holds what `data-astro-source-loc` claims. The
 * compiler does not mark an element's opening tag: it marks the start of the
 * element's first child (just past the `>` for text, an expression or a
 * fragment; the child's name for an element; inside the `<!--` for a comment)
 * and the element's own name only when it has no children or is a custom
 * element. So a claim holds when an opening tag of the element's name sits
 * where that rule would put this position, exactly: nothing is skipped to make
 * it fit.
 *
 * This is not a parser. One forward pass over the file's markup (its
 * `Lexicon`) marks what is not markup: comments, the content of scripts,
 * styles, textareas, titles and `is:raw` elements, quoted attribute values,
 * and `{…}` expressions. Then the opening tags the rule allows at fixed offsets from the
 * position are read forward, aware of quotes and braces, and one counts only
 * where the compiler stamps one: in markup, never `<html>`, `<head>` and the
 * like, and never a component. Markup-shaped text inside a JavaScript
 * expression reads the same as markup, so a tag in an attribute's expression,
 * or one just after a quote, is `inconclusive`, as is a tag past where the
 * pass had to stop, a byte-order mark under a first-line position, frontmatter
 * that never closes, or a name that matches only when case is ignored. The
 * pass does not look inside expressions, and frontmatter ends at the first
 * line that starts with `---`, even one inside a string there.
 *
 * `verified` therefore says the file at this revision has an element of this
 * name stamped at this position. It cannot say the selected element is that
 * one: an attribute is the page's to write.
 */

export type AnchorCheck = "verified" | "mismatch" | "inconclusive";

/** A span of an opening tag's attributes, `[from, to)`: quoted values are text, braced ones expressions. */
interface Value {
  from: number;
  to: number;
  quoted: boolean;
}

interface OpenTag {
  start: number;
  name: string;
  /** Just past the tag's closing `>`. */
  end: number;
  selfClosing: boolean;
  values: Value[];
}

/** A scan that stopped at its bound has shown nothing either way. */
interface Scan {
  bounded: boolean;
}

interface Region {
  from: number;
  to: number;
  kind: "text" | "attribute-expression" | "expression";
}

/** What one forward pass over a file's markup found that is not markup. Reusable for every check in the file. */
export interface Lexicon {
  /** Where the markup begins, past any frontmatter; null when the frontmatter never closes. */
  markupStart: number | null;
  /** In order, never overlapping. */
  regions: Region[];
  /** Where the pass stopped short of the end, or null when it read the whole file. */
  stoppedAt: number | null;
}

const VOID_ELEMENTS: ReadonlySet<string> = new Set([
  "area",
  "base",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "keygen",
  "link",
  "meta",
  "param",
  "source",
  "track",
  "wbr",
]);

/** Elements whose content is text however much it looks like markup. */
const RAW_TEXT_ELEMENTS: ReadonlySet<string> = new Set(["script", "style", "textarea", "title"]);

/** Elements the compiler never stamps (`css_scoping::should_scope_element`, and `html`). */
const NEVER_STAMPED: ReadonlySet<string> = new Set([
  "html",
  "base",
  "font",
  "frame",
  "frameset",
  "head",
  "link",
  "meta",
  "noframes",
  "noscript",
  "script",
  "style",
  "slot",
  "title",
]);

/** Characters one opening tag may span. */
const TAG_SPAN_LIMIT = 64 * 1024;
/** Earlier `<`s tried, nearest first, when the walk back over a tag's values cannot find its start. */
const BACKWARD_TRIES = 16;
/** Characters one `{…}` in markup may span. */
const EXPRESSION_SPAN_LIMIT = 256 * 1024;

const NAME = /[A-Za-z][A-Za-z0-9:._-]*/y;
const WHITESPACE = /\s/;
const QUOTES: ReadonlySet<string | undefined> = new Set(['"', "'", "`"]);

function isLineBreak(char: string | undefined): boolean {
  return char === "\n" || char === "\r";
}

/** Where a 1-based line starts. `\r\n`, `\r` and `\n` each end a line, as the compiler counts them. */
function lineStart(text: string, line: number): number | null {
  let index = 0;
  for (let current = 1; current < line; current += 1) {
    while (index < text.length && !isLineBreak(text[index])) index += 1;
    if (index >= text.length) return null;
    index += text[index] === "\r" && text[index + 1] === "\n" ? 2 : 1;
  }
  return index;
}

/** Past a quoted string or template literal, honouring backslash escapes; -1 if it never closes. */
function skipString(text: string, open: number, limit: number): number {
  const quote = text[open];
  for (let index = open + 1; index < limit; index += 1) {
    const char = text[index];
    if (char === "\\") index += 1;
    else if (char === quote) return index + 1;
  }
  return -1;
}

/**
 * Past a balanced `{…}` expression; -1 if it never closes. With `strings`,
 * braces inside JavaScript strings do not count; without, a quote is just a
 * character, which is what a regex or an apostrophe in JSX text needs.
 */
function skipBraces(text: string, open: number, limit: number, strings: boolean): number {
  let depth = 0;
  for (let index = open; index < limit; index += 1) {
    const char = text[index];
    if (strings && QUOTES.has(char)) {
      const after = skipString(text, index, limit);
      if (after === -1) return -1;
      index = after - 1;
    } else if (char === "{") {
      depth += 1;
    } else if (char === "}") {
      depth -= 1;
      if (depth === 0) return index + 1;
    }
  }
  return -1;
}

function parseOpenTagWith(
  text: string,
  start: number,
  scan: Scan,
  strings: boolean
): OpenTag | null {
  if (start < 0 || text[start] !== "<") return null;
  NAME.lastIndex = start + 1;
  const name = NAME.exec(text)?.[0];
  if (name === undefined) return null;
  let index = start + 1 + name.length;
  const boundary = text[index];
  if (
    boundary === undefined ||
    !(boundary === ">" || boundary === "/" || WHITESPACE.test(boundary))
  ) {
    return null;
  }
  const limit = Math.min(text.length, start + TAG_SPAN_LIMIT);
  const values: Value[] = [];
  while (index < limit) {
    const char = text[index]!;
    if (char === ">") return { start, name, end: index + 1, selfClosing: false, values };
    if (char === "/" && text[index + 1] === ">") {
      return { start, name, end: index + 2, selfClosing: true, values };
    }
    if (char === "<") return null;
    const from = index;
    if (QUOTES.has(char)) {
      index = skipString(text, index, limit);
      if (index !== -1) values.push({ from, to: index, quoted: true });
    } else if (char === "{") {
      index = skipBraces(text, index, limit, strings);
      if (index !== -1) values.push({ from, to: index, quoted: false });
    } else {
      index += 1;
    }
    if (index === -1) break;
  }
  if (limit < text.length) scan.bounded = true;
  return null;
}

/** Read as JavaScript first, then with quotes ignored inside braces, for an expression the first cannot follow. */
function parseOpenTag(text: string, start: number, scan: Scan): OpenTag | null {
  return parseOpenTagWith(text, start, scan, true) ?? parseOpenTagWith(text, start, scan, false);
}

/** `is:raw` among the tag's attributes, outside any value: the element's content is then text. */
function hasRawDirective(text: string, tag: OpenTag): boolean {
  let from = tag.start + 1 + tag.name.length;
  for (const value of [...tag.values, { from: tag.end, to: tag.end }]) {
    if (/(?:^|\s)is:raw(?=[\s/>=]|$)/.test(text.slice(from, value.from))) return true;
    from = value.to;
  }
  return false;
}

function holdsRawText(text: string, tag: OpenTag): boolean {
  return RAW_TEXT_ELEMENTS.has(tag.name) || hasRawDirective(text, tag);
}

/**
 * Past one `{…}` in markup, or -1. JavaScript strings throw off a brace count
 * (`{'{'}`) and apostrophes in JSX text throw off a string-aware one
 * (`{items.map((i) => <li>It's {i}</li>)}`), and in each case the reading that
 * is thrown off runs long, so the earlier of the two is taken.
 */
function expressionEnd(text: string, open: number): number {
  const limit = Math.min(text.length, open + EXPRESSION_SPAN_LIMIT);
  const aware = skipBraces(text, open, limit, true);
  const counted = skipBraces(text, open, limit, false);
  if (aware === -1) return counted;
  if (counted === -1) return aware;
  return Math.min(aware, counted);
}

/** The position the compiler would stamp on this element. */
function anchorOf(text: string, tag: OpenTag): number {
  const ownName = tag.start + 1;
  if (tag.selfClosing || tag.name.includes("-") || VOID_ELEMENTS.has(tag.name)) return ownName;
  const content = tag.end;
  if (content >= text.length || text.startsWith("</", content)) return ownName;
  if (holdsRawText(text, tag)) return content;
  if (text.startsWith("<!--", content)) return content + 4;
  if (text[content] === "<" && /[A-Za-z]/.test(text[content + 1] ?? "")) return content + 1;
  // Text, whitespace included, an expression or a fragment.
  return content;
}

/** Where the frontmatter ends, 0 when there is none, null when it never closes. */
function frontmatterEnd(text: string): number | null {
  let index = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  while (index < text.length && WHITESPACE.test(text[index]!)) index += 1;
  if (!text.startsWith("---", index)) return 0;
  const fence = /(?:\r\n|\r|\n)---/g;
  fence.lastIndex = index + 3;
  const close = fence.exec(text);
  return close === null ? null : close.index + close[0].length;
}

/** The `</name` that closes a raw-text element, by its whole name; -1 if none does. */
function closingTagFrom(text: string, name: string, from: number): number {
  const needle = `</${name}`;
  for (let index = text.indexOf(needle, from); index !== -1;) {
    if (/[\s/>]/.test(text[index + needle.length] ?? "")) return index;
    index = text.indexOf(needle, index + 1);
  }
  return -1;
}

const MARKUP_STOP = /[<{]/g;

export function lexiconOf(text: string): Lexicon {
  const markupStart = frontmatterEnd(text);
  const regions: Region[] = [];
  if (markupStart === null) return { markupStart, regions, stoppedAt: null };
  const stop = (at: number): Lexicon => ({ markupStart, regions, stoppedAt: at });
  const scan: Scan = { bounded: false };
  let index = markupStart;
  while (index < text.length) {
    MARKUP_STOP.lastIndex = index;
    const found = MARKUP_STOP.exec(text);
    if (found === null) break;
    index = found.index;
    if (text[index] === "{") {
      const end = expressionEnd(text, index);
      if (end === -1) return stop(index);
      regions.push({ from: index, to: end, kind: "expression" });
      index = end;
      continue;
    }
    if (text.startsWith("<!--", index)) {
      const close = text.indexOf("-->", index + 4);
      if (close === -1) return stop(index);
      regions.push({ from: index, to: close + 3, kind: "text" });
      index = close + 3;
      continue;
    }
    const tag = /[A-Za-z]/.test(text[index + 1] ?? "") ? parseOpenTag(text, index, scan) : null;
    if (tag === null) {
      // A closing tag, a fragment, a doctype or a `<` in text; or a tag past the span bound.
      if (scan.bounded) return stop(index);
      index += 1;
      continue;
    }
    for (const value of tag.values) {
      regions.push({ ...value, kind: value.quoted ? "text" : "attribute-expression" });
    }
    index = tag.end;
    if (!tag.selfClosing && holdsRawText(text, tag)) {
      const close = closingTagFrom(text, tag.name, index);
      if (close === -1) return stop(index);
      regions.push({ from: index, to: close, kind: "text" });
      index = close;
    }
  }
  return { markupStart, regions, stoppedAt: null };
}

function regionAt(regions: readonly Region[], at: number): Region | null {
  let low = 0;
  let high = regions.length - 1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    const region = regions[middle]!;
    if (at < region.from) high = middle - 1;
    else if (at >= region.to) low = middle + 1;
    else return region;
  }
  return null;
}

/**
 * The opening tag whose `>` is the character before `end`. The walk back over
 * quoted values and braced expressions finds its `<` in one pass; when a brace
 * inside a string throws that walk off, the nearest `<`s are tried instead.
 * Either way the tag is read forward to confirm it ends at `end`.
 */
function openTagEndingAt(text: string, end: number, scan: Scan): OpenTag | null {
  const confirmed = (start: number) => {
    const tag = parseOpenTag(text, start, scan);
    return tag !== null && tag.end === end ? tag : null;
  };
  const floor = Math.max(0, end - TAG_SPAN_LIMIT);
  let index = end - 2;
  let walked = false;
  while (!walked && index >= floor) {
    const char = text[index];
    if (QUOTES.has(char)) {
      const open = text.lastIndexOf(char!, index - 1);
      if (open === -1) walked = true;
      index = open - 1;
    } else if (char === "}") {
      let depth = 0;
      for (; index >= floor; index -= 1) {
        if (text[index] === "}") depth += 1;
        else if (text[index] === "{" && --depth === 0) break;
      }
      index -= 1;
    } else if (char === ">") {
      // Outside any value, a `>` ends some other tag.
      walked = true;
    } else if (char === "<") {
      const tag = confirmed(index);
      if (tag !== null) return tag;
      walked = true;
    } else {
      index -= 1;
    }
  }
  for (let at = end - 1, tries = 0; at > floor && tries < BACKWARD_TRIES; tries += 1) {
    at = text.lastIndexOf("<", at - 1);
    if (at < floor) break;
    const tag = confirmed(at);
    if (tag !== null) return tag;
  }
  // The walk ran out of span before it reached any `<`: the tag may open further back.
  if (!walked && floor > 0) scan.bounded = true;
  return null;
}

/** Lower-case first, no dots: a capitalised or dotted name is a component, which is never stamped. */
function isStampable(name: string): boolean {
  return !NEVER_STAMPED.has(name) && !name.includes(".") && name[0] === name[0]!.toLowerCase();
}

type Standing = "counts" | "unsettled" | "excluded";

function standingOf(text: string, tag: OpenTag, lexicon: Lexicon): Standing {
  if (tag.start < (lexicon.markupStart ?? Infinity) || !isStampable(tag.name)) return "excluded";
  if (lexicon.stoppedAt !== null && tag.start >= lexicon.stoppedAt) return "unsettled";
  const region = regionAt(lexicon.regions, tag.start);
  if (region?.kind === "text") return "excluded";
  if (region?.kind === "attribute-expression") return "unsettled";
  // Markup in a string reads like markup; a quote just before it says it may be one.
  if (QUOTES.has(text[tag.start - 1])) return "unsettled";
  return "counts";
}

/** Opening tags whose stamped position would be `offset`, by each form the compiler's rule takes. */
function tagsStampedAt(text: string, offset: number, scan: Scan): OpenTag[] {
  const found: OpenTag[] = [];
  const own = parseOpenTag(text, offset - 1, scan);
  if (own !== null && anchorOf(text, own) === offset) found.push(own);
  // A first child starts at the offset (text, expression, fragment), one past
  // it (an element's name) or four past it (a comment's body): the opening
  // tag ends just before.
  for (const end of [offset, offset - 1, offset - 4]) {
    if (end < 2 || text[end - 1] !== ">") continue;
    const tag = openTagEndingAt(text, end, scan);
    if (tag !== null && anchorOf(text, tag) === offset) found.push(tag);
  }
  return found;
}

/**
 * Checks a 1-based line and column, the column in UTF-16 units, against
 * `text` decoded with any byte-order mark kept, for an element named `tagName`
 * as the DOM reports it. `lexicon` is `lexiconOf(text)`, passed in when one
 * file is checked more than once.
 */
export function checkAstroAnchor(
  text: string,
  line: number,
  column: number,
  tagName: string,
  lexicon: Lexicon = lexiconOf(text)
): AnchorCheck {
  const start = lineStart(text, line);
  if (start === null) return "mismatch";
  let lineEnd = start;
  while (lineEnd < text.length && !isLineBreak(text[lineEnd])) lineEnd += 1;
  // A first child that starts with a line break is stamped at the line's end.
  const offset = start + column - 1;
  if (offset > lineEnd) return "mismatch";
  // Whether the compiler counted the mark depends on what handed it the text.
  if (line === 1 && text.charCodeAt(0) === 0xfeff) return "inconclusive";
  if (lexicon.markupStart === null) return "inconclusive";

  const scan: Scan = { bounded: false };
  const standings = tagsStampedAt(text, offset, scan).map((tag) => ({
    tag,
    standing: standingOf(text, tag, lexicon),
  }));
  const counted = standings.filter((entry) => entry.standing === "counts");
  if (counted.some((entry) => entry.tag.name === tagName)) return "verified";
  // The DOM case-adjusts some names (`linearGradient`); one that differs only in case is not a mismatch either.
  const lower = tagName.toLowerCase();
  if (counted.some((entry) => entry.tag.name.toLowerCase() === lower)) return "inconclusive";
  if (scan.bounded || standings.some((entry) => entry.standing === "unsettled")) {
    return "inconclusive";
  }
  return "mismatch";
}
