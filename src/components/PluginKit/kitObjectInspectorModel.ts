// ObjectInspector's model: a JSON-like value flattened into the rows a tree
// draws, with ranges for big arrays, cycles cut, and a filter that keeps the
// way down to every match. Pure, so it is tested without a DOM. Rows carry
// the fields the file tree's key and typeahead resolvers read.

export type ValueKind =
  | "object"
  | "array"
  | "map"
  | "set"
  | "string"
  | "number"
  | "bigint"
  | "boolean"
  | "null"
  | "undefined"
  | "date"
  | "function"
  | "symbol"
  | "circular";

export interface InspectorRow {
  /** Unique: the JSON pointer of the value, a range's own suffix after it. */
  path: string;
  /** The label read by typeahead: the key, an index, or a range. */
  name: string;
  depth: number;
  isDirectory: boolean;
  isExpanded: boolean;
  isLoading: false;
  /** The key as drawn: a property name, an index, a range like `[0 … 99]`, or null for an unnamed root. */
  key: string | null;
  keyKind: "property" | "index" | "range" | "root";
  kind: ValueKind;
  value: unknown;
  /** The JavaScript path to copy (`response.items[0].id`); empty for an unnamed root. */
  copyPath: string;
  /** The value shown after the key: the primitive itself, or a container's summary. */
  preview: string;
  /** A string longer than the limit, still cut. */
  truncated: boolean;
  posInSet: number;
  setSize: number;
  /** A filter match on this row's own key or value. */
  match: boolean;
}

export interface InspectorOptions {
  name: string | null;
  /** Containers shallower than this start open. */
  expandDepth: number;
  /** Per-row choices that override the depth rule, keyed by row path. */
  overrides: ReadonlyMap<string, boolean>;
  filter: string;
  maxStringLength: number;
  chunkSize: number;
  sortKeys: boolean;
  /** Strings shown in full despite the limit. */
  expandedStrings: ReadonlySet<string>;
  /** A ceiling on drawn rows, so expanding everything in a huge value stays bounded. */
  maxRows: number;
}

export const DEFAULT_MAX_STRING = 200;
export const DEFAULT_CHUNK = 100;
export const MAX_INSPECTOR_ROWS = 100_000;
const MAX_DEPTH = 100;
const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;

export function kindOf(value: unknown): ValueKind {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (value instanceof Date) return "date";
  if (value instanceof Map) return "map";
  if (value instanceof Set) return "set";
  switch (typeof value) {
    case "string":
      return "string";
    case "number":
      return "number";
    case "bigint":
      return "bigint";
    case "boolean":
      return "boolean";
    case "undefined":
      return "undefined";
    case "function":
      return "function";
    case "symbol":
      return "symbol";
    default:
      return "object";
  }
}

function isContainer(kind: ValueKind): boolean {
  return kind === "object" || kind === "array" || kind === "map" || kind === "set";
}

