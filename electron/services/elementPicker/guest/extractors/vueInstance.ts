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

export function vnodeAt(node: Node): VNode | null {
  const vnode = field(node, "__vnode");
  return isVNode(vnode) ? vnode : null;
}

export type Lookup =
  /** `own`: the instance was read off the picked node itself, not an ancestor. */
  | { kind: "instance"; instance: VueInstance; own: boolean }
  /** Inside a mounted Vue app whose nodes carry no instance. */
  | { kind: "app"; app: Record<string, unknown>; container: Element };

/**
 * The instance the picked node belongs to: its own, or its nearest mounted
 * ancestor's, since markup inside a component that Vue did not mount itself
 * (`v-html`, a static block, a widget's DOM) still belongs to that component.
 * The walk stops at the first app container above the node, so a nested app
 * built without dev metadata never borrows an outer app's instance.
 */
export function lookUp(node: Element): Lookup | null {
  let current: Node | null = node;
  for (let depth = 0; depth < MAX_DOM_ANCESTORS && current !== null; depth += 1) {
    if (current instanceof Element) {
      // A container is rendered by the app around it, and holds the app inside it.
      const instance = instanceAt(current);
      if (depth === 0 && instance !== null) return { kind: "instance", instance, own: true };
      const app = field(current, "__vue_app__");
      if (typeof app === "object" && app !== null) {
        return { kind: "app", app: app as Record<string, unknown>, container: current };
      }
      if (instance !== null) return { kind: "instance", instance, own: false };
    }
    const parent: Node | null = current.parentNode;
    current = parent instanceof ShadowRoot ? parent.host : parent;
  }
  return null;
}

/**
 * Whether the page's build is known to be a production one: the app mounted
 * into this container, and the field only a dev or devtools build fills in on
 * mount is still empty. Missing instances alone do not say it.
 */
export function isProductionApp(app: Record<string, unknown>, container: Element): boolean {
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

/** The element this instance's output starts at, when that is one element. */
function rootElementOf(instance: VueInstance): unknown {
  return field(field(instance, "subTree"), "el");
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
 */
export function renderedRoots(instance: VueInstance, limit: number, budget: Budget): RenderedRoots {
  let elements: Element[] = [];
  let complete = true;
  const covered = (node: Node): boolean =>
    elements.some((root) => root === node || root.contains(node));
  /** Text outside every root collected so far; a root found later can still cover it. */
  const loose: Text[] = [];
  const pending: Array<{ vnode: unknown; cover: Element | null }> = [];
  const subTree = field(instance, "subTree");
  if (!isVNode(subTree)) return { elements, complete: false };
  pending.push({ vnode: subTree, cover: null });

  const addRoot = (node: Element): boolean => {
    if (covered(node)) return true;
    elements = elements.filter((root) => !node.contains(root));
    if (elements.length >= limit) return false;
    elements.push(node);
    return true;
  };
  const pushChildren = (children: unknown, cover: Element | null): void => {
    if (!Array.isArray(children)) return;
    for (let index = children.length - 1; index >= 0; index -= 1) {
      pending.push({ vnode: children[index], cover });
    }
  };

  while (pending.length > 0) {
    if (!budget.spend()) return { elements, complete: false };
    const { vnode, cover } = pending.pop()!;
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
        if (isVNode(child)) pending.push({ vnode: child, cover });
        else complete = false;
      } else if (flags & SHAPE.suspense) {
        const branch = field(field(vnode, "suspense"), "activeBranch");
        if (isVNode(branch)) pending.push({ vnode: branch, cover });
        else if (branch !== null) complete = false;
      } else if (flags & SHAPE.teleport) {
        // Its children land in its target, covered only if that is.
        pushChildren(field(vnode, "children"), null);
      } else if (flags & SHAPE.element) {
        const node = field(vnode, "el");
        if (!(node instanceof Element)) {
          if (cover === null) complete = false;
          continue;
        }
        if (cover === null && !addRoot(node)) return { elements, complete: false };
        if (flags & SHAPE.arrayChildren) pushChildren(field(vnode, "children"), cover ?? node);
      } else if (type === FRAGMENT) {
        pushChildren(field(vnode, "children"), cover);
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
