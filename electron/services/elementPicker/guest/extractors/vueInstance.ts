/// <reference lib="dom" />
/**
 * Vue 3's component instances and vnodes as a stock dev build leaves them on
 * the DOM, read from outside Vue. Nothing here imports Vue or calls into it:
 * every value is page data, may be missing or shaped by another version, and
 * is read through `field`, which turns a throwing getter into an absent value.
 *
 * A dev build defines `__vueParentComponent` and `__vnode` on every node it
 * mounts or hydrates, non-enumerable. The first is the instance whose render
 * patched the node in, which is the render parent: for slot content that is
 * the component rendering the slot. Who wrote the node is a different fact,
 * kept on the vnode as `ctx`, the instance that was rendering when the vnode
 * was made. A production build sets neither, nor does Vapor mode, which keeps
 * no vnodes at all; `__vue_app__` on the mount container is set by every build.
 */

export type VueInstance = Record<string, unknown>;
export type VNode = Record<string, unknown>;

/** Vue's `ShapeFlags`, the bits a vnode's `shapeFlag` is made of. */
const SHAPE = {
  element: 1,
  functionalComponent: 2,
  statefulComponent: 4,
  arrayChildren: 16,
  teleport: 64,
  suspense: 128,
} as const;
const COMPONENT_SHAPE = SHAPE.functionalComponent | SHAPE.statefulComponent;

/** Registered globally since Vue 3.3, so every copy of Vue on a page uses the same ones. */
const FRAGMENT = Symbol.for("v-fgt");
const TEXT = Symbol.for("v-txt");
const COMMENT = Symbol.for("v-cmt");
const STATIC = Symbol.for("v-stc");

const MAX_NAME_CHARS = 256;
/** DOM parents tried when the picked node is not one Vue mounted. */
const MAX_DOM_ANCESTORS = 128;
/** Components sharing one root element: nested wrappers, far short of a loop. */
const MAX_SHARED_ROOT_DEPTH = 64;

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

/** A component instance, VDOM or Vapor: both carry a numeric `uid` and their component `type`. */
export function isInstance(value: unknown): value is VueInstance {
  if (typeof value !== "object" || value === null) return false;
  const type = field(value, "type");
  return (
    typeof field(value, "uid") === "number" &&
    ((typeof type === "object" && type !== null) || typeof type === "function")
  );
}

export function isVNode(value: unknown): value is VNode {
  return typeof value === "object" && value !== null && field(value, "__v_isVNode") === true;
}

function instanceAt(node: Node): VueInstance | null {
  const instance = field(node, "__vueParentComponent");
  return isInstance(instance) ? instance : null;
}

/**
 * What Vue says it mounted `node` from, by the vnode it left there:
 *
 * - `element`: the node's own element vnode.
 * - `static`: the first node of a static block a server render hydrated,
 *   which holds the block's vnode; nothing in a static block is a component.
 * - `pending`: a component's vnode, which a node holds while the component
 *   waits to hydrate there (an async one, or one hydrated lazily), and which
 *   describes the tag that used the component rather than the node.
 */
export type OwnVNode =
  { kind: "element"; vnode: VNode } | { kind: "static"; vnode: VNode } | { kind: "pending" };

export function ownVNodeAt(node: Node): OwnVNode | null {
  const vnode = field(node, "__vnode");
  if (!isVNode(vnode) || field(vnode, "el") !== node) return null;
  const shape = field(vnode, "shapeFlag");
  const flags = typeof shape === "number" ? shape : 0;
  if (flags & SHAPE.element) return { kind: "element", vnode };
  if (flags & COMPONENT_SHAPE) return { kind: "pending" };
  return field(vnode, "type") === STATIC ? { kind: "static", vnode } : null;
}

function appAt(node: Node): Record<string, unknown> | null {
  const app = field(node, "__vue_app__");
  return typeof app === "object" && app !== null ? (app as Record<string, unknown>) : null;
}

const FOREIGN_NAMES = ["__svelte_meta", "__ngContext__"];

