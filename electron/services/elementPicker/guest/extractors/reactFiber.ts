/// <reference lib="dom" />
/**
 * React 19's fiber tree as a stock dev build leaves it on the DOM, read from
 * outside React. Nothing here imports React or calls into it: every value is
 * page data, may be missing, renamed or shaped by a different version, and is
 * read through `field`, which turns a throwing getter into an absent value.
 *
 * Fibers come in pairs, the committed one and its alternate, and React swaps
 * them on every render. A host node's `__reactFiber$` key is set when the node
 * is created and never moved, so it can name either half; so can a `return`
 * pointer, since a subtree that bailed out keeps pointing at its parent's old
 * half. Identity therefore covers the pair, and anything read from `child` or
 * `sibling` starts from the committed half.
 */

export type Fiber = Record<string, unknown>;

export const FIBER_KEY_PREFIX = "__reactFiber$";

export const FIBER_TAGS = {
  functionComponent: 0,
  classComponent: 1,
  hostRoot: 3,
  hostPortal: 4,
  hostComponent: 5,
  hostText: 6,
  forwardRef: 11,
  suspense: 13,
  memo: 14,
  simpleMemo: 15,
  dehydratedFragment: 18,
  offscreen: 22,
  hostHoistable: 26,
  hostSingleton: 27,
} as const;

const COMPONENT_TAGS: ReadonlySet<number> = new Set([
  FIBER_TAGS.functionComponent,
  FIBER_TAGS.classComponent,
  FIBER_TAGS.forwardRef,
  FIBER_TAGS.memo,
  FIBER_TAGS.simpleMemo,
]);

const HOST_TAGS: ReadonlySet<number> = new Set([
  FIBER_TAGS.hostComponent,
  FIBER_TAGS.hostHoistable,
  FIBER_TAGS.hostSingleton,
]);

const MAX_NAME_CHARS = 256;
/** memo(forwardRef(fn)) and memo(memo(fn)) are as deep as React nests a component type. */
const MAX_TYPE_DEPTH = 4;
/** Memos nested in memos: far past anything written, short of a loop. */
const MAX_MEMO_DEPTH = 16;
/** DOM parents tried when the picked node is not one React rendered. */
const MAX_DOM_ANCESTORS = 64;

/**
 * An allowance of steps. A budget with a parent spends from both, so one walk
 * can be held to its own share of an allowance several walks draw on.
 */
export class Budget {
  constructor(
    private left: number,
    private readonly parent: Budget | null = null
  ) {}
  spend(): boolean {
    if (this.left <= 0 || (this.parent !== null && !this.parent.spend())) return false;
    this.left -= 1;
    return true;
  }
}

export function field(value: unknown, key: string): unknown {
  if ((typeof value !== "object" && typeof value !== "function") || value === null) {
    return undefined;
  }
  try {
    return (value as Record<string, unknown>)[key];
  } catch {
    return undefined;
  }
}

export function isFiber(value: unknown): value is Fiber {
  return typeof value === "object" && value !== null && typeof field(value, "tag") === "number";
}

function fiberField(fiber: Fiber, key: string): Fiber | null {
  const value = field(fiber, key);
  return isFiber(value) ? value : null;
}

export function tagOf(fiber: Fiber): number {
  return field(fiber, "tag") as number;
}

export function parentOf(fiber: Fiber): Fiber | null {
  return fiberField(fiber, "return");
}

export function isComponentFiber(fiber: Fiber): boolean {
  return COMPONENT_TAGS.has(tagOf(fiber));
}

/**
 * The fiber React created for `node` itself, or null for a node it did not
 * render. Keys are scanned by prefix: React suffixes them with a random string
 * per copy of react-dom.
 */
export function ownFiberOf(node: Element): Fiber | null {
  let keys: string[];
  try {
    keys = Object.keys(node);
  } catch {
    return null;
  }
  for (const key of keys) {
    if (!key.startsWith(FIBER_KEY_PREFIX)) continue;
    const value = field(node, key);
    return isFiber(value) ? value : null;
  }
  return null;
}

/**
 * The picked node's fiber, or its nearest rendered ancestor's: a chart's
 * canvas or a widget's markup inside a component still belongs to it.
 * `own` says which, since only the node's own fiber says where it was created.
 */
export function hostFiberOf(node: Element): { fiber: Fiber; own: boolean } | null {
  let current: Node | null = node;
  for (let depth = 0; depth < MAX_DOM_ANCESTORS && current !== null; depth += 1) {
    if (current instanceof Element) {
      const fiber = ownFiberOf(current);
      if (fiber !== null) return { fiber, own: depth === 0 };
    }
    const parent: Node | null = current.parentNode;
    current = parent instanceof ShadowRoot ? parent.host : parent;
  }
  return null;
}

/**
 * Which half of `fiber`'s pair is committed, by React's own
 * `findCurrentFiberUsingSlowPath`: walk both lineages up until a parent's
 * children say which one it holds, or to the root, whose `current` decides.
 * Where React would throw — an unmounted subtree, a return pointer that lies —
 * or the budget runs out, the fiber is kept as it came.
 */
