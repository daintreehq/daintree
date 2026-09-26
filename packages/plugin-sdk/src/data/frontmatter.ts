import {
  type Alias,
  Document,
  isMap,
  isNode,
  isScalar,
  parseDocument,
  stringify,
  visit,
  type Pair,
} from "yaml";

/**
 * Thrown for frontmatter that cannot be read: invalid YAML (an alias with no
 * anchor included), a block that is opened but never closed, or YAML that is
 * not a mapping — and by `updateFrontmatter` for an edit that would produce
 * one of those. `line` and `column` are 1-based positions in the whole file,
 * not in the YAML block.
 */
export class FrontmatterError extends Error {
  readonly code = "FRONTMATTER_INVALID";
  readonly line: number;
  readonly column: number;

  constructor(message: string, line: number, column: number) {
    super(`${message} (line ${line}, column ${column})`);
    this.name = "FrontmatterError";
    this.line = line;
    this.column = column;
  }
}

export interface ParsedFrontmatter {
  /** The frontmatter mapping as plain values. `{}` when there is none. */
  data: Record<string, unknown>;
  /** Everything after the closing `---` line, byte-for-byte. */
  body: string;
  /** Whether the text opened with a `---` frontmatter block. */
  hasFrontmatter: boolean;
}

interface FrontmatterBlock {
  /** Everything up to and including the opening delimiter's line break. */
  head: string;
  /** The YAML between the delimiters, including its final line break. */
  yaml: string;
  /** The closing delimiter line, including its line break when it has one. */
  close: string;
  body: string;
  /** The line break the opening delimiter uses; new lines are written with it. */
  eol: string;
}

const OPEN = /^(\uFEFF?---[ \t]*)(\r?\n)/;
const CLOSE_LINE = /^---[ \t]*$/;

// YAML 1.2 core schema is the default: `yes`/`no` stay strings and dates stay
// strings, which is what a Markdown document's author meant by them. No line
// folding, so a long title stays on one line.
const STRINGIFY_OPTIONS = { lineWidth: 0 } as const;

function splitFrontmatter(text: string): FrontmatterBlock | null {
  const open = OPEN.exec(text);
  if (!open) return null;
  const head = open[0];
  const eol = open[2];
  let lineStart = head.length;
  while (lineStart <= text.length) {
    const newline = text.indexOf("\n", lineStart);
    const lineEnd = newline === -1 ? text.length : newline + 1;
    const line = text.slice(lineStart, lineEnd).replace(/\r?\n$/, "");
    if (CLOSE_LINE.test(line)) {
      return {
        head,
        yaml: text.slice(head.length, lineStart),
        close: text.slice(lineStart, lineEnd),
        body: text.slice(lineEnd),
        eol,
      };
    }
    if (newline === -1) break;
    lineStart = lineEnd;
  }
  throw new FrontmatterError("frontmatter opened on line 1 is never closed with ---", 1, 1);
}

function lineAndColumn(source: string, offset: number): { line: number; column: number } {
  let line = 1;
  let lastBreak = -1;
  for (let i = 0; i < offset && i < source.length; i++) {
    if (source[i] === "\n") {
      line++;
      lastBreak = i;
    }
  }
  return { line, column: offset - lastBreak };
}

type YamlReading =
  | { ok: true; doc: Document.Parsed; data: Record<string, unknown> }
  | { ok: false; problem: string; offset: number };

/**
 * The offset of the alias that made `toJS` throw — one whose anchor is not
 * defined before it, or whose expansion crossed the alias limit. yaml's error
 * does not say which alias it was, so on this failure path only, the aliases
 * are wrapped and the conversion re-run to catch the first one that throws.
 */
function failingAliasOffset(doc: Document.Parsed): number | undefined {
  let culprit: Alias | undefined;
  visit(doc, {
    Alias(_, node) {
      const toJSON = node.toJSON.bind(node);
      node.toJSON = (...args: Parameters<Alias["toJSON"]>) => {
        try {
          return toJSON(...args);
        } catch (error) {
          culprit ??= node;
          throw error;
        }
      };
    },
  });
  try {
    doc.toJS();
  } catch {
    // Expected: this pass only repeats the failure to see where it happens.
  }
  return culprit?.range?.[0];
}

