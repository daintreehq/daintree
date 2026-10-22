/// <reference lib="dom" />
/**
 * Where a node sits in its template, by shape rather than by the location
 * stamped on it. Svelte assigns `loc` by walking a template's rendered
 * siblings, and on a hydrated page that walk also meets the root a child
 * component rendered just before — so from there on every element carries
 * its neighbour's location, and the last ones carry none. The frame
 * (`__svelte_meta.parent`, one object per block or invocation) and each
 * element's index among the siblings that share it are not assigned that
 * way, and the host can walk the source by them.
 *
 * Siblings of another frame — a child component's root, a block's contents —
 * are not this template's elements and are not counted. An unstamped element
 * is counted as the template's own only where the hydration walk leaves them:
 * a trailing run after stamped siblings of the frame, or anywhere under a
 * parent that is itself unstamped; a stamped sibling after an unstamped one
 * means the unstamped one is not the template's, and nothing is reported.
 */

import {
  SVELTE_LIMITS,
  field,
  nearestMapped,
  parentFrame,
  parentOf,
  readLoc,
  readMeta,
} from "./meta.js";

export interface SvelteStructure {
  file: string;
  path: Array<{ tag: string; index: number }>;
}

/** Levels a structural path may run, and siblings a level may be counted over. */
const MAX_DEPTH = 64;
const MAX_SIBLINGS = 5_000;

/**
 * What lies between `frame` and `ancestor` on the parent chain: nothing but
 * blocks, a component frame, or a `{@render}` — or no `ancestor` at all. A
 * rendered snippet is the one region Svelte's server output does not
 * bracket, so the template around it walks straight through the snippet's
 * elements while stamping its own: everything after such a region may carry
 * the wrong location and the wrong frame, and nothing at that level can be
 * placed by shape.
 */
function framesBetween(
  frame: unknown,
  ancestor: unknown
): "blocks" | "component" | "render" | "none" {
  let current: unknown = frame;
  let rendered = false;
  let component = false;
  for (let hops = 0; hops < SVELTE_LIMITS.links; hops += 1) {
    if (current === ancestor) return rendered ? "render" : component ? "component" : "blocks";
    if (current === null || current === undefined || typeof current !== "object") return "none";
    const type = field(current, "type");
    // The sibling's own frame counts when it is a rendered snippet's: that
    // element was rendered inline here, and the walk went through it. Its own
    // component frame does not: a child component's root is expected.
    if (type === "render" || type === "snippet") rendered = true;
    else if (hops > 0 && type === "component") component = true;
    current = parentFrame(current);
  }
  return "none";
}

/**
 * The shape is an extra. Every `__svelte_meta` read is guarded on its own,
 * but the walk also reads the page's DOM, where an upgraded custom element can
 * throw from a property of its own, and a click must not die for it.
 */
export function structureOf(target: Element): SvelteStructure | undefined {
  try {
    return structurePath(target);
  } catch {
    return undefined;
  }
}

interface Kinship {
  stamped: boolean;
  same: boolean;
  foreign: boolean;
  rendered: boolean;
}

