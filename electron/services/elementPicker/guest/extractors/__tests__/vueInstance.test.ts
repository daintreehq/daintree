// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { ComponentChainSchema } from "../../../../../../shared/elementPicker/component.js";
import { FrameworkEvidenceSchema } from "../../../../../../shared/elementPicker/evidence.js";
import { CapabilitiesSchema } from "../../../../../../shared/elementPicker/observation.js";
import { SourceCandidateSchema } from "../../../../../../shared/elementPicker/source.js";
import type { ElementRefs } from "../../registry.js";
import type { ExtractorContribution } from "../../types.js";
import { createVueExtractor } from "../vueExtractor.js";
import { Budget, renderedRoots, type VueInstance } from "../vueInstance.js";
import { parseStamp } from "../vueStamps.js";

/**
 * What the Vue extractor makes of page data no stock Vue 3.5 build produces:
 * Vapor-shaped instances (Vue 3.6 is still a release candidate), getters that
 * throw, loops, and graphs past every bound. Each answer is held to the
 * schemas the host enforces, so a page cannot shape one the host would refuse.
 */

type Shape = Record<string, unknown>;

let uid = 0;

function instance(fields: Shape = {}): Shape {
  uid += 1;
  return { uid, type: {}, parent: null, ...fields };
}

function vnode(fields: Shape): Shape {
  return { __v_isVNode: true, shapeFlag: 0, ...fields };
}

function elementVNode(el: Element, children?: Shape[]): Shape {
  return vnode({ type: el.localName, shapeFlag: children ? 1 | 16 : 1, el, children });
}

function mark(node: Element, owner: Shape, ownVNode: Shape = elementVNode(node)): void {
  Object.defineProperty(node, "__vueParentComponent", { value: owner, configurable: true });
  Object.defineProperty(node, "__vnode", { value: ownVNode, configurable: true });
}

function refTable(): ElementRefs & { nodes: Element[] } {
  const tokens = new Map<Element, string>();
  const nodes: Element[] = [];
  return {
    nodes,
    ref(node) {
      let token = tokens.get(node);
      if (token === undefined) {
        token = `ref-${nodes.length}`;
        tokens.set(node, token);
        nodes.push(node);
      }
      return token;
    },
  };
}

/** Admitted whole, as the host would check each part of it. */
function admitted(contribution: ExtractorContribution | null): ExtractorContribution {
  if (contribution === null) throw new Error("no contribution");
  expect(ComponentChainSchema.safeParse(contribution.componentChain).error).toBeUndefined();
  expect(CapabilitiesSchema.safeParse(contribution.capabilities).error).toBeUndefined();
  const candidates = [
    ...(contribution.sourceCandidates ?? []),
    ...(contribution.componentChain?.components ?? []).flatMap((record) => record.sourceCandidates),
  ];
  for (const candidate of candidates) {
    expect(SourceCandidateSchema.safeParse(candidate).error).toBeUndefined();
  }
  expect(new Set(candidates.map((candidate) => candidate.candidateId)).size).toBe(
    candidates.length
  );
  for (const entry of contribution.frameworkEvidence ?? []) {
    expect(FrameworkEvidenceSchema.safeParse(entry).error).toBeUndefined();
  }
  return contribution;
}

function select(node: Element) {
  return admitted(createVueExtractor().extract(node, "selection", refTable()));
}

function names(contribution: ExtractorContribution): Array<string | null> {
  return (contribution.componentChain?.components ?? []).map(
    (record) => record.name?.value ?? null
  );
}

afterEach(() => {
  document.body.innerHTML = "";
});

describe("the Vue extractor without instances", () => {
  function app(instanceField: unknown, container: Element = document.createElement("div")) {
    document.body.append(container);
    const button = document.createElement("button");
    container.append(button);
    (container as unknown as Shape).__vue_app__ = {
      _container: container,
      _instance: instanceField,
      version: "3.6.0-rc.12",
    };
    return button;
  }

  it("says a Vapor app's nodes expose nothing, without calling it a production build", () => {
    // A Vapor app's root is no VDOM instance, and its nodes carry none.
    const button = app(instance({ type: { __name: "App" }, vapor: true, block: {} }));
    const contribution = select(button);
    expect(contribution.componentChain).toEqual({
      nearestId: null,
      components: [],
      truncated: false,
    });
    expect(contribution.capabilities?.names).toEqual({
      state: "unavailable",
      reason: "not-exposed",
    });
    expect(contribution.capabilities?.line).toEqual({
      state: "unavailable",
      reason: "not-exposed",
    });
  });

  it("calls it a production build only when the app mounted here left its dev-only field empty", () => {
    expect(select(app(null)).capabilities?.chain).toEqual({
      state: "unavailable",
      reason: "production-build",
    });
    document.body.innerHTML = "";
    // An app that says it mounted somewhere else proves nothing about this one.
    const button = app(null);
    ((button.parentElement as unknown as Shape).__vue_app__ as Shape)._container = document.body;
    expect(select(button).capabilities?.chain).toEqual({
      state: "unavailable",
      reason: "not-exposed",
    });
  });

  it("never borrows an outer app's instance across a nested app's container", () => {
    const outerRoot = instance({ type: { __name: "Outer" } });
    const container = document.createElement("div");
    mark(container, outerRoot);
    const button = app(null, container);
    expect(select(button).componentChain?.components).toEqual([]);
    // The container itself is the outer app's element.
    expect(names(select(container))).toEqual(["Outer"]);
  });

  it("gives nothing for a node in no Vue app", () => {
    const node = document.createElement("p");
    document.body.append(node);
    expect(createVueExtractor().extract(node, "selection", refTable())).toBeNull();
  });
});