/**
 * Parse and materialise one YAML block, reporting any failure as a problem
 * with its offset rather than throwing. Materialising is part of reading: an
 * alias whose anchor is missing, or one that expands past the alias limit,
 * only fails in `toJS`, after the parse itself reported nothing.
 */
function readYaml(yaml: string): YamlReading {
  const doc = parseDocument(yaml, { prettyErrors: false });
  const [error] = doc.errors;
  if (error) return { ok: false, problem: `invalid YAML: ${error.message}`, offset: error.pos[0] };
  if (doc.contents !== null && !isMap(doc.contents)) {
    return {
      ok: false,
      problem: "frontmatter must be a YAML mapping",
      offset: doc.contents.range?.[0] ?? 0,
    };
  }
  let value: unknown;
  try {
    value = doc.toJS();
  } catch (toJsError) {
    // yaml throws plain Errors (a ReferenceError for an unresolved alias).
    const reason = (toJsError as Error).message;
    const offset = failingAliasOffset(doc);
    if (offset !== undefined) return { ok: false, problem: `invalid YAML: ${reason}`, offset };
    return {
      ok: false,
      problem: `invalid YAML: ${reason} (the failing node could not be located, so the position given is the start of the frontmatter)`,
      offset: 0,
    };
  }
  const data =
    value !== null && typeof value === "object" ? (value as Record<string, unknown>) : {};
  return { ok: true, doc, data };
}

function failure(yaml: string, offset: number, message: string): FrontmatterError {
  const { line, column } = lineAndColumn(yaml, offset);
  // The opening delimiter is line 1 of the file, so YAML line 1 is file line 2.
  return new FrontmatterError(message, line + 1, column);
}

function readBlock(block: FrontmatterBlock): {
  doc: Document.Parsed;
  data: Record<string, unknown>;
} {
  const reading = readYaml(block.yaml);
  if (!reading.ok) throw failure(block.yaml, reading.offset, reading.problem);
  return reading;
}

/**
 * Split a document into its YAML frontmatter and body. Frontmatter is a
 * block that opens on the very first line with `---` and closes at the next
 * line that is exactly `---`. A document that does not open with `---` has no
 * frontmatter, and its whole text is the body.
 *
 * Throws {@link FrontmatterError} for invalid YAML (including an alias with no
 * anchor), an unclosed block, or YAML that is not a mapping, so a malformed
 * file is reported rather than read as empty.
 */
export function parseFrontmatter(text: string): ParsedFrontmatter {
  const block = splitFrontmatter(text);
  if (!block) return { data: {}, body: text, hasFrontmatter: false };
  return { data: readBlock(block).data, body: block.body, hasFrontmatter: true };
}

function renderMapping(data: Record<string, unknown>): string {
  const defined = Object.entries(data).filter(([, value]) => value !== undefined);
  if (defined.length === 0) return "";
  return stringify(Object.fromEntries(defined), STRINGIFY_OPTIONS);
}

/**
 * Write `data` as a frontmatter block ahead of `body`. `undefined` values are
 * omitted. The body is appended verbatim, so
 * `parseFrontmatter(stringifyFrontmatter(d, b)).body === b`.
 */
export function stringifyFrontmatter(data: Record<string, unknown>, body: string): string {
  return `---\n${renderMapping(data)}---\n${body}`;
}

function keyMatches(pair: Pair, key: string): boolean {
  return isScalar(pair.key) && String(pair.key.value) === key;
}

function lineStartOf(source: string, offset: number): number {
  return source.lastIndexOf("\n", offset - 1) + 1;
}

/** The offset just past the line break that ends the line holding `offset - 1`. */
function lineEndAfter(source: string, contentEnd: number): number {
  if (contentEnd > 0 && source[contentEnd - 1] === "\n") return contentEnd;
  const newline = source.indexOf("\n", contentEnd);
  return newline === -1 ? source.length : newline + 1;
}

interface Splice {
  start: number;
  end: number;
  text: string;
}

function withEol(text: string, eol: string): string {
  return eol === "\n" ? text : text.replace(/\n/g, eol);
}

