import { Document, isMap, isScalar, parseDocument, stringify, type Pair } from "yaml";

/**
 * Thrown for frontmatter that cannot be read: invalid YAML, a block that is
 * opened but never closed, or YAML that is not a mapping. `line` and `column`
 * are 1-based positions in the whole file, not in the YAML block.
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

function parseBlock(block: FrontmatterBlock): Document.Parsed {
  const doc = parseDocument(block.yaml, { prettyErrors: false });
  const [error] = doc.errors;
  if (error) {
    const { line, column } = lineAndColumn(block.yaml, error.pos[0]);
    // The opening delimiter is line 1 of the file, so YAML line 1 is file line 2.
    throw new FrontmatterError(`invalid YAML frontmatter: ${error.message}`, line + 1, column);
  }
  if (doc.contents !== null && !isMap(doc.contents)) {
    const { line, column } = lineAndColumn(block.yaml, doc.contents.range?.[0] ?? 0);
    throw new FrontmatterError("frontmatter must be a YAML mapping", line + 1, column);
  }
  return doc;
}

function toData(doc: Document.Parsed): Record<string, unknown> {
  const value: unknown = doc.toJS();
  return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

/**
 * Split a document into its YAML frontmatter and body. Frontmatter is a
 * block that opens on the very first line with `---` and closes at the next
 * line that is exactly `---`. A document that does not open with `---` has no
 * frontmatter, and its whole text is the body.
 *
 * Throws {@link FrontmatterError} for invalid YAML, an unclosed block, or YAML
 * that is not a mapping, so a malformed file is reported rather than read as
 * empty.
 */
export function parseFrontmatter(text: string): ParsedFrontmatter {
  const block = splitFrontmatter(text);
  if (!block) return { data: {}, body: text, hasFrontmatter: false };
  return { data: toData(parseBlock(block)), body: block.body, hasFrontmatter: true };
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

/** A value that renders as one plain or quoted scalar on the key's own line. */
function inlineScalarText(value: unknown): string | null {
  if (value !== null && typeof value === "object" && !(value instanceof Date)) return null;
  const rendered = stringify(value, STRINGIFY_OPTIONS).replace(/\n$/, "");
  if (rendered.includes("\n") || rendered.startsWith("|") || rendered.startsWith(">")) return null;
  return rendered;
}

function isInlineScalarNode(node: unknown): node is { range: [number, number, number] } {
  if (!isScalar(node) || !node.range) return false;
  return node.type !== "BLOCK_LITERAL" && node.type !== "BLOCK_FOLDED";
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
 * a collection or multi-line string rewrites that entry's lines in the
 * library's default style. A top-level flow mapping (`{ a: 1 }`) cannot be
 * edited in place, so it is re-serialised as a whole.
 */
export function updateFrontmatter(text: string, patch: Record<string, unknown>): string {
  const block = splitFrontmatter(text);
  const keys = Object.keys(patch);
  if (!block) {
    const additions = Object.fromEntries(keys.map((key) => [key, patch[key]]));
    if (renderMapping(additions) === "") return text;
    return stringifyFrontmatter(additions, text);
  }

  const doc = parseBlock(block);
  const source = block.yaml;
  const map = doc.contents;

  if (map !== null && isMap(map) && map.flow) {
    for (const key of keys) {
      if (patch[key] === undefined) doc.delete(key);
      else doc.set(key, patch[key]);
    }
    const rendered = withEol(doc.toString(STRINGIFY_OPTIONS), block.eol);
    return block.head + rendered + block.close + block.body;
  }

  const pairs = map !== null && isMap(map) ? (map.items as Pair[]) : [];
  const splices: Splice[] = [];
  const appended: string[] = [];

  for (const key of keys) {
    const value = patch[key];
    const pair = pairs.find((candidate) => keyMatches(candidate, key));
    if (!pair) {
      if (value !== undefined) appended.push(renderMapping({ [key]: value }));
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
    const inline = inlineScalarText(value);
    if (inline !== null && isInlineScalarNode(pair.value)) {
      const [start, end] = pair.value.range;
      // An empty value (`key:`) has no text to replace, so the new value needs
      // its own separator after the colon.
      const separator = start === end && source[start - 1] === ":" ? " " : "";
      splices.push({ start, end, text: separator + inline });
      continue;
    }
    splices.push({ start: range.start, end: range.end, text: renderMapping({ [key]: value }) });
  }

  let yaml = source;
  for (const splice of splices.sort((a, b) => b.start - a.start)) {
    yaml = yaml.slice(0, splice.start) + withEol(splice.text, block.eol) + yaml.slice(splice.end);
  }
  if (appended.length > 0) {
    const separator = yaml === "" || yaml.endsWith("\n") ? "" : block.eol;
    yaml += separator + withEol(appended.join(""), block.eol);
  }
  return block.head + yaml + block.close + block.body;
}