describe("the Vue extractor on shapes Vue 3.5 never makes", () => {
  it("reads a VDOM component under a Vapor one, and leaves what Vapor does not say unsaid", () => {
    const shell = instance({ type: { __name: "VaporShell" }, vapor: true, block: {} });
    const vaporChild = instance({ type: { __name: "VaporLeaf" }, vapor: true });
    const button = document.createElement("button");
    document.body.append(button);
    const inner = instance({
      type: { __name: "Inner" },
      parent: shell,
      subTree: vnode({ type: {}, shapeFlag: 4, component: vaporChild }),
      vnode: vnode({ ctx: shell }),
    });
    mark(button, inner);
    const contribution = select(button);
    expect(names(contribution)).toEqual(["Inner", "VaporShell"]);
    const [own, vapor] = contribution.componentChain!.components;
    expect(own).toMatchObject({ renderParentId: vapor!.componentId, ownerId: vapor!.componentId });
    // A Vapor instance has no vnode, so no owner can be read off it, and no subtree to find roots in.
    expect(vapor).toMatchObject({ renderParentId: null, rootElementIds: [], rootsComplete: false });
    expect(vapor).not.toHaveProperty("ownerId");
    expect(own!.rootsComplete).toBe(false);
  });

  it("walks on past an expando that throws, and names nothing it cannot read", () => {
    const section = document.createElement("section");
    const button = document.createElement("button");
    section.append(button);
    document.body.append(section);
    const type = {};
    Object.defineProperty(type, "__name", {
      get() {
        throw new Error("hostile");
      },
    });
    mark(section, instance({ type }));
    Object.defineProperty(button, "__vueParentComponent", {
      get() {
        throw new Error("hostile");
      },
    });
    const contribution = select(button);
    expect(names(contribution)).toEqual([null]);
    expect(contribution.frameworkEvidence?.[0]).toMatchObject({
      fields: expect.arrayContaining([{ name: "instanceLookup", value: "ancestor" }]),
    });
  });

  it("refuses an instance that is a proxy throwing on every read", () => {
    const hostile = new Proxy(
      {},
      {
        get() {
          throw new Error("hostile");
        },
      }
    );
    const button = document.createElement("button");
    document.body.append(button);
    Object.defineProperty(button, "__vueParentComponent", { value: hostile });
    expect(createVueExtractor().extract(button, "selection", refTable())).toBeNull();
  });

  it("reads only the nearest instance's name on hover", () => {
    const reads: string[] = [];
    const watched = new Proxy({ uid: 7, type: { __name: "Watched" } } as Shape, {
      get(target, key) {
        if (typeof key === "string") reads.push(key);
        return target[key as string];
      },
    });
    const button = document.createElement("button");
    document.body.append(button);
    Object.defineProperty(button, "__vueParentComponent", { value: watched });
    const hover = admitted(createVueExtractor().extract(button, "hover", refTable()));
    expect(names(hover)).toEqual(["Watched"]);
    expect(reads.filter((key) => !["uid", "type"].includes(key))).toEqual([]);
  });

  it("cuts a parent loop and an owner loop rather than sending either", () => {
    const first = instance({ type: { __name: "First" } });
    const second = instance({ type: { __name: "Second" }, parent: first });
    first.parent = second;
    first.vnode = vnode({ ctx: second });
    second.vnode = vnode({ ctx: first });
    const button = document.createElement("button");
    document.body.append(button);
    mark(button, first);
    const chain = select(button).componentChain!;
    expect(chain.components.map((record) => record.name?.value)).toEqual(["First", "Second"]);
    expect(chain.truncated).toBe(true);
    expect(chain.components[1]).not.toHaveProperty("renderParentId");
  });

  it("stops a chain at its record limit with no edge pointing past it", () => {
    let parent: Shape | null = null;
    for (let depth = 0; depth < 100; depth += 1) {
      parent = instance({ type: { __name: `Level${depth}` }, parent });
    }
    const button = document.createElement("button");
    document.body.append(button);
    mark(button, parent!);
    const chain = select(button).componentChain!;
    expect(chain.components).toHaveLength(64);
    expect(chain.truncated).toBe(true);
    expect(chain.components.at(-1)).not.toHaveProperty("renderParentId");
  });

  it("drops claims to keep a reply of long paths under the bridge's ceiling in bytes", () => {
    // Three UTF-8 bytes a character: the claim budget counts characters, the ceiling bytes.
    let parent: Shape | null = null;
    for (let depth = 0; depth < 64; depth += 1) {
      parent = instance({
        type: { __name: "名".repeat(256), __file: `/p/${"路".repeat(1_900)}/${depth}.vue` },
        parent,
      });
    }
    const button = document.createElement("button");
    document.body.append(button);
    mark(button, parent!);
    const contribution = select(button);
    expect(new TextEncoder().encode(JSON.stringify(contribution)).length).toBeLessThanOrEqual(
      96 * 1024
    );
    const fields = Object.fromEntries(
      (
        contribution.frameworkEvidence?.[0] as { fields: Array<{ name: string; value: unknown }> }
      ).fields.map((entry) => [entry.name, entry.value])
    );
    expect(fields.claimsOmitted).toBeGreaterThan(0);
    // Files the page could not send are not files the runtime hid.
    expect(contribution.capabilities?.file).toEqual({ state: "unknown" });
  });
});