/** Another framework rendered this node itself. */
function renderedByForeign(node: Node): boolean {
  try {
    if (FOREIGN_NAMES.some((name) => Object.hasOwn(node, name))) return true;
    return Object.keys(node).some(
      (key) => key.startsWith("__reactFiber$") && field(node, key) != null
    );
  } catch {
    return false;
  }
}

/** The node holds a live React root: what is inside it is React's, whoever rendered the node. */
function hostsForeign(node: Node): boolean {
  try {
    // React leaves the key behind, emptied, when the root unmounts.
    return Object.keys(node).some(
      (key) => key.startsWith("__reactContainer$") && field(node, key) != null
    );
  } catch {
    return false;
  }
}

function parentNodeOf(node: Node): Node | null {
  try {
    return node.parentNode;
  } catch {
    return null;
  }
}

export type Lookup =
  /** `own`: the instance was read off the picked node itself; `node` is where it was read. */
  | { kind: "instance"; instance: VueInstance; own: boolean; node: Element }
  /** Inside a mounted Vue app whose nodes carry no instance. */
  | { kind: "app"; app: Record<string, unknown>; container: Node };

/**
 * The instance the picked node belongs to: its own, or its nearest mounted
 * ancestor's, since markup inside a component that Vue did not mount itself
 * (`v-html`, a static block, a widget's DOM) still belongs to that component.
 * The walk stops at the first app container above the node, element or shadow
 * root, so a nested app built without dev metadata never borrows an outer
 * app's instance, and at the first node another framework rendered or holds a
 * live root of, since what is in there is that framework's whatever Vue
 * rendered around it. A container itself is not part of the app inside it.
 */
export function lookUp(node: Element): Lookup | null {
  let current: Node | null = node;
  for (let depth = 0; depth < MAX_DOM_ANCESTORS && current !== null; depth += 1) {
    if (current instanceof Element) {
      const instance = instanceAt(current);
      if (depth === 0 && instance !== null) {
        return { kind: "instance", instance, own: true, node: current };
      }
      if (depth > 0 && hostsForeign(current)) return null;
      const app = depth === 0 ? null : appAt(current);
      if (app !== null) return { kind: "app", app, container: current };
      if (instance !== null) return { kind: "instance", instance, own: false, node: current };
      if (renderedByForeign(current)) return null;
    }
    const parent = parentNodeOf(current);
    if (parent instanceof ShadowRoot) {
      const app = appAt(parent);
      if (app !== null) return { kind: "app", app, container: parent };
      current = parent.host;
    } else {
      current = parent;
    }
  }
  return null;
}

/**
 * Whether the page's build is known to be a production one: the app mounted
 * into this container, and the field only a dev or devtools build fills in on
 * mount is still empty. Missing instances alone do not say it.
 */
export function isProductionApp(app: Record<string, unknown>, container: Node): boolean {
  return field(app, "_container") === container && field(app, "_instance") === null;
}

export function appVersion(app: unknown): string | null {
  const version = field(app, "version");
  return typeof version === "string" && version.length > 0 ? version.slice(0, 32) : null;
}

export function instanceApp(instance: VueInstance): unknown {
  return field(field(instance, "appContext"), "app");
}

/** The render parent: null when the instance says it has none, undefined when that cannot be read. */
export function parentOf(instance: VueInstance): VueInstance | null | undefined {
  const parent = field(instance, "parent");
  if (parent === null) return null;
  return isInstance(parent) ? parent : undefined;
}

/**
 * The owner: whichever instance was rendering when this one's vnode was made.
 * Null when nothing was (the root, or a vnode made outside any render), and
 * undefined when that cannot be read, as with a Vapor instance, which has no vnode.
 */
export function ownerOf(instance: VueInstance): VueInstance | null | undefined {
  const vnode = field(instance, "vnode");
  if (!isVNode(vnode)) return undefined;
  const ctx = field(vnode, "ctx");
  if (ctx === null) return null;
  return isInstance(ctx) ? ctx : undefined;
}