export function committedFiber(fiber: Fiber, budget: Budget): Fiber {
  const alternate = fiberField(fiber, "alternate");
  if (alternate === null) return fiber;
  let a: Fiber = fiber;
  let b: Fiber = alternate;
  for (;;) {
    if (!budget.spend()) return fiber;
    const parentA = parentOf(a);
    if (parentA === null) break;
    const parentB = fiberField(parentA, "alternate");
    if (parentB === null) {
      const next = parentOf(parentA);
      if (next === null) break;
      a = b = next;
      continue;
    }
    if (field(parentA, "child") === field(parentB, "child")) {
      for (let child = fiberField(parentA, "child"); child !== null;) {
        if (!budget.spend()) return fiber;
        if (child === a) return fiber;
        if (child === b) return alternate;
        child = fiberField(child, "sibling");
      }
      return fiber;
    }
    if (field(a, "return") !== field(b, "return")) {
      a = parentA;
      b = parentB;
    } else {
      let found = false;
      for (const [parent, other] of [
        [parentA, parentB],
        [parentB, parentA],
      ] as const) {
        for (let child = fiberField(parent, "child"); child !== null;) {
          if (!budget.spend()) return fiber;
          if (child === a) {
            a = parent;
            b = other;
            found = true;
            break;
          }
          if (child === b) {
            b = parent;
            a = other;
            found = true;
            break;
          }
          child = fiberField(child, "sibling");
        }
        if (found) break;
      }
      if (!found) return fiber;
    }
    if (field(a, "alternate") !== b) return fiber;
  }
  if (tagOf(a) !== FIBER_TAGS.hostRoot) return fiber;
  return field(field(a, "stateNode"), "current") === a ? fiber : alternate;
}

/**
 * A memo with a custom compare (tag 14) renders its component as a child
 * fiber React makes for it, owned by the memo and created from no element of
 * the page's. The pair are one component instance, named and placed by the
 * memo, so the child stands for its memo wherever it appears.
 */
export function canonicalFiber(fiber: Fiber): Fiber {
  let canonical = fiber;
  // memo(memo(fn)) nests one implementation inside another.
  for (let depth = 0; depth < MAX_MEMO_DEPTH; depth += 1) {
    const parent = parentOf(canonical);
    if (parent === null || tagOf(parent) !== FIBER_TAGS.memo) break;
    canonical = parent;
  }
  return canonical;
}

export function isMemoImplementation(fiber: Fiber): boolean {
  return canonicalFiber(fiber) !== fiber;
}

/**
 * The first fiber below `component` that the component's own render created
 * from an element, so its `_debugStack` was captured while that render ran.
 * Text, implicit fragments and anything passed in as children are skipped:
 * the first carry no stack, and children were made by whoever passed them. A
 * memo's implementation renders on its memo's behalf. Null when the component
 * made nothing of its own within the budget.
 */
export function ownedElementFiber(component: Fiber, budget: Budget): Fiber | null {
  const halves = new Set<Fiber>([component]);
  const alternate = fiberField(component, "alternate");
  if (alternate !== null) halves.add(alternate);
  const pending: Fiber[] = [];
  const first = fiberField(component, "child");
  if (first !== null) pending.push(first);
  while (pending.length > 0) {
    if (!budget.spend()) return null;
    const fiber = pending.pop()!;
    const sibling = fiberField(fiber, "sibling");
    if (sibling !== null) pending.push(sibling);
    const owner = fiberField(fiber, "_debugOwner");
    if (
      owner !== null &&
      halves.has(canonicalFiber(owner)) &&
      field(fiber, "_debugStack") != null
    ) {
      return fiber;
    }
    const child = fiberField(fiber, "child");
    if (child !== null) pending.push(child);
  }
  return null;
}

/** The innermost component above `fiber`, the memo standing for its implementation. */
export function nearestComponent(fiber: Fiber, budget: Budget): Fiber | null {
  for (let next = parentOf(fiber); next !== null && budget.spend(); next = parentOf(next)) {
    if (tagOf(next) === FIBER_TAGS.hostRoot) return null;
    if (isComponentFiber(next)) return canonicalFiber(next);
  }
  return null;
}

/** Mints one id per component instance, whichever half of its pair is asked about. */
export class FiberIds {
  private readonly ids = new WeakMap<object, string>();
  private next = 0;

  constructor(private readonly prefix: string) {}

  idOf(fiber: Fiber): string {
    const canonical = canonicalFiber(fiber);
    const alternate = fiberField(canonical, "alternate");
    let id = this.ids.get(canonical) ?? (alternate === null ? undefined : this.ids.get(alternate));
    if (id === undefined) {
      this.next += 1;
      id = this.prefix + this.next;
    }
    this.ids.set(canonical, id);
    if (alternate !== null) this.ids.set(alternate, id);
    return id;
  }
}

export interface FiberName {
  value: string;
  /** The property path the name was read from, relative to the fiber. */
  field: string;
}

function stringAt(value: unknown, key: string, path: string): FiberName | null {
  const read = field(value, key);
  if (typeof read !== "string" || read.length === 0) return null;
  return { value: read.slice(0, MAX_NAME_CHARS), field: path };
}