function structurePath(target: Element): SvelteStructure | undefined {
  // `<svelte:head>` renders into the head, where the template's order says nothing.
  const head = target.ownerDocument.head;
  if (head !== null && head.contains(target)) return undefined;
  // The nearest stamped element: the target itself, or the ancestor an
  // unstamped target takes its template and frame from.
  const anchor = nearestMapped(target);
  if (anchor === null) return undefined;
  const anchorLoc = readLoc(anchor);
  const meta = readMeta(anchor);
  if (anchorLoc === null || meta === null) return undefined;
  // A location the evidence cannot carry whole is not one to place against.
  if (anchorLoc.file.length > SVELTE_LIMITS.file) return undefined;
  const frame = parentFrame(meta);
  const frameOf = (node: Element): Kinship => {
    const other = readMeta(node);
    if (other === null) return { stamped: false, same: false, foreign: false, rendered: false };
    const theirs = parentFrame(other);
    const between = theirs === frame ? "blocks" : framesBetween(theirs, frame);
    return {
      stamped: true,
      same: theirs === frame,
      foreign: between !== "blocks" && between !== "render",
      rendered: between === "render",
    };
  };
  const path: SvelteStructure["path"] = [];
  let node: Element = target;
  let reachedRoot = false;
  for (let depth = 0; depth < MAX_DEPTH; depth += 1) {
    const parent = parentOf(node);
    const own = frameOf(node);
    const parentStamped = parent !== null && frameOf(parent).stamped;
    // Walked by sibling links, not indexed: a live collection is rebuilt per
    // index in some DOMs, and a wide parent made that quadratic. Comments are
    // walked too, for an unstamped node: the server output brackets every
    // block in `<!--[-->` … `<!--]-->`, and the hydration walk skips what is
    // inside, so an unstamped node found inside a region is a block's dropped
    // element, not this template's, and unstamped content inside a region
    // before it is not counted. A stamped node needs none of this: its frame
    // says which block it belongs to, and its own template's roots may well
    // sit inside an enclosing template's region (a `{@render children()}`).
    let child: ChildNode | null = parent === null ? node : parent.firstChild;
    let index = 0;
    let found = false;
    let scanned = 0;
    let unstampedBefore = false;
    let region = 0;
    // A stamped sibling under a frame that is not the anchor's nor inside it:
    // the anchor is an enclosing component's element, and an unstamped node
    // beside such siblings is one of THEIR template's dropped roots, not the
    // anchor's. Nothing here can say which, so nothing is said.
    const foreignBeside = (kin: Kinship): boolean =>
      !own.stamped && parentStamped && kin.stamped && kin.foreign;
    while (child !== null) {
      if (child === node) {
        if (region > 0) return undefined;
        found = true;
        break;
      }
      if (++scanned > MAX_SIBLINGS) return undefined;
      if (child.nodeType === 8 && !own.stamped) {
        const data = (child as Comment).data;
        if (data.charAt(0) === "[") region += 1;
        else if (data.charAt(0) === "]" && region > 0) region -= 1;
      } else if (child.nodeType === 1 && region === 0) {
        const kin = frameOf(child as Element);
        if (foreignBeside(kin)) return undefined;
        // A snippet rendered inline before this node: the template's walk went
        // through it, and this node's stamp and frame may be its own
        // template's or the snippet's. Not placeable either way.
        if (kin.rendered) return undefined;
        if (kin.same) {
          // A stamped sibling after an unstamped one: the unstamped one was
          // never the template's, and the count is off by it.
          if (unstampedBefore) return undefined;
          index += 1;
        } else if (!kin.stamped) {
          // Under a stamped parent the template's unstamped elements are the
          // tail of the run; a stamped node preceded by one is not placeable.
          if (parentStamped && own.stamped) return undefined;
          unstampedBefore = true;
          index += 1;
        }
      }
      child = child.nextSibling;
    }
    if (!found) return undefined;
    // An unstamped node is the template's only at the tail of the stamped run:
    // a stamped sibling of the frame after it says otherwise.
    if (!own.stamped && parentStamped) {
      let inner = 0;
      for (let after = node.nextSibling; after !== null; after = after.nextSibling) {
        if (++scanned > MAX_SIBLINGS) return undefined;
        if (after.nodeType === 8) {
          const data = (after as Comment).data;
          if (data.charAt(0) === "[") inner += 1;
          else if (data.charAt(0) === "]" && inner > 0) inner -= 1;
        } else if (after.nodeType === 1 && inner === 0) {
          const kin = frameOf(after as Element);
          if (kin.same || foreignBeside(kin)) return undefined;
        }
      }
    }
    // Lowercased as the plugin's host matched it against the template.
    const tag = node.tagName.toLowerCase();
    if (tag.length === 0 || tag.length > SVELTE_LIMITS.tag) return undefined;
    path.unshift({ tag, index });
    if (parent === null) {
      reachedRoot = true;
      break;
    }
    const above = frameOf(parent);
    if (above.stamped) {
      if (!above.same) {
        // The template's roots sit in a container of an enclosing template:
        // its frame is above the anchor's. A container whose frame is not — a
        // descendant component's element — holds markup that only inherited
        // the anchor's stamp, such as raw HTML the walk went into.
        const container = parentFrame(readMeta(parent));
        if (framesBetween(frame, container) === "none") return undefined;
        reachedRoot = true;
        break;
      }
      node = parent;
      continue;
    }
    // An unstamped parent below the anchor lost its stamp with the anchor's
    // subtree; one above it is beyond the template.
    if (parent !== anchor && anchor.contains(parent)) {
      node = parent;
      continue;
    }
    reachedRoot = true;
    break;
  }
  // Out of depth is not a path: a suffix of one names the wrong element.
  if (!reachedRoot) return undefined;
  return { file: anchorLoc.file, path };
}
