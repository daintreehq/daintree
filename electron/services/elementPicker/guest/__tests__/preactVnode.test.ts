// @vitest-environment jsdom
import { h, hydrate, render, type ComponentChild } from "preact";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  Budget,
  KnownRoots,
  childrenOf,
  componentName,
  componentsAbove,
  lookupHost,
  rootOf,
  sourceOf,
  type VNode,
} from "../preact/vnode.js";

/**
 * The vnode reader against what a hostile or unusual page can hand it: values
 * behind getters, arrays that claim any length, parent pointers that loop, and
 * trees in places a DOM-ancestor walk alone would not look.
 */

const containers: Array<Element | ShadowRoot> = [];

function mount(tree: ComponentChild, into?: Element | ShadowRoot): Element | ShadowRoot {
  const container = into ?? document.body.appendChild(document.createElement("div"));
  render(tree, container);
  containers.push(container);
  return container;
}

afterEach(() => {
  for (const container of containers.splice(0)) render(null, container);
  document.body.innerHTML = "";
});

function vnode(fields: Record<string, unknown>): VNode {
  return { type: "div", props: {}, __k: null, __: null, __e: null, __c: null, ...fields };
}

describe("the Preact vnode reader", () => {
  it("never runs a getter: a container or vnode field behind one reads as absent", () => {
    const container = document.createElement("div");
    const tree = vi.fn(() => vnode({ type: () => null, __k: [] }));
    Object.defineProperty(container, "__k", { get: tree, enumerable: true });
    expect(rootOf(container)).toBeNull();
    expect(tree).not.toHaveBeenCalled();

    const source = vi.fn(() => ({ fileName: "/x.tsx", lineNumber: 1, columnNumber: 1 }));
    const displayName = vi.fn(() => "Forged");
    function Named() {
      return null;
    }
    Object.defineProperty(Named, "displayName", { get: displayName });
    const element = vnode({ type: Named });
    Object.defineProperty(element, "__source", { get: source });
    expect(sourceOf(element)).toBeNull();
    expect(componentName(element)).toEqual({ value: "Named", field: "type.name" });
    expect(source).not.toHaveBeenCalled();
    expect(displayName).not.toHaveBeenCalled();
  });

  it("takes only a vnode-shaped tree with a function at its root as a render container", () => {
    const container = document.createElement("div");
    (container as unknown as Record<string, unknown>).__k = { type: () => null };
    expect(rootOf(container)).toBeNull();
    (container as unknown as Record<string, unknown>).__k = vnode({ type: "div" });
    expect(rootOf(container)).toBeNull();

    const real = mount(h("p", null, "x"));
    expect(rootOf(real)?.container).toBe(real);
  });

  it("spends a step on every slot of a children array, whatever length it claims", () => {
    const children: unknown[] = [];
    children.length = 10_000_000;
    expect(childrenOf(vnode({ __k: children }), new Budget(100))).toBeNull();
    // Preact leaves nulls and holes where a child rendered nothing.
    const holed: unknown[] = [null, vnode({})];
    holed[3] = vnode({});
    expect(childrenOf(vnode({ __k: holed }), new Budget(100))).toHaveLength(2);
  });

  it("cuts a parent pointer that loops rather than following it", () => {
    const fragment = () => null;
    const rootVNode = vnode({ type: fragment });
    const component = () => null;
    const a = vnode({ type: component });
    const b = vnode({ type: component, __: a });
    a.__ = b;
    const host = vnode({ __: a });
    const ancestry = componentsAbove(
      host,
      { container: document.body, vnode: rootVNode, fragment },
      new Budget(1_000),
      64
    );
    expect(ancestry.components).toEqual([a, b]);
    expect(ancestry.truncated).toBe(true);
    expect(ancestry.reachedRoot).toBe(false);
  });

  it("finds a tree rendered into a shadow root, from inside it and by a document sweep", () => {
    const host = document.body.appendChild(document.createElement("div"));
    const shadow = host.attachShadow({ mode: "open" });
    const Widget = () => h("b", { class: "inside" }, "inside");
    mount(h(Widget, null), shadow);
    const target = shadow.querySelector("b.inside")!;

    const lookup = lookupHost(target, new KnownRoots(), new Budget(1_000), false);
    expect(lookup.match?.own).toBe(true);
    expect(lookup.match?.root.container).toBe(shadow);

    const roots = new KnownRoots();
    roots.discover(document);
    expect(roots.others([]).map((root) => root.container)).toEqual([shadow]);
  });

  it("reads a tree hydrate() adopted the server's markup into", () => {
    const container = document.body.appendChild(document.createElement("div"));
    container.innerHTML = '<p class="served">served</p>';
    const served = container.querySelector("p.served")!;
    const Page = () => h("p", { class: "served" }, "served");
    hydrate(h(Page, null), container);
    containers.push(container);
    const lookup = lookupHost(served, new KnownRoots(), new Budget(1_000), false);
    expect(lookup.match?.own).toBe(true);
    const root = lookup.match!.root;
    expect(componentsAbove(lookup.match!.vnode, root, new Budget(100), 64)).toMatchObject({
      components: [expect.anything()],
      reachedRoot: true,
    });
  });

  it("answers from the innermost tree when one is rendered into another's markup", () => {
    const Outer = () => h("div", { class: "island" });
    const outer = mount(h(Outer, null)) as Element;
    const Inner = () => h("b", { class: "inner" }, "inner");
    const island = mount(h(Inner, null), outer.querySelector("div.island")!) as Element;
    const lookup = lookupHost(
      island.querySelector("b.inner")!,
      new KnownRoots(),
      new Budget(1_000),
      false
    );
    expect(lookup.match?.root.container).toBe(island);
    const ancestry = componentsAbove(lookup.match!.vnode, lookup.match!.root, new Budget(100), 64);
    expect(ancestry.components.map((entry) => componentName(entry)?.value)).toEqual(["Inner"]);
    expect(ancestry.reachedRoot).toBe(true);
  });

  it("finds nothing for a node its tree has since unmounted", () => {
    const Page = () => h("p", { class: "gone" }, "gone");
    const container = mount(h(Page, null));
    const gone = (container as Element).querySelector("p.gone")!;
    const roots = new KnownRoots();
    roots.remember([container]);
    render(null, container);
    // A sweep that saw the whole page backs the null: nothing drew this node now.
    expect(lookupHost(gone, roots, new Budget(1_000), true)).toEqual({
      match: null,
      truncated: false,
      swept: true,
    });
    // Without one, a portal's tree it never met could have.
    expect(lookupHost(gone, roots, new Budget(1_000), false)).toEqual({
      match: null,
      truncated: false,
      swept: false,
    });
  });

  it("calls a sweep partial when the page outruns its sample", () => {
    mount(h("b", null, "tree"));
    expect(new KnownRoots().discover(document)).toBe(true);
    for (let index = 0; index < 2_100; index += 1) {
      document.body.appendChild(document.createElement("span"));
    }
    expect(new KnownRoots().discover(document)).toBe(false);
  });

  it("says when a lookup ran out of steps rather than calling the node unrendered", () => {
    const items = Array.from({ length: 500 }, (_, index) => h("li", { key: index }, String(index)));
    const container = mount(h("ul", null, items)) as Element;
    const last = container.querySelectorAll("li")[499]!;
    expect(lookupHost(last, new KnownRoots(), new Budget(50), false)).toEqual({
      match: expect.objectContaining({ own: false }),
      truncated: true,
      swept: false,
    });
    expect(lookupHost(last, new KnownRoots(), new Budget(10_000), false)).toEqual({
      match: expect.objectContaining({ own: true }),
      truncated: false,
      swept: false,
    });
  });
});
