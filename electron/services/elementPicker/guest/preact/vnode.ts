/// <reference lib="dom" />
/**
 * Preact 11's vnode tree as a stock build leaves it reachable from the page,
 * read from outside Preact. Nothing here imports Preact or calls into it, and
 * nothing is read through a getter: every value is page data, taken only when
 * it is an own data property, so a read can never run the page's code.
 *
 * The tree hangs off its render container rather than off the nodes it drew:
 * `render()` and `hydrate()` set the container's own `__k` to a root Fragment
 * vnode, and a rendered node keeps no pointer back to the vnode that made it.
 * So a picked node is found by searching down from a container, guided by the
 * node's own DOM ancestry, and its components by walking `__` back up. The keys
 * are Preact's mangled internal names (`_children`, `_parent`, `_dom`,
 * `_component`), the same ones its devtools read, and they hold across a major.
 */

export type VNode = Record<string, unknown>;

const CHILDREN = "__k";
const PARENT = "__";
const DOM = "__e";
const COMPONENT = "__c";
/** A portal's `props._parentDom`: the node its children render into. */
const PORTAL_CONTAINER = "__P";

const MAX_NAME_CHARS = 256;
/** DOM parents walked from a picked node looking for its render container. */
const MAX_ANCESTRY = 256;
/** Containers remembered between lookups, so a portal's tree is found again on hover. */
const MAX_KNOWN_ROOTS = 32;
/** Elements a selection's sweep for render containers visits before it stops. */
const DISCOVERY_SAMPLE = 2_048;

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

/** `value[key]` when it is an own data property; an accessor is never invoked. */
export function own(value: unknown, key: string): unknown {
  if ((typeof value !== "object" && typeof value !== "function") || value === null) {
    return undefined;
  }
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor !== undefined && "value" in descriptor ? descriptor.value : undefined;
  } catch {
    return undefined;
  }
}

function hasOwn(value: object, key: string): boolean {
  try {
    return Object.prototype.hasOwnProperty.call(value, key);
  } catch {
    return false;
  }
}

function isArray(value: unknown): value is unknown[] {
  try {
    return Array.isArray(value);
  } catch {
    return false;
  }
}

function isNode(value: unknown): value is Node {
  try {
    return value instanceof Node;
  } catch {
    return false;
  }
}

/** Every vnode Preact makes carries these from birth, null or not. */
export function isVNode(value: unknown): value is VNode {
  if (typeof value !== "object" || value === null || isArray(value)) return false;
  return (
    hasOwn(value, "type") && hasOwn(value, CHILDREN) && hasOwn(value, PARENT) && hasOwn(value, DOM)
  );
}

export interface PreactRoot {
  container: Node;
  vnode: VNode;
  /** This copy of Preact's `Fragment`, which the root vnode is made of; minified, it has no name to go by. */
  fragment: unknown;
}

export function rootOf(node: Node): PreactRoot | null {
  const vnode = own(node, CHILDREN);
  if (!isVNode(vnode)) return null;
  const fragment = own(vnode, "type");
  if (typeof fragment !== "function") return null;
  return { container: node, vnode, fragment };
}

export type VNodeKind = "host" | "text" | "fragment" | "portal" | "context" | "component" | "other";

export function portalContainer(vnode: VNode): unknown {
  return own(own(vnode, "props"), PORTAL_CONTAINER);
}

/**
 * A context's provider (the context itself, as of Preact 11) or its consumer:
 * Preact's own plumbing, named only by its minified functions, and no more a
 * component of the app's than React's provider and consumer fibers are.
 */
function isContext(type: unknown): boolean {
  if (own(type, "Provider") === type) return true;
  const context = own(type, "contextType");
  return context !== undefined && own(context, "Consumer") === type;
}

export function kindOf(vnode: VNode, fragment: unknown): VNodeKind {
  const type = own(vnode, "type");
  if (typeof type === "string") return "host";
  if (type === null) return "text";
  if (typeof type !== "function") return "other";
  if (type === fragment) return "fragment";
  if (isNode(portalContainer(vnode))) return "portal";
  if (isContext(type)) return "context";
  return "component";
}

export function parentOf(vnode: VNode): VNode | null {
  const parent = own(vnode, PARENT);
  return isVNode(parent) ? parent : null;
}

export function domOf(vnode: VNode): unknown {
  return own(vnode, DOM);
}

