/// <reference lib="dom" />
/**
 * Reads Svelte's dev-runtime stamp, `__svelte_meta`, off a node. The stamp and
 * its whole frame chain belong to the page: any property can be a throwing
 * getter, any value can be the wrong type, and the chain can loop. Every read
 * below goes through {@link field}, and every walk is bounded by links visited,
 * not frames kept, so a chain of junk costs no more than a chain of frames.
 */

/** Restated from `EVIDENCE_LIMITS` and the source schemas: a value import would bundle zod into the page. */
export const SVELTE_LIMITS = {
  /** Frames one ancestry keeps. */
  ancestry: 64,
  /** Parent links walked per read, however few of them are usable. */
  links: 512,
  /** DOM ancestors walked looking for a stamp; real nesting is far shallower. */
  ancestors: 512,
  /** A frame's or a structure's file: the evidence schema's bound. */
  file: 1024,
  /** An element's own template location: the source candidate schema's bound. */
  locFile: 2048,
  type: 32,
  componentTag: 128,
  tag: 64,
  /** Elements a document sweep looks at before it stops and says so. */
  scan: 20_000,
  occurrences: 100_000,
  coordinate: 10_000_000,
} as const;

export interface SvelteLoc {
  file: string;
  line: number;
  column: number;
}

export interface SvelteFrame extends SvelteLoc {
  type: string;
  componentTag?: string;
}

/**
 * One property of a page-owned object. Read from inside a pointer move or a
 * click, where an uncaught throw from a hostile getter would cost the user
 * their picker.
 */
export function field(source: unknown, key: string): unknown {
  if (source === null || (typeof source !== "object" && typeof source !== "function")) {
    return undefined;
  }
  try {
    return (source as Record<string, unknown>)[key];
  } catch {
    return undefined;
  }
}

export function readMeta(node: Element): object | null {
  let meta: unknown;
  try {
    meta = (node as unknown as { __svelte_meta?: unknown }).__svelte_meta;
  } catch {
    return null;
  }
  return meta !== null && typeof meta === "object" ? meta : null;
}

/** The frame a stamp or another frame names, as an object or null. */
export function parentFrame(source: unknown): object | null {
  const parent = field(source, "parent");
  return parent !== null && typeof parent === "object" ? parent : null;
}

function coordinate(value: unknown, min: number): number | null {
  return typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= min &&
    value <= SVELTE_LIMITS.coordinate
    ? value
    : null;
}

/**
 * A source path is identity, not display text: a clamped one would name a
 * different file. Reported whole or not at all.
 */
function file(value: unknown, max: number): string | null {
  return typeof value === "string" && value.length > 0 && value.length <= max ? value : null;
}

function name(value: unknown, max: number): string | null {
  return typeof value === "string" && value.length > 0 && value.length <= max ? value : null;
}

function readPosition(source: unknown, maxFile: number): SvelteLoc | null {
  const path = file(field(source, "file"), maxFile);
  const line = coordinate(field(source, "line"), 1);
  const column = coordinate(field(source, "column"), 0);
  if (path === null || line === null || column === null) return null;
  return { file: path, line, column };
}

/** The element's own template location, when its stamp has a usable one. */
export function readLoc(node: Element): SvelteLoc | null {
  const meta = readMeta(node);
  return meta === null ? null : readPosition(field(meta, "loc"), SVELTE_LIMITS.locFile);
}

export function sameLoc(a: SvelteLoc, b: SvelteLoc): boolean {
  return a.file === b.file && a.line === b.line && a.column === b.column;
}

export function locKey(loc: SvelteLoc): string {
  return loc.file + ":" + loc.line + ":" + loc.column;
}

/** One frame in the shape the evidence schema takes, or null when any part of it is unusable. */
export function readFrame(frame: object): SvelteFrame | null {
  const type = name(field(frame, "type"), SVELTE_LIMITS.type);
  const position = readPosition(frame, SVELTE_LIMITS.file);
  if (type === null || position === null) return null;
  const componentTag = name(field(frame, "componentTag"), SVELTE_LIMITS.componentTag);
  return componentTag === null ? { type, ...position } : { type, ...position, componentTag };
}

/** Walks out of shadow roots too, so a slotted node still names an owner. */
export function parentOf(node: Element): Element | null {
  if (node.parentElement !== null) return node.parentElement;
  const root = node.getRootNode();
  return root instanceof ShadowRoot ? root.host : null;
}

/** Bounded, so deep generated markup costs a hover no more than a fixed walk. */
export function nearestMapped(start: Element | null): Element | null {
  let node = start;
  for (let depth = 0; node !== null && depth < SVELTE_LIMITS.ancestors; depth += 1) {
    if (readLoc(node) !== null) return node;
    node = parentOf(node);
  }
  return null;
}

/**
 * The frames above a stamp, innermost first, as objects: the page's own frame
 * objects are the identity of a block or an invocation, which two copies drawn
 * from one line share in everything but that.
 */
export function frameObjects(meta: object | null, limit: number = SVELTE_LIMITS.links): object[] {
  const frames: object[] = [];
  const seen = new Set<object>();
  for (
    let current = meta === null ? null : parentFrame(meta);
    current !== null && frames.length < limit;
    current = parentFrame(current)
  ) {
    if (seen.has(current)) break;
    seen.add(current);
    frames.push(current);
  }
  return frames;
}

/**
 * The verbatim chain for the evidence: usable frames kept, malformed ones
 * dropped rather than the whole chain, and `truncated` when the walk hit
 * either bound before the chain ended.
 */
export function readAncestry(meta: object | null): { frames: SvelteFrame[]; truncated: boolean } {
  const frames: SvelteFrame[] = [];
  const objects = frameObjects(meta, SVELTE_LIMITS.links + 1);
  let truncated = objects.length > SVELTE_LIMITS.links;
  for (const object of objects.slice(0, SVELTE_LIMITS.links)) {
    const frame = readFrame(object);
    if (frame === null) continue;
    if (frames.length >= SVELTE_LIMITS.ancestry) {
      truncated = true;
      break;
    }
    frames.push(frame);
  }
  return { frames, truncated };
}

/**
 * The component invocations that rendered a node, innermost first. An
 * unstamped element belongs to its nearest stamped ancestor's template, and so
 * to that template's invocations.
 */
export function componentFrames(node: Element): object[] {
  return invocationsOf(node).frames;
}

/** {@link componentFrames}, and whether the walk stopped at its bound before the chain ended. */
export function invocationsOf(node: Element): { frames: object[]; truncated: boolean } {
  const meta = readMeta(node) ?? readMeta(nearestMapped(node) ?? node);
  const objects = frameObjects(meta, SVELTE_LIMITS.links + 1);
  return {
    frames: objects
      .slice(0, SVELTE_LIMITS.links)
      .filter((frame) => field(frame, "type") === "component"),
    truncated: objects.length > SVELTE_LIMITS.links,
  };
}