/** The line break a text already uses, judged by its first one. */
function detectEol(text: string): string {
  const newline = text.indexOf("\n");
  return newline > 0 && text[newline - 1] === "\r" ? "\r\n" : "\n";
}

function indentLines(text: string, indent: string): string {
  if (indent === "") return text;
  return text
    .split("\n")
    .map((line) => (line === "" ? line : indent + line))
    .join("\n");
}

/**
 * The byte range one top-level entry occupies: from the start of its key's
 * line to the end of the line its value finishes on. Comment lines before the
 * next key are outside it, since they describe that key.
 */
function pairRange(source: string, pair: Pair): { start: number; end: number } | null {
  const keyRange = isScalar(pair.key) ? pair.key.range : undefined;
  if (!keyRange) return null;
  const value = pair.value as { range?: [number, number, number] } | null;
  const contentEnd = value?.range ? value.range[1] : keyRange[1];
  return { start: lineStartOf(source, keyRange[0]), end: lineEndAfter(source, contentEnd) };
}

/**
 * The indentation the root mapping's keys sit at. A block mapping may be
 * indented as a whole, and every line written into it has to match.
 */
function rootIndent(source: string, pairs: Pair[]): string {
  const first = pairs[0];
  const start = first && isScalar(first.key) ? first.key.range?.[0] : undefined;
  if (start === undefined) return "";
  const indent = source.slice(lineStartOf(source, start), start);
  return /^[ ]*$/.test(indent) ? indent : "";
}

/** One `key: value` entry, carrying over the anchor the old value had. */
function renderPair(key: string, value: unknown, anchor: string | undefined): string {
  const doc = new Document({ [key]: value });
  if (anchor !== undefined) {
    const node = doc.get(key, true);
    if (isNode(node)) node.anchor = anchor;
  }
  return doc.toString(STRINGIFY_OPTIONS);
}

/** A value that renders as one plain or quoted scalar on the key's own line. */
function inlineScalarText(value: unknown): string | null {
  if (value !== null && typeof value === "object" && !(value instanceof Date)) return null;
  const rendered = stringify(value, STRINGIFY_OPTIONS).replace(/\n$/, "");
  if (rendered.includes("\n") || rendered.startsWith("|") || rendered.startsWith(">")) return null;
  return rendered;
}

/**
 * A scalar whose text can be swapped in place. An explicit tag is excluded:
 * it sits outside the scalar's range and would survive the swap, so
 * `!!str 1` patched with `2` would still read back as a string.
 */
function isInlineScalarNode(node: unknown): node is { range: [number, number, number] } {
  if (!isScalar(node) || !node.range || node.tag !== undefined) return false;
  return node.type !== "BLOCK_LITERAL" && node.type !== "BLOCK_FOLDED";
}

const CORE_TAG_PREFIX = "tag:yaml.org,2002:";

/**
 * Tags a rewrite may drop: each is a type a plain value written in its place
 * already expresses. Any other tag (`!!binary`, `!!timestamp`, a custom `!foo`)
 * names a type the patch cannot reproduce, so such a value is refused rather
 * than silently turned into a string or a plain collection.
 */
const REWRITABLE_TAGS = new Set(
  ["str", "int", "float", "bool", "null", "map", "seq"].map((name) => CORE_TAG_PREFIX + name)
);

function shortTag(tag: string): string {
  return tag.startsWith(CORE_TAG_PREFIX) ? `!!${tag.slice(CORE_TAG_PREFIX.length)}` : tag;
}

/**
 * Change only the named top-level frontmatter keys and leave every other byte
 * of the document alone — comments, key order, quoting, blank lines, and the
 * body. A value of `undefined` deletes the key; a key that is not present yet
 * is appended at the end of the block. A document with no frontmatter gains
 * a block holding the patch.
 *
 * This is what makes a UI edit safe beside an agent's: the two only collide
 * when they touch the same key. Pair it with {@link editFile} so the write
 * itself is also conflict-checked.
 *
 * An edited scalar keeps its trailing comment. A value that becomes (or was)
 * a collection, a multi-line string or an explicitly tagged scalar rewrites
 * that entry's lines in the library's default style, keeping its anchor. A
 * top-level flow mapping (`{ a: 1 }`) cannot be edited in place, so a
 * non-empty patch re-serialises it as a whole.
 *
 * Throws {@link FrontmatterError} when the existing frontmatter is invalid,
 * when a patched value carries a tag beyond the core types (`!!binary`,
 * `!!timestamp`, a custom `!tag`) that the new value would lose, and when the
 * edit would leave the frontmatter unreadable — deleting or replacing a value
 * whose anchor another key still refers to.
 */