describe("renderedRoots", () => {
  function host(subTree: Shape): VueInstance {
    return instance({ subTree }) as VueInstance;
  }

  it("follows a static block from its first node to its anchor, past blank text", () => {
    const parent = document.createElement("div");
    parent.innerHTML = "<p>a</p>\n  <p>b</p><p>c</p><p>after</p>";
    document.body.append(parent);
    const [a, , c] = Array.from(parent.querySelectorAll("p"));
    const roots = renderedRoots(
      host(vnode({ type: Symbol.for("v-stc"), el: a, anchor: c })),
      32,
      new Budget(100)
    );
    expect(roots.elements.map((node) => node.textContent)).toEqual(["a", "b", "c"]);
    expect(roots.complete).toBe(true);
  });

  it("is incomplete for a static block whose anchor it never reaches, or text outside every root", () => {
    const parent = document.createElement("div");
    parent.innerHTML = "<p>a</p>loose";
    document.body.append(parent);
    const a = parent.querySelector("p")!;
    const elsewhere = document.createElement("p");
    expect(
      renderedRoots(
        host(vnode({ type: Symbol.for("v-stc"), el: a, anchor: elsewhere })),
        32,
        new Budget(100)
      ).complete
    ).toBe(false);
    const text = parent.lastChild!;
    expect(
      renderedRoots(
        host(
          vnode({
            type: Symbol.for("v-fgt"),
            children: [elementVNode(a), vnode({ type: Symbol.for("v-txt"), el: text })],
          })
        ),
        32,
        new Budget(100)
      )
    ).toEqual({ elements: [a], complete: false });
  });

  it("stops at its limit and its budget, and says so", () => {
    const parent = document.createElement("div");
    const children = Array.from({ length: 40 }, () => {
      const node = document.createElement("li");
      parent.append(node);
      return elementVNode(node);
    });
    document.body.append(parent);
    const fragment = host(vnode({ type: Symbol.for("v-fgt"), children }));
    const limited = renderedRoots(fragment, 32, new Budget(1_000));
    expect(limited.elements).toHaveLength(32);
    expect(limited.complete).toBe(false);
    expect(renderedRoots(fragment, 64, new Budget(5)).complete).toBe(false);
  });

  it("counts a teleported child its target already covers once", () => {
    const wrap = document.createElement("div");
    const target = document.createElement("section");
    const moved = document.createElement("aside");
    target.append(moved);
    wrap.append(target);
    document.body.append(wrap);
    const roots = renderedRoots(
      host(
        elementVNode(wrap, [
          elementVNode(target),
          vnode({ type: {}, shapeFlag: 64 | 16, children: [elementVNode(moved)] }),
        ])
      ),
      32,
      new Budget(100)
    );
    expect(roots).toEqual({ elements: [wrap], complete: true });
  });
});

describe("parseStamp", () => {
  const attribute = { kind: "attribute", attribute: "data-v-inspector" } as const;

  it("reads the position from the right, so a drive letter stays in the file", () => {
    expect(parseStamp("C:/work/shop/src/App.vue:12:5", attribute)).toMatchObject({
      file: "C:/work/shop/src/App.vue",
      line: 12,
      column: 5,
    });
  });

  it("refuses positions below the 1-based origin, past the coordinate ceiling, or missing", () => {
    for (const raw of [
      "src/App.vue:0:5",
      "src/App.vue:3:0",
      "src/App.vue:1",
      ":1:1",
      "src/App.vue:99999999:1",
    ]) {
      expect(parseStamp(raw, attribute), raw).toBeNull();
    }
    expect(parseStamp(`${"a".repeat(2_049)}:1:1`, attribute)).toBeNull();
    expect(parseStamp(42, attribute)).toBeNull();
  });
});