/**
 * `vnode`'s children, at one step of `budget` per slot: the array keeps holes
 * and nulls where nothing rendered, and its length is page data too. Null when
 * the budget ran out before the last slot.
 */
export function childrenOf(vnode: VNode, budget: Budget): VNode[] | null {
  const children = own(vnode, CHILDREN);
  if (!isArray(children)) return [];
  const length = own(children, "length");
  if (typeof length !== "number") return [];
  const out: VNode[] = [];
  for (let index = 0; index < length; index += 1) {
    if (!budget.spend()) return null;
    const child = own(children, String(index));
    if (isVNode(child)) out.push(child);
  }
  return out;
}

/** Mints one id per component instance, which outlives the vnode each render makes for it. */
export class ComponentIds {
  private readonly ids = new WeakMap<object, string>();
  private next = 0;

  constructor(private readonly prefix: string) {}

  idOf(vnode: VNode): string {
    const instance = own(vnode, COMPONENT);
    const key = typeof instance === "object" && instance !== null ? instance : vnode;
    let id = this.ids.get(key);
    if (id === undefined) {
      this.next += 1;
      id = this.prefix + this.next;
      this.ids.set(key, id);
    }
    return id;
  }
}

export interface ObservedString {
  value: string;
  /** The property path it was read from, relative to the vnode. */
  field: string;
}

function stringAt(value: unknown, key: string, path: string): ObservedString | null {
  const read = own(value, key);
  if (typeof read !== "string" || read.length === 0) return null;
  return { value: read.slice(0, MAX_NAME_CHARS), field: path };
}

/** What `displayName` or the function says the component is; null for an anonymous one. */
export function componentName(vnode: VNode): ObservedString | null {
  const type = own(vnode, "type");
  return stringAt(type, "displayName", "type.displayName") ?? stringAt(type, "name", "type.name");
}

export interface SourceRead {
  source: unknown;
  field: "__source" | "props.__source";
}

/**
 * The jsx-source object for `vnode`. `jsxDEV` sets it on the vnode itself; a
 * `createElement` call the Babel plugin annotated leaves it in `props` unless
 * `preact/debug` was there to lift it out.
 */
export function sourceOf(vnode: VNode): SourceRead | null {
  const lifted = own(vnode, "__source");
  if (lifted !== undefined && lifted !== null) return { source: lifted, field: "__source" };
  const prop = own(own(vnode, "props"), "__source");
  if (prop !== undefined && prop !== null) return { source: prop, field: "props.__source" };
  return null;
}

/**
 * Whether `vnode` carries the prototype `preact/debug` gives every vnode, known
 * by its `nodeName` accessor: read as a descriptor, so the getter never runs.
 * Its absence says the page did not load debug, not that it is a production build.
 */
export function hasDebugPrototype(vnode: VNode): boolean {
  try {
    const prototype: unknown = Object.getPrototypeOf(vnode);
    if (prototype === null || prototype === Object.prototype) return false;
    const descriptor = Object.getOwnPropertyDescriptor(prototype, "nodeName");
    return descriptor !== undefined && typeof descriptor.get === "function";
  } catch {
    return false;
  }
}

/**
 * Render containers this extractor has seen, so the tree a portal belongs to
 * can be searched from content that sits nowhere inside it. Each is read
 * afresh when used: a container keeps its `__k`, but the page renders again.
 */
export class KnownRoots {
  private containers: Node[] = [];

  remember(nodes: readonly Node[]): void {
    for (const node of nodes) {
      if (this.containers.includes(node)) continue;
      this.containers.push(node);
      if (this.containers.length > MAX_KNOWN_ROOTS) this.containers.shift();
    }
  }

  /** The roots still in the document, other than those in `except`. */
  others(except: readonly PreactRoot[]): PreactRoot[] {
    this.containers = this.containers.filter((node) => node.isConnected);
    const out: PreactRoot[] = [];
    for (const node of this.containers) {
      if (except.some((root) => root.container === node)) continue;
      const root = rootOf(node);
      if (root !== null) out.push(root);
    }
    return out;
  }