export function updateFrontmatter(text: string, patch: Record<string, unknown>): string {
  const block = splitFrontmatter(text);
  const keys = Object.keys(patch);
  if (!block) {
    const additions = Object.fromEntries(keys.map((key) => [key, patch[key]]));
    const rendered = renderMapping(additions);
    if (rendered === "") return text;
    return withEol(`---\n${rendered}---\n`, detectEol(text)) + text;
  }

  const { doc } = readBlock(block);
  if (keys.length === 0) return text;
  const source = block.yaml;
  const map = doc.contents;
  let yaml: string;

  if (map !== null && isMap(map) && map.flow) {
    for (const key of keys) {
      if (patch[key] === undefined) doc.delete(key);
      else doc.set(key, patch[key]);
    }
    yaml = withEol(doc.toString(STRINGIFY_OPTIONS), block.eol);
  } else {
    const pairs = map !== null && isMap(map) ? (map.items as Pair[]) : [];
    const indent = rootIndent(source, pairs);
    const splices: Splice[] = [];
    const appended: string[] = [];

    for (const key of keys) {
      const value = patch[key];
      const pair = pairs.find((candidate) => keyMatches(candidate, key));
      if (!pair) {
        if (value !== undefined)
          appended.push(indentLines(renderPair(key, value, undefined), indent));
        continue;
      }
      const range = pairRange(source, pair);
      if (!range) {
        throw new FrontmatterError(`cannot edit the complex key "${key}" in place`, 1, 1);
      }
      if (value === undefined) {
        splices.push({ start: range.start, end: range.end, text: "" });
        continue;
      }
      const tag = isNode(pair.value) ? pair.value.tag : undefined;
      if (tag !== undefined && !REWRITABLE_TAGS.has(tag)) {
        const at = (pair.value as { range?: [number, number, number] }).range?.[0] ?? range.start;
        throw failure(
          source,
          at,
          `cannot patch "${key}": its value is tagged ${shortTag(tag)}, a type a plain value cannot carry, so the edit would silently change it`
        );
      }
      const inline = inlineScalarText(value);
      if (inline !== null && isInlineScalarNode(pair.value)) {
        const [start, end] = pair.value.range;
        // An empty value (`key:`) has no text to replace, so the new value may
        // need a space after the colon and before a trailing comment.
        const empty = start === end;
        const before = empty && !/\s/.test(source[start - 1] ?? "") ? " " : "";
        const after = empty && end < source.length && !/\s/.test(source[end]) ? " " : "";
        splices.push({ start, end, text: before + inline + after });
        continue;
      }
      const anchor = isNode(pair.value) ? pair.value.anchor : undefined;
      splices.push({
        start: range.start,
        end: range.end,
        text: indentLines(renderPair(key, value, anchor), indent),
      });
    }

    yaml = source;
    for (const splice of splices.sort((a, b) => b.start - a.start)) {
      yaml = yaml.slice(0, splice.start) + withEol(splice.text, block.eol) + yaml.slice(splice.end);
    }
    if (appended.length > 0) {
      const separator = yaml === "" || yaml.endsWith("\n") ? "" : block.eol;
      yaml += separator + withEol(appended.join(""), block.eol);
    }
  }

  // Nothing above can see every way an edit breaks a document — an alias left
  // pointing at a deleted anchor is the usual one — so the result is read back
  // before it is handed out.
  const check = readYaml(yaml);
  if (!check.ok) {
    throw failure(
      yaml,
      check.offset,
      `this edit would leave the frontmatter unreadable: ${check.problem}`
    );
  }
  return block.head + yaml + block.close + block.body;
}