/** A component type's own name: what `displayName` or the function says it is. */
function typeName(type: unknown, path: string, depth = 0): FiberName | null {
  if (typeof type === "function") {
    return (
      stringAt(type, "displayName", `${path}.displayName`) ?? stringAt(type, "name", `${path}.name`)
    );
  }
  if (typeof type !== "object" || type === null || depth >= MAX_TYPE_DEPTH) return null;
  const own = stringAt(type, "displayName", `${path}.displayName`);
  if (own !== null) return own;
  // forwardRef({ render }) and memo({ type }), the same order React names them in.
  const render = field(type, "render");
  if (typeof render === "function") return typeName(render, `${path}.render`, depth + 1);
  return typeName(field(type, "type"), `${path}.type`, depth + 1);
}

/**
 * A component fiber's name, with where it came from. Null is an anonymous
 * component, not one whose name could not be read. A simple memo (tag 15)
 * keeps the memo on `elementType` and the function on `type`; the memo's own
 * `displayName` wins, as it does in React.
 */
export function componentName(fiber: Fiber): FiberName | null {
  if (tagOf(fiber) === FIBER_TAGS.simpleMemo) {
    const memo = stringAt(field(fiber, "elementType"), "displayName", "elementType.displayName");
    if (memo !== null) return memo;
  }
  return typeName(field(fiber, "type"), "type");
}

export function isHostFiber(fiber: Fiber): boolean {
  return HOST_TAGS.has(tagOf(fiber));
}

function isHidden(fiber: Fiber): boolean {
  const tag = tagOf(fiber);
  if (tag === FIBER_TAGS.offscreen) return field(fiber, "memoizedState") != null;
  return false;
}

/** Rendered markup React has not hydrated yet: there are nodes, but no fibers for them. */
function isDehydrated(fiber: Fiber): boolean {
  const tag = tagOf(fiber);
  if (tag === FIBER_TAGS.dehydratedFragment) return true;
  if (tag === FIBER_TAGS.suspense)
    return field(field(fiber, "memoizedState"), "dehydrated") != null;
  return false;
}

export interface HostRoots {
  elements: Element[];
  complete: boolean;
}

/**
 * The outermost DOM elements a component rendered, in fiber order. The walk
 * covers the whole committed subtree rather than stopping at the first host
 * layer: a portal below a host node renders into another container, and a
 * hoisted `<title>` or `<meta>` lands in `<head>`, so each is a root of its own
 * wherever it sits in the tree. An element inside one already collected is
 * covered by it, whichever came first, and so is text inside one.
 *
 * A hidden Activity or Suspense subtree is skipped: its nodes are not on
 * screen. Uncovered text, unhydrated markup, a node from another realm, or a
 * walk cut short by `limit` or the budget leaves the list incomplete rather
 * than wrong. A stylesheet resource has no node of its own and is no root.
 */
export function hostRoots(component: Fiber, limit: number, budget: Budget): HostRoots {
  let elements: Element[] = [];
  let complete = true;
  const covered = (node: Node): boolean =>
    elements.some((root) => root === node || root.contains(node));
  /** Text outside every root collected so far; a root found later can still cover it. */
  const loose: Node[] = [];
  const pending: Array<{ fiber: Fiber; cover: Node | null }> = [];
  const first = fiberField(component, "child");
  if (first !== null) pending.push({ fiber: first, cover: null });
  while (pending.length > 0) {
    if (!budget.spend()) return { elements, complete: false };
    const { fiber, cover } = pending.pop()!;
    const sibling = fiberField(fiber, "sibling");
    if (sibling !== null) pending.push({ fiber: sibling, cover });
    const tag = tagOf(fiber);
    let childCover = cover;
    // Page values: an `instanceof` or `contains` on a hostile one can throw.
    try {
      if (HOST_TAGS.has(tag)) {
        const node = field(fiber, "stateNode");
        if (node instanceof Element) {
          if (!covered(node)) {
            elements = elements.filter((root) => !node.contains(root));
            if (elements.length >= limit) return { elements, complete: false };
            elements.push(node);
          }
          childCover = node;
        } else if (!(node === null && tag === FIBER_TAGS.hostHoistable)) {
          if (cover === null) complete = false;
        }
      } else if (tag === FIBER_TAGS.hostText) {
        if (cover === null) {
          const text = field(fiber, "stateNode");
          if (text instanceof Node) loose.push(text);
          else complete = false;
        }
      } else if (tag === FIBER_TAGS.hostPortal) {
        // Its children land in its container, covered only if that is.
        const container = field(field(fiber, "stateNode"), "containerInfo");
        childCover = container instanceof Node && covered(container) ? container : null;
      } else if (isDehydrated(fiber)) {
        complete = false;
        continue;
      } else if (isHidden(fiber)) {
        continue;
      }
    } catch {
      complete = false;
      continue;
    }
    const child = fiberField(fiber, "child");
    if (child !== null) pending.push({ fiber: child, cover: childCover });
  }
  try {
    if (loose.some((text) => !covered(text))) complete = false;
  } catch {
    complete = false;
  }
  return { elements, complete };
}