export interface InstanceName {
  value: string;
  /** The property path the name was read from, relative to the instance. */
  field: string;
}

function stringAt(value: unknown, key: string, path: string): InstanceName | null {
  const read = field(value, key);
  if (typeof read !== "string" || read.length === 0) return null;
  return { value: read.slice(0, MAX_NAME_CHARS), field: path };
}

/**
 * The name Vue itself gives a component, in its order: a functional
 * component's `displayName` or function name, an options object's `name`, or
 * the `__name` the SFC compiler writes for `<script setup>`. Null is an
 * anonymous component; a name is never made up from its file.
 */
export function componentName(instance: VueInstance): InstanceName | null {
  const type = field(instance, "type");
  if (typeof type === "function") {
    return stringAt(type, "displayName", "type.displayName") ?? stringAt(type, "name", "type.name");
  }
  return stringAt(type, "name", "type.name") ?? stringAt(type, "__name", "type.__name");
}

/** `type.__file`: the file `@vitejs/plugin-vue` compiled the component from in dev. A path, never a line. */
export function componentFile(instance: VueInstance): string | null {
  const file = field(field(instance, "type"), "__file");
  return typeof file === "string" && file.length > 0 ? file : null;
}

/** Mints one id per component instance, for as long as the extractor that shows them. */
export class InstanceIds {
  private readonly ids = new WeakMap<object, string>();
  private next = 0;

  constructor(private readonly prefix: string) {}

  idOf(instance: VueInstance): string {
    let id = this.ids.get(instance);
    if (id === undefined) {
      this.next += 1;
      id = this.prefix + this.next;
      this.ids.set(instance, id);
    }
    return id;
  }
}

/** Vue's `PatchFlags.DEV_ROOT_FRAGMENT`. */
const DEV_ROOT_FRAGMENT = 2048;
/** A dev root's siblings are comments at the top of one template. */
const MAX_ROOT_CHILDREN = 64;

/**
 * The vnode a component's output is rooted at, as Vue finds it to pass
 * attributes down: in dev, a template whose root is one node among comments
 * renders a fragment around it, and the node inside is the root.
 */
export function effectiveRoot(vnode: unknown): unknown {
  let current = vnode;
  try {
    for (let depth = 0; depth < MAX_SHARED_ROOT_DEPTH; depth += 1) {
      const flag = field(current, "patchFlag");
      if (field(current, "type") !== FRAGMENT || typeof flag !== "number" || flag <= 0) {
        return current;
      }
      if (!(flag & DEV_ROOT_FRAGMENT)) return current;
      const children = field(current, "children");
      if (!Array.isArray(children) || children.length > MAX_ROOT_CHILDREN) return current;
      let single: unknown = undefined;
      for (const child of children) {
        if (!isVNode(child)) return current;
        // `v-if` leaves a comment too, and that one is a root like any other.
        if (field(child, "type") === COMMENT && field(child, "children") !== "v-if") continue;
        if (single !== undefined) return current;
        single = child;
      }
      if (single === undefined) return current;
      current = single;
    }
  } catch {
    // A shape that cannot be read is no root but its own.
  }
  return current;
}

/** The element an instance's output is, when that is one element, through any components rooted at it. */
function rootElementOf(instance: VueInstance): unknown {
  let vnode = effectiveRoot(field(instance, "subTree"));
  for (let depth = 0; depth < MAX_SHARED_ROOT_DEPTH; depth += 1) {
    const shape = field(vnode, "shapeFlag");
    if (typeof shape !== "number") return null;
    if (!(shape & COMPONENT_SHAPE)) return shape & SHAPE.element ? field(vnode, "el") : null;
    vnode = effectiveRoot(field(field(vnode, "component"), "subTree"));
  }
  return null;
}

/**
 * Every component whose output is exactly `element`, innermost first: a
 * component whose root is another component's root shares it. Attributes a
 * parent passes to such a component land on this element.
 */