  /** A bounded sweep of the document, open shadow roots included, for render containers. */
  discover(doc: Document): void {
    const start = doc.documentElement;
    if (start === null) return;
    const walker = doc.createTreeWalker(start, 1 /* NodeFilter.SHOW_ELEMENT */);
    const found: Node[] = [];
    let visited = 0;
    for (let node: Node | null = walker.currentNode; node !== null && visited < DISCOVERY_SAMPLE;) {
      visited += 1;
      if (rootOf(node) !== null) found.push(node);
      const shadow = node instanceof Element ? node.shadowRoot : null;
      if (shadow !== null && rootOf(shadow) !== null) found.push(shadow);
      node = walker.nextNode();
    }
    this.remember(found);
  }

  clear(): void {
    this.containers = [];
  }
}

export interface HostMatch {
  /** The host vnode for the picked node, or for its nearest ancestor Preact rendered. */
  vnode: VNode;
  root: PreactRoot;
  /** Whether `vnode` rendered the picked node itself, the only case its source describes it. */
  own: boolean;
}

export interface Lookup {
  match: HostMatch | null;
  /** The search stopped at its budget, so a closer match may exist than the one reported. */
  truncated: boolean;
}

function ancestryOf(node: Node): Node[] {
  const out: Node[] = [];
  let current: Node | null = node;
  while (current !== null && out.length < MAX_ANCESTRY) {
    out.push(current);
    // A shadow root is a node `render()` can target, so it is a step of its own.
    current = current instanceof ShadowRoot ? current.host : current.parentNode;
  }
  return out;
}

class Search {
  private readonly depths: Map<unknown, number>;
  best: HostMatch | null = null;
  private bestDepth = Infinity;
  truncated = false;

  constructor(
    private readonly target: Node,
    path: readonly Node[],
    private readonly budget: Budget
  ) {
    this.depths = new Map(path.map((node, depth) => [node, depth]));
  }

  /**
   * Down from `start` into only what can hold the target: a host vnode whose
   * node is not one of the target's ancestors renders nothing around it, and
   * neither does a portal into anywhere else. Components and fragments own no
   * node of their own, so they are always entered.
   */
  guided(start: VNode, root: PreactRoot): HostMatch | null {
    const pending: VNode[] = [start];
    while (pending.length > 0) {
      if (!this.budget.spend()) {
        this.truncated = true;
        return null;
      }
      const vnode = pending.pop()!;
      const kind = kindOf(vnode, root.fragment);
      if (kind === "text") continue;
      if (kind === "host") {
        const node = domOf(vnode);
        if (node === this.target) return { vnode, root, own: true };
        const depth = this.depths.get(node);
        if (depth === undefined) continue;
        if (depth < this.bestDepth) {
          this.bestDepth = depth;
          this.best = { vnode, root, own: false };
        }
      } else if (kind === "portal" && !this.depths.has(portalContainer(vnode))) {
        continue;
      }
      const children = childrenOf(vnode, this.budget);
      if (children === null) {
        this.truncated = true;
        return null;
      }
      pending.push(...children);
    }
    return null;
  }

  /** Every portal under `start` into one of the target's ancestors, wherever the portal sits. */
  portals(start: VNode, root: PreactRoot): VNode[] {
    const found: VNode[] = [];
    const pending: VNode[] = [start];
    while (pending.length > 0) {
      if (!this.budget.spend()) {
        this.truncated = true;
        return found;
      }
      const vnode = pending.pop()!;
      const kind = kindOf(vnode, root.fragment);
      if (kind === "text") continue;
      if (kind === "portal" && this.depths.has(portalContainer(vnode))) found.push(vnode);
      const children = childrenOf(vnode, this.budget);
      if (children === null) {
        this.truncated = true;
        return found;
      }
      pending.push(...children);
    }
    return found;
  }
}

/**
 * The host vnode that rendered `target`, or failing that its nearest rendered
 * ancestor. Containers in the target's own ancestry are searched first,
 * innermost first, since an island rendered into another tree's markup is a
 * root of its own. A portal's content sits wherever it was sent, so the tree
 * it belongs to may have no container above it at all: the known roots are
 * searched for a portal into the target's ancestry, after a sweep of the
 * document when `discover` allows one.
 */
export function lookupHost(
  target: Element,
  roots: KnownRoots,
  budget: Budget,
  discover: boolean
): Lookup {
  const path = ancestryOf(target);
  const search = new Search(target, path, budget);
  const local: PreactRoot[] = [];
  for (const node of path) {
    const root = rootOf(node);
    if (root !== null) local.push(root);
  }
  roots.remember(local.map((root) => root.container));
  for (const root of local) {
    const found = search.guided(root.vnode, root);
    if (found !== null) return { match: found, truncated: false };
    if (search.truncated) return { match: search.best, truncated: true };
  }
  if (discover) roots.discover(target.ownerDocument);
  for (const root of [...local, ...roots.others(local)]) {
    for (const portal of search.portals(root.vnode, root)) {
      const found = search.guided(portal, root);
      if (found !== null) return { match: found, truncated: false };
    }
    if (search.truncated) break;
  }
  return { match: search.best, truncated: search.truncated };
}