function pointerToken(key: string): string {
  return key.replace(/~/g, "~0").replace(/\//g, "~1");
}

function propertyPath(parent: string, key: string): string {
  if (parent === "") return IDENTIFIER.test(key) ? key : `[${JSON.stringify(key)}]`;
  return IDENTIFIER.test(key) ? `${parent}.${key}` : `${parent}[${JSON.stringify(key)}]`;
}

/**
 * How a Map entry is reached in code: `.get(key)` with the key in its own
 * type, or by position when the key is an object only identity can find.
 */
function mapGetPath(owner: string, key: unknown, index: number): string {
  if (typeof key === "string") return `${owner}.get(${JSON.stringify(key)})`;
  if (typeof key === "number" && Number.isFinite(key)) return `${owner}.get(${key})`;
  if (typeof key === "bigint") return `${owner}.get(${safeString(key)}n)`;
  if (typeof key === "boolean" || key === null || key === undefined) {
    return `${owner}.get(${String(key)})`;
  }
  return `[...${owner}.values()][${index}]`;
}

function safeString(value: unknown): string {
  try {
    return String(value);
  } catch {
    return "";
  }
}

/** The text a primitive is drawn as. Strings are quoted; containers are summarised. */
export function previewOf(value: unknown, kind: ValueKind, maxString: number, full: boolean) {
  if (kind === "circular") return { text: "[Circular]", truncated: false };
  if (typeof value === "string") {
    const cut = !full && value.length > maxString;
    return { text: JSON.stringify(cut ? value.slice(0, maxString) : value), truncated: cut };
  }
  if (typeof value === "bigint") return { text: `${safeString(value)}n`, truncated: false };
  if (value instanceof Date) {
    const time = value.getTime();
    return { text: Number.isNaN(time) ? "Invalid Date" : value.toISOString(), truncated: false };
  }
  if (typeof value === "function") {
    const name: unknown = Reflect.get(value, "name");
    return {
      text: `ƒ ${typeof name === "string" && name ? name : "anonymous"}()`,
      truncated: false,
    };
  }
  if (Array.isArray(value)) return { text: `Array(${value.length})`, truncated: false };
  if (value instanceof Map) return { text: `Map(${value.size})`, truncated: false };
  if (value instanceof Set) return { text: `Set(${value.size})`, truncated: false };
  if (typeof value === "object" && value !== null) {
    const count = safeKeys(value).length;
    return { text: count === 1 ? "{1 key}" : `{${count} keys}`, truncated: false };
  }
  return { text: safeString(value), truncated: false };
}

function safeKeys(value: object): string[] {
  try {
    return Object.keys(value);
  } catch {
    return [];
  }
}

function safeGet(value: object, key: string): unknown {
  try {
    return Reflect.get(value, key);
  } catch (error) {
    return error instanceof Error ? `[Threw: ${error.message}]` : "[Threw]";
  }
}

interface Child {
  key: string;
  keyKind: "property" | "index";
  value: unknown;
  pointer: string;
  copyPath: string;
}

function childrenOf(value: unknown, pointer: string, copyPath: string, sort: boolean): Child[] {
  if (Array.isArray(value) || value instanceof Set) {
    const set = value instanceof Set;
    return [...value].map((item: unknown, index) => ({
      key: String(index),
      keyKind: "index",
      value: item,
      pointer: `${pointer}/${index}`,
      copyPath: set ? `[...${copyPath || "value"}][${index}]` : `${copyPath}[${index}]`,
    }));
  }
  if (value instanceof Map) {
    const owner = copyPath || "value";
    return [...value].map(([key, item]: [unknown, unknown], index) => {
      const name = typeof key === "string" ? key : safeString(key);
      return {
        key: name,
        keyKind: "property",
        value: item,
        pointer: `${pointer}/${pointerToken(name)}~${index}`,
        copyPath: mapGetPath(owner, key, index),
      };
    });
  }
  if (typeof value !== "object" || value === null) return [];
  const keys = safeKeys(value);
  if (sort) keys.sort((a, b) => a.localeCompare(b));
  return keys.map((key) => ({
    key,
    keyKind: "property",
    value: safeGet(value, key),
    pointer: `${pointer}/${pointerToken(key)}`,
    copyPath: propertyPath(copyPath, key),
  }));
}

/**
 * Whether anything at or below `value` matches `needle`: its own key, its
 * primitive text, or a descendant's. Cached per container for one build.
 */
function createMatcher(needle: string, sort: boolean) {
  const memo = new WeakMap<object, boolean>();
  // A "no match" found while a cycle was cut short depends on the path taken,
  // so only answers reached without a cut are remembered.
  let cuts = 0;
  const textMatches = (text: string) => text.toLowerCase().includes(needle);
  const selfMatches = (key: string | null, value: unknown, kind: ValueKind): boolean => {
    if (key !== null && textMatches(key)) return true;
    if (isContainer(kind) || kind === "circular") return false;
    const text = typeof value === "string" ? value : previewOf(value, kind, Infinity, true).text;
    return textMatches(text);
  };
  const below = (value: unknown, kind: ValueKind, stack: Set<object>, depth: number): boolean => {
    if (!isContainer(kind) || depth > MAX_DEPTH) return false;
    if (typeof value !== "object" || value === null) return false;
    const object = value;
    const cached = memo.get(object);
    if (cached !== undefined) return cached;
    stack.add(object);
    const cutsBefore = cuts;
    let found = false;
    for (const child of childrenOf(value, "", "", sort)) {
      const cyclic =
        typeof child.value === "object" && child.value !== null && stack.has(child.value);
      if (cyclic) cuts += 1;
      const childKind = cyclic ? "circular" : kindOf(child.value);
      if (
        selfMatches(child.key, child.value, childKind) ||
        below(child.value, childKind, stack, depth + 1)
      ) {
        found = true;
        break;
      }
    }
    stack.delete(object);
    if (found || cuts === cutsBefore) memo.set(object, found);
    return found;
  };
  return { selfMatches, below };
}

export interface InspectorBuild {
  rows: InspectorRow[];
  /** Rows left out past `maxRows`. */
  clipped: boolean;
  /** With a filter: whether anything in the value matches it, drawn or not. */
  matched: boolean;
}

export function buildInspectorRows(value: unknown, options: InspectorOptions): InspectorBuild {
  const rows: InspectorRow[] = [];
  const needle = options.filter.trim().toLowerCase();
  const matcher = needle ? createMatcher(needle, options.sortKeys) : null;
  const chunk = Math.max(2, Math.floor(options.chunkSize));
  let clipped = false;
  const stack = new Set<object>();

  const isOpen = (path: string, depth: number) =>
    options.overrides.get(path) ?? depth < options.expandDepth;

  const emit = (row: InspectorRow): boolean => {
    if (rows.length >= options.maxRows) {
      clipped = true;
      return false;
    }
    rows.push(row);
    return true;
  };

  // `filtering` is false below a container whose own key matched: its whole
  // subtree is what was asked for, so it is shown as it is, unfiltered.
  const visitValue = (
    child: {
      key: string | null;
      keyKind: InspectorRow["keyKind"];
      value: unknown;
      pointer: string;
      copyPath: string;
    },
    depth: number,
    posInSet: number,
    setSize: number,
    filtering: boolean
  ) => {
    const circular =
      typeof child.value === "object" && child.value !== null && stack.has(child.value);
    const kind: ValueKind = circular ? "circular" : kindOf(child.value);
    const container = isContainer(kind);
    const selfMatch = matcher ? matcher.selfMatches(child.key, child.value, kind) : false;
    const descendantMatch =
      matcher && filtering ? matcher.below(child.value, kind, new Set(stack), depth) : false;
    if (filtering && matcher && !selfMatch && !descendantMatch && depth > 0) return;
    const hasChildren = container && childCount(child.value, kind) > 0;
    // The root's pointer is "", so it never meets the "/" of an empty key.
    const path = child.pointer;
    const open = hasChildren && (filtering && descendantMatch ? true : isOpen(path, depth));
    const full = options.expandedStrings.has(path);
    const preview = previewOf(child.value, kind, options.maxStringLength, full);
    if (
      !emit({
        path,
        name: child.key ?? "",
        depth,
        isDirectory: hasChildren,
        isExpanded: open,
        isLoading: false,
        key: child.key,
        keyKind: child.keyKind,
        kind,
        value: child.value,
        copyPath: child.copyPath,
        preview: preview.text,
        truncated: preview.truncated,
        posInSet,
        setSize,
        match: selfMatch,
      })
    ) {
      return;
    }
    if (!open || depth >= MAX_DEPTH) return;
    const object = child.value;
    if (typeof object !== "object" || object === null) return;
    stack.add(object);
    const children = childrenOf(object, child.pointer, child.copyPath, options.sortKeys);
    const keepFiltering = filtering && !selfMatch;
    if ((kind === "array" || kind === "set") && children.length > chunk) {
      visitRanges(children, path, depth + 1, keepFiltering);
    } else {
      visitChildren(children, depth + 1, keepFiltering);
    }
    stack.delete(object);
  };

  const visitChildren = (children: readonly Child[], depth: number, filtering: boolean) => {
    const shown = filtering && matcher ? children.filter((child) => survives(child)) : children;
    shown.forEach((child, index) => {
      if (!clipped) visitValue(child, depth, index + 1, shown.length, filtering);
    });
  };

  const survives = (child: Child): boolean => {
    if (!matcher) return true;
    const circular =
      typeof child.value === "object" && child.value !== null && stack.has(child.value);
    const kind = circular ? "circular" : kindOf(child.value);
    return (
      matcher.selfMatches(child.key, child.value, kind) ||
      matcher.below(child.value, kind, new Set(stack), 0)
    );
  };

  // A big array in ranges of `chunk`, each its own disclosure, nested again
  // when one range would still hold more than `chunk` ranges.
  const visitRanges = (
    children: readonly Child[],
    parentPath: string,
    depth: number,
    filtering: boolean
  ) => {
    let span = chunk;
    while (Math.ceil(children.length / span) > chunk) span *= chunk;
    const ranges: { start: number; end: number }[] = [];
    for (let start = 0; start < children.length; start += span) {
      const end = Math.min(children.length, start + span) - 1;
      const slice = children.slice(start, end + 1);
      if (filtering && matcher && !slice.some(survives)) continue;
      ranges.push({ start, end });
    }
    ranges.forEach(({ start, end }, index) => {
      if (clipped) return;
      // Labelled by the items' own indices, which nested ranges keep.
      const first = children[start]?.key ?? String(start);
      const last = children[end]?.key ?? String(end);
      const path = `${parentPath}/@${first}-${last}`;
      const label = `[${first} … ${last}]`;
      const forced = filtering && matcher !== null;
      const open = forced
        ? true
        : (options.overrides.get(path) ?? options.expandDepth === Infinity);
      if (
        !emit({
          path,
          name: label,
          depth,
          isDirectory: true,
          isExpanded: open,
          isLoading: false,
          key: label,
          keyKind: "range",
          kind: "array",
          value: children.slice(start, end + 1).map((child) => child.value),
          copyPath: "",
          preview: "",
          truncated: false,
          posInSet: index + 1,
          setSize: ranges.length,
          match: false,
        })
      ) {
        return;
      }
      if (!open) return;
      const slice = children.slice(start, end + 1);
      if (end - start + 1 > chunk) visitRanges(slice, path, depth + 1, filtering);
      else visitChildren(slice, depth + 1, filtering);
    });
  };

  const rootKind = kindOf(value);
  const matched = matcher
    ? matcher.selfMatches(options.name, value, rootKind) ||
      matcher.below(value, rootKind, new Set(), 0)
    : true;
  visitValue(
    {
      key: options.name,
      keyKind: "root",
      value,
      pointer: "",
      copyPath: options.name && IDENTIFIER.test(options.name) ? options.name : "",
    },
    0,
    1,
    1,
    matcher !== null
  );
  return { rows, clipped, matched };
}

function childCount(value: unknown, kind: ValueKind): number {
  if (kind === "circular") return 0;
  if (Array.isArray(value)) return value.length;
  if (value instanceof Map || value instanceof Set) return value.size;
  if (kind === "object" && typeof value === "object" && value !== null) {
    return safeKeys(value).length;
  }
  return 0;
}

/**
 * Plain JSON data for `value`: Maps as objects, Sets as arrays, bigints as
 * text, and a value inside itself as "[Circular]". Only ancestors count as a
 * cycle, so the same object reached twice by different paths is copied twice.
 */
function toPlain(value: unknown, stack: Set<object>, depth: number): unknown {
  if (typeof value === "bigint") return value.toString();
  if (typeof value !== "object" || value === null) return value;
  if (stack.has(value)) return "[Circular]";
  if (depth > MAX_DEPTH) return null;
  if (value instanceof Date) return value;
  stack.add(value);
  let out: unknown;
  if (Array.isArray(value) || value instanceof Set) {
    out = [...value].map((item) => toPlain(item, stack, depth + 1));
  } else if (value instanceof Map) {
    // No prototype, so a "__proto__" key is copied as the property it is.
    const record: Record<string, unknown> = Object.create(null);
    for (const [key, item] of value) record[safeString(key)] = toPlain(item, stack, depth + 1);
    out = record;
  } else {
    // No prototype, so a "__proto__" key is copied as the property it is.
    const record: Record<string, unknown> = Object.create(null);
    for (const key of safeKeys(value)) record[key] = toPlain(safeGet(value, key), stack, depth + 1);
    out = record;
  }
  stack.delete(value);
  return out;
}

/** What "Copy value" puts on the clipboard: a string's own text, anything else as JSON. */
export function copyTextOf(value: unknown, kind: ValueKind): string {
  if (typeof value === "string") return value;
  if (kind === "circular") return "[Circular]";
  if (kind === "undefined") return "undefined";
  if (kind === "bigint") return safeString(value);
  if (kind === "function" || kind === "symbol") return previewOf(value, kind, Infinity, true).text;
  try {
    return JSON.stringify(toPlain(value, new Set(), 0), null, 2) ?? "";
  } catch {
    return safeString(value);
  }
}