export function componentsRootedAt(element: Element, instance: VueInstance | null): VueInstance[] {
  const out: VueInstance[] = [];
  for (
    let current: VueInstance | null | undefined = instance;
    current && out.length < MAX_SHARED_ROOT_DEPTH && rootElementOf(current) === element;
    current = parentOf(current)
  ) {
    out.push(current);
  }
  return out;
}

export interface RenderedRoots {
  elements: Element[];
  complete: boolean;
}

function hasText(node: Text): boolean {
  return node.data.trim().length > 0;
}

/**
 * The outermost DOM elements a component rendered, in document order, read
 * from its current subtree. The walk follows the vnodes Vue mounted rather
 * than the DOM, so a fragment's siblings, a Teleport's children in their
 * target and a Suspense's shown branch all count, and it carries on below
 * each root to find a Teleport there, whose children land elsewhere. An
 * element inside a root already collected is covered by it, whichever came
 * first.
 *
 * Text outside every root, a component whose subtree cannot be read (a Vapor
 * one has none), a static block whose range cannot be followed, or a walk cut
 * short by `limit` or the budget leaves the list incomplete rather than wrong.
 * A comment is no root: it is how Vue marks a `v-if` that rendered nothing.
 * Children are taken one at a time, each from the budget, so no list a page
 * hands over is walked further than the budget allows.
 */
export function renderedRoots(instance: VueInstance, limit: number, budget: Budget): RenderedRoots {
  let elements: Element[] = [];
  let complete = true;
  const covered = (node: Node): boolean =>
    elements.some((root) => root === node || root.contains(node));
  /** Text outside every root collected so far; a root found later can still cover it. */
  const loose: Text[] = [];
  const subTree = field(instance, "subTree");
  if (!isVNode(subTree)) return { elements, complete: false };
  const pending: Array<{ list: unknown[]; next: number; cover: Element | null }> = [
    { list: [subTree], next: 0, cover: null },
  ];
  const visit = (vnode: unknown, cover: Element | null): void => {
    pending.push({ list: [vnode], next: 0, cover });
  };
  const visitAll = (children: unknown, cover: Element | null): void => {
    if (Array.isArray(children)) pending.push({ list: children, next: 0, cover });
  };

  const addRoot = (node: Element): boolean => {
    if (covered(node)) return true;
    elements = elements.filter((root) => !node.contains(root));
    if (elements.length >= limit) return false;
    elements.push(node);
    return true;
  };

  while (pending.length > 0) {
    const frame = pending[pending.length - 1]!;
    let vnode: unknown;
    try {
      if (frame.next >= frame.list.length) {
        pending.pop();
        continue;
      }
      vnode = frame.list[frame.next];
    } catch {
      pending.pop();
      complete = false;
      continue;
    }
    frame.next += 1;
    if (!budget.spend()) return { elements, complete: false };
    const cover = frame.cover;
    if (!isVNode(vnode)) {
      complete = false;
      continue;
    }
    const type = field(vnode, "type");
    const shape = field(vnode, "shapeFlag");
    const flags = typeof shape === "number" ? shape : 0;
    // Page values: an `instanceof` or `contains` on a hostile one can throw.
    try {
      if (flags & COMPONENT_SHAPE) {
        const child = field(field(vnode, "component"), "subTree");
        if (isVNode(child)) visit(child, cover);
        else complete = false;
      } else if (flags & SHAPE.suspense) {
        const suspense = field(vnode, "suspense");
        // While a server-rendered page hydrates, what it shows is the branch still pending.
        const shown = field(suspense, "isHydrating") === true ? "pendingBranch" : "activeBranch";
        const branch = field(suspense, shown);
        if (isVNode(branch)) visit(branch, cover);
        else if (branch !== null) complete = false;
      } else if (flags & SHAPE.teleport) {
        // Its children land in its target, covered only if that is.
        visitAll(field(vnode, "children"), null);
      } else if (flags & SHAPE.element) {
        const node = field(vnode, "el");
        if (!(node instanceof Element)) {
          if (cover === null) complete = false;
          continue;
        }
        if (cover === null && !addRoot(node)) return { elements, complete: false };
        if (flags & SHAPE.arrayChildren) visitAll(field(vnode, "children"), cover ?? node);
      } else if (type === FRAGMENT) {
        visitAll(field(vnode, "children"), cover);
      } else if (type === TEXT) {
        const node = field(vnode, "el");
        if (cover === null && node instanceof Text && hasText(node)) loose.push(node);
      } else if (type === STATIC) {
        // A run of nodes Vue inserted as markup, from `el` to `anchor`; nothing in it is a component.
        if (cover !== null) continue;
        const first = field(vnode, "el");
        const last = field(vnode, "anchor");
        if (!(first instanceof Node) || !(last instanceof Node)) {
          complete = false;
          continue;
        }
        let reachedEnd = false;
        for (let node: Node | null = first; node !== null; node = node.nextSibling) {
          if (!budget.spend()) return { elements, complete: false };
          if (node instanceof Element) {
            if (!addRoot(node)) return { elements, complete: false };
          } else if (node instanceof Text && hasText(node)) {
            loose.push(node);
          }
          if (node === last) {
            reachedEnd = true;
            break;
          }
        }
        if (!reachedEnd) complete = false;
      } else if (type !== COMMENT) {
        complete = false;
      }
    } catch {
      complete = false;
    }
  }
  try {
    if (loose.some((text) => !covered(text))) complete = false;
  } catch {
    complete = false;
  }
  return { elements, complete };
}