/** The innermost component above `vnode`, or null when the walk reaches its root first. */
export function nearestComponent(vnode: VNode, root: PreactRoot, budget: Budget): VNode | null {
  for (let next = parentOf(vnode); next !== null && budget.spend(); next = parentOf(next)) {
    if (next === root.vnode) return null;
    if (kindOf(next, root.fragment) === "component") return next;
  }
  return null;
}

export interface ComponentAncestry {
  /** Component vnodes from the innermost out; each one's render parent is the next. */
  components: VNode[];
  /** The walk reached the root vnode, so the outermost component has no render parent. */
  reachedRoot: boolean;
  truncated: boolean;
}

export function componentsAbove(
  vnode: VNode,
  root: PreactRoot,
  budget: Budget,
  limit: number
): ComponentAncestry {
  const components: VNode[] = [];
  const seen = new Set<VNode>([vnode]);
  for (let next = parentOf(vnode); next !== null; next = parentOf(next)) {
    // A parent pointer back into the walk is a loop, not an ancestor.
    if (!budget.spend() || seen.has(next)) {
      return { components, reachedRoot: false, truncated: true };
    }
    seen.add(next);
    if (next === root.vnode) return { components, reachedRoot: true, truncated: false };
    if (kindOf(next, root.fragment) !== "component") continue;
    if (components.length >= limit) return { components, reachedRoot: false, truncated: true };
    components.push(next);
  }
  return { components, reachedRoot: false, truncated: false };
}

export interface RenderedRoots {
  elements: Element[];
  complete: boolean;
}

/**
 * The outermost elements a component rendered, in vnode order. The walk covers
 * the whole subtree rather than stopping at the first host layer: a portal
 * below a host node renders into another container, so its content is a root
 * of its own unless that container is covered. An element inside one already
 * collected is covered by it, whichever came first, and so is text inside one.
 * Uncovered text, a host vnode with no element, or a walk cut short by `limit`
 * or the budget leaves the list incomplete rather than wrong.
 */
export function renderedRoots(
  component: VNode,
  root: PreactRoot,
  limit: number,
  budget: Budget
): RenderedRoots {
  let elements: Element[] = [];
  let complete = true;
  const covered = (node: Node): boolean =>
    elements.some((element) => element === node || element.contains(node));
  /** Text outside every root collected so far; a root found later can still cover it. */
  const loose: Node[] = [];
  const first = childrenOf(component, budget);
  if (first === null) return { elements, complete: false };
  const pending = first.reverse().map((vnode) => ({ vnode, cover: null as Node | null }));
  while (pending.length > 0) {
    if (!budget.spend()) return { elements, complete: false };
    const { vnode, cover } = pending.pop()!;
    const kind = kindOf(vnode, root.fragment);
    let childCover = cover;
    // Page values: an `instanceof` or `contains` on a hostile one can throw.
    try {
      if (kind === "host") {
        const node = domOf(vnode);
        if (node instanceof Element) {
          if (!covered(node)) {
            elements = elements.filter((element) => !node.contains(element));
            if (elements.length >= limit) return { elements, complete: false };
            elements.push(node);
          }
          childCover = node;
        } else if (cover === null) {
          complete = false;
        }
      } else if (kind === "text") {
        if (cover === null) {
          const node = domOf(vnode);
          if (node instanceof Node) loose.push(node);
          else complete = false;
        }
        continue;
      } else if (kind === "portal") {
        const container = portalContainer(vnode);
        childCover = container instanceof Node && covered(container) ? container : null;
      }
    } catch {
      complete = false;
      continue;
    }
    const children = childrenOf(vnode, budget);
    if (children === null) return { elements, complete: false };
    for (let index = children.length - 1; index >= 0; index -= 1) {
      pending.push({ vnode: children[index]!, cover: childCover });
    }
  }
  try {
    if (loose.some((text) => !covered(text))) complete = false;
  } catch {
    complete = false;
  }
  return { elements, complete };
}