/**
 * The static block `node` sits in, if it sits in one, and the component whose
 * output holds it: a run of markup Vue inserted whole and left unmarked, whose
 * vnode still says which component's template wrote it. A component whose
 * whole root is such a run marks no node of its own, so the nearest marked
 * node above it is its parent's; the search goes down from there through child
 * components' output to find it.
 */
export function staticBlockOf(
  instance: VueInstance,
  node: Node,
  budget: Budget
): { vnode: VNode; instance: VueInstance } | null {
  const subTree = field(instance, "subTree");
  if (!isVNode(subTree)) return null;
  const pending: Array<{ list: unknown[]; next: number; owner: VueInstance }> = [
    { list: [subTree], next: 0, owner: instance },
  ];
  while (pending.length > 0) {
    const frame = pending[pending.length - 1]!;
    let vnode: unknown;
    try {
      if (frame.next >= frame.list.length) {
        pending.pop();
        continue;
      }
      vnode = frame.list[frame.next];
    } catch {
      pending.pop();
      continue;
    }
    frame.next += 1;
    if (!budget.spend()) return null;
    if (!isVNode(vnode)) continue;
    const shape = field(vnode, "shapeFlag");
    const flags = typeof shape === "number" ? shape : 0;
    // Page values: a `contains` on a hostile one can throw.
    try {
      if (flags & COMPONENT_SHAPE) {
        const component = field(vnode, "component");
        const child = field(component, "subTree");
        if (isInstance(component) && isVNode(child)) {
          pending.push({ list: [child], next: 0, owner: component });
        }
        continue;
      }
      if (flags & SHAPE.suspense) {
        const branch = field(field(vnode, "suspense"), "activeBranch");
        if (isVNode(branch)) pending.push({ list: [branch], next: 0, owner: frame.owner });
        continue;
      }
      if (field(vnode, "type") === STATIC) {
        const last = field(vnode, "anchor");
        let current = field(vnode, "el");
        while (current instanceof Node) {
          if (!budget.spend()) return null;
          if (current === node || current.contains(node)) return { vnode, instance: frame.owner };
          if (current === last) break;
          current = current.nextSibling;
        }
        continue;
      }
      const children = field(vnode, "children");
      if (Array.isArray(children)) pending.push({ list: children, next: 0, owner: frame.owner });
    } catch {
      // A block that cannot be read is not the one.
    }
  }
  return null;
}
