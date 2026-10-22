// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { SelectionObservationSchema } from "../../../../../../shared/elementPicker/observation.js";
import { MAX_ELEMENT_PICKER_MESSAGE_BYTES } from "../../../../../../shared/elementPicker/protocol.js";
import { MAX_BRIDGE_MESSAGE_CHARS } from "../../../guestChannel.js";
import type { ExtractorContribution } from "../../types.js";
import { createReactExtractor } from "../reactExtractor.js";
import {
  Budget,
  FIBER_KEY_PREFIX,
  FIBER_TAGS,
  FiberIds,
  committedFiber,
  componentName,
  hostRoots,
  type Fiber,
} from "../reactFiber.js";

/**
 * Hand-built fibers, for the shapes a real React tree never takes but a page
 * can still hand us: loops, depths and widths past every bound, missing debug
 * fields. Real React output is `reactExtractor.test.ts`'s.
 */

function fiber(tag: number, fields: Record<string, unknown> = {}): Fiber {
  return {
    tag,
    type: null,
    elementType: null,
    return: null,
    child: null,
    sibling: null,
    alternate: null,
    stateNode: null,
    memoizedState: null,
    _debugOwner: null,
    _debugStack: null,
    ...fields,
  };
}

function link(parent: Fiber, children: Fiber[]): Fiber {
  parent.child = children[0] ?? null;
  children.forEach((child, index) => {
    child.return = parent;
    child.sibling = children[index + 1] ?? null;
  });
  return parent;
}

function host(tagName = "div"): Fiber {
  return fiber(FIBER_TAGS.hostComponent, {
    type: tagName,
    stateNode: document.createElement(tagName),
  });
}

function component(name: string, fields: Record<string, unknown> = {}): Fiber {
  const type = { [name]: () => null }[name]!;
  return fiber(FIBER_TAGS.functionComponent, { type, elementType: type, ...fields });
}

function hostRoot(): Fiber {
  const root = fiber(FIBER_TAGS.hostRoot);
  root.stateNode = { current: root };
  return root;
}

/** Mounts `leaf`'s element in the document with `leaf` as its fiber, as react-dom would. */
function attach(leaf: Fiber): Element {
  const node = leaf.stateNode as Element;
  (node as unknown as Record<string, unknown>)[`${FIBER_KEY_PREFIX}test`] = leaf;
  document.body.appendChild(node);
  return node;
}

afterEach(() => {
  document.body.innerHTML = "";
});

const refs = { ref: (node: Element) => (node.isConnected ? `ref-${node.localName}` : null) };

function select(node: Element): ExtractorContribution {
  const contribution = createReactExtractor().extract(node, "selection", refs);
  if (contribution === null) throw new Error("no contribution");
  // The host's own schema, with the picker's neutral fields around the contribution.
  const parsed = SelectionObservationSchema.safeParse({
    phase: "selection",
    elementId: "el-1",
    tagName: node.localName,
    label: "",
    bounds: [],
    detections: [],
    componentChain: contribution.componentChain,
    sourceCandidates: contribution.sourceCandidates ?? [],
    capabilities: contribution.capabilities,
    frameworkEvidence: contribution.frameworkEvidence ?? [],
  });
  if (!parsed.success) throw new Error(`host would reject it: ${parsed.error}`);
  return contribution;
}

describe("hostRoots", () => {
  it("stops at its limit and says the list is incomplete", () => {
    const list = link(
      component("List"),
      Array.from({ length: 40 }, () => host("li"))
    );
    const roots = hostRoots(list, 32, new Budget(10_000));
    expect(roots.elements).toHaveLength(32);
    expect(roots.complete).toBe(false);
  });

  it("ends a walk around a sibling loop at its budget", () => {
    const looping = host();
    const loop = link(component("Loop"), [looping]);
    looping.sibling = looping;
    const roots = hostRoots(loop, 32, new Budget(500));
    expect(roots.elements).toEqual([looping.stateNode]);
    expect(roots.complete).toBe(false);
  });

  it("counts text only where no element covers it, and skips what React hides", () => {
    const covered = link(host("p"), [fiber(FIBER_TAGS.hostText)]);
    const hidden = link(fiber(FIBER_TAGS.offscreen, { memoizedState: {} }), [host("aside")]);
    const resource = fiber(FIBER_TAGS.hostHoistable);
    const tree = link(component("Panel"), [covered, hidden, resource]);
    expect(hostRoots(tree, 32, new Budget(1_000))).toEqual({
      elements: [covered.stateNode],
      complete: true,
    });

    const bare = link(component("Label"), [fiber(FIBER_TAGS.hostText)]);
    expect(hostRoots(bare, 32, new Budget(1_000))).toEqual({ elements: [], complete: false });
  });

  it("finds a portal's content below a host node only when it renders outside that node", () => {
    const outside = document.createElement("div");
    const frame = host("main");
    const inside = document.createElement("div");
    (frame.stateNode as Element).appendChild(inside);
    const away = link(fiber(FIBER_TAGS.hostPortal, { stateNode: { containerInfo: outside } }), [
      host("dialog"),
    ]);
    const home = link(fiber(FIBER_TAGS.hostPortal, { stateNode: { containerInfo: inside } }), [
      host("span"),
    ]);
    const awayNode = (away.child as Fiber).stateNode as Element;
    outside.appendChild(awayNode);
    inside.appendChild((home.child as Fiber).stateNode as Element);
    link(frame, [away, home]);
    expect(hostRoots(link(component("Shell"), [frame]), 32, new Budget(1_000))).toEqual({
      elements: [frame.stateNode, awayNode],
      complete: true,
    });
  });

  it("lists a root portaled into another of the component's roots once, under it", () => {
    const frame = host("main");
    const into = link(
      fiber(FIBER_TAGS.hostPortal, { stateNode: { containerInfo: frame.stateNode } }),
      [host("dialog")]
    );
    (frame.stateNode as Element).appendChild((into.child as Fiber).stateNode as Element);
    // The portal comes first, before the root that turns out to hold it.
    expect(hostRoots(link(component("Shell"), [into, frame]), 32, new Budget(1_000))).toEqual({
      elements: [frame.stateNode],
      complete: true,
    });
  });

  it("counts text a root collected later turns out to hold as covered", () => {
    const frame = host("main");
    const text = document.createTextNode("hi");
    (frame.stateNode as Element).appendChild(text);
    const into = link(
      fiber(FIBER_TAGS.hostPortal, { stateNode: { containerInfo: frame.stateNode } }),
      [fiber(FIBER_TAGS.hostText, { stateNode: text })]
    );
    expect(hostRoots(link(component("Shell"), [into, frame]), 32, new Budget(1_000))).toEqual({
      elements: [frame.stateNode],
      complete: true,
    });
  });

  it("marks a node it cannot represent, or cannot safely inspect, incomplete without throwing", () => {
    const foreign = fiber(FIBER_TAGS.hostHoistable, { stateNode: { nodeType: 1 } });
    expect(hostRoots(link(component("Head"), [foreign]), 32, new Budget(100)).complete).toBe(false);

    const { proxy, revoke } = Proxy.revocable({}, {});
    revoke();
    const hostile = fiber(FIBER_TAGS.hostComponent, { stateNode: proxy });
    const after = host("p");
    const roots = hostRoots(link(component("Hostile"), [hostile, after]), 32, new Budget(100));
    expect(roots).toEqual({ elements: [after.stateNode], complete: false });
  });

  it("counts a component that rendered nothing as complete", () => {
    expect(hostRoots(component("Empty"), 32, new Budget(10))).toEqual({
      elements: [],
      complete: true,
    });
  });
});

describe("committedFiber", () => {
  function pair(parentA: Fiber, parentB: Fiber): [Fiber, Fiber] {
    const a = host();
    const b = fiber(FIBER_TAGS.hostComponent, { stateNode: a.stateNode, alternate: a });
    a.alternate = b;
    link(parentA, [a]);
    link(parentB, [b]);
    return [a, b];
  }

  it("takes the half the root's committed tree holds", () => {
    const committedRoot = hostRoot();
    const retiredRoot = fiber(FIBER_TAGS.hostRoot, {
      stateNode: committedRoot.stateNode,
      alternate: committedRoot,
    });
    committedRoot.alternate = retiredRoot;
    const [committed, retired] = pair(committedRoot, retiredRoot);
    expect(committedFiber(retired, new Budget(100))).toBe(committed);
    expect(committedFiber(committed, new Budget(100))).toBe(committed);
  });

  it("decides from a parent both halves share, as a bailed-out subtree leaves them", () => {
    const parent = component("Parent");
    const parentAlternate = component("Parent", { alternate: parent });
    parent.alternate = parentAlternate;
    const committed = host();
    const retired = fiber(FIBER_TAGS.hostComponent, { alternate: committed });
    committed.alternate = retired;
    link(parent, [committed]);
    parentAlternate.child = committed;
    retired.return = parent;
    expect(committedFiber(retired, new Budget(100))).toBe(committed);
  });

  it("keeps the fiber it was given when the budget runs out or the tree lies", () => {
    const loose = host();
    loose.alternate = host();
    expect(committedFiber(loose, new Budget(0))).toBe(loose);
    expect(committedFiber(loose, new Budget(100))).toBe(loose);
  });
});

describe("FiberIds", () => {
  it("folds memo(memo(fn)) into its outer memo, whichever fiber is asked about", () => {
    const ids = new FiberIds("react-");
    const outer = fiber(FIBER_TAGS.memo);
    const inner = fiber(FIBER_TAGS.memo);
    const implementation = component("Inner");
    link(outer, [inner]);
    link(inner, [implementation]);
    expect(ids.idOf(implementation)).toBe(ids.idOf(outer));
    expect(ids.idOf(inner)).toBe(ids.idOf(outer));
  });

  it("gives both halves of a pair, and a memo's implementation, the memo's one id", () => {
    const ids = new FiberIds("react-");
    const memo = fiber(FIBER_TAGS.memo);
    const implementation = component("Inner");
    link(memo, [implementation]);
    const half = component("Card");
    const other = component("Card", { alternate: half });
    half.alternate = other;
    expect(ids.idOf(implementation)).toBe(ids.idOf(memo));
    expect(ids.idOf(other)).toBe(ids.idOf(half));
    expect(ids.idOf(component("Card"))).not.toBe(ids.idOf(half));
  });
});

describe("componentName", () => {
  it("reads a name where React does, and says where", () => {
    const named = (name: string) => ({ [name]: () => null })[name]!;
    const inner = named("Inner");
    const forwarded = { render: inner };
    expect(componentName(fiber(FIBER_TAGS.memo, { type: { type: forwarded } }))).toEqual({
      value: "Inner",
      field: "type.type.render.name",
    });
    const shown = Object.assign(named("Raw"), { displayName: "Shown" });
    expect(componentName(component("x", { type: shown }))).toEqual({
      value: "Shown",
      field: "type.displayName",
    });
    expect(componentName(component("x", { type: named("N".repeat(400)) }))?.value).toHaveLength(
      256
    );
  });

  it("reports an anonymous component as anonymous, and survives a hostile type", () => {
    const anonymous = (
      () => () =>
        null
    )();
    expect(componentName(component("x", { type: anonymous }))).toBeNull();
    const hostile = new Proxy(
      {},
      {
        get() {
          throw new Error("no");
        },
      }
    );
    expect(componentName(fiber(FIBER_TAGS.forwardRef, { type: hostile }))).toBeNull();
    const looping: Record<string, unknown> = {};
    looping.type = looping;
    expect(componentName(fiber(FIBER_TAGS.memo, { type: looping }))).toBeNull();
  });
});

describe("the React extractor on a hostile or partial tree", () => {
  it("ends at a return loop and sends a chain the host accepts", () => {
    const leaf = host("button");
    const a = component("A");
    const b = component("B");
    leaf.return = a;
    a.return = b;
    b.return = a;
    const chain = select(attach(leaf)).componentChain!;
    expect(chain.components.map((record) => record.name?.value)).toEqual(["A", "B"]);
    expect(chain.truncated).toBe(true);
    expect(chain.components[1]).not.toHaveProperty("renderParentId");
  });

  it("stops a deep chain at its record limit, leaving the edge it did not follow out", () => {
    const leaf = host("button");
    let below = leaf;
    for (let depth = 0; depth < 100; depth += 1) {
      const next = component(`Level${depth}`);
      below.return = next;
      below = next;
    }
    below.return = hostRoot();
    const chain = select(attach(leaf)).componentChain!;
    expect(chain.components).toHaveLength(64);
    expect(chain.truncated).toBe(true);
    expect(chain.components.at(-1)).not.toHaveProperty("renderParentId");
  });

  it("cuts an owner loop rather than sending one", () => {
    const leaf = host("button");
    const a = component("A");
    const b = component("B");
    leaf.return = a;
    a.return = b;
    b.return = hostRoot();
    a._debugOwner = b;
    b._debugOwner = a;
    const chain = select(attach(leaf)).componentChain!;
    expect(chain.truncated).toBe(true);
    expect(chain.components.filter((record) => typeof record.ownerId === "string")).toHaveLength(1);
  });

  it("gives an owner outside the render chain a record of its own, with no render parent claimed", () => {
    const leaf = host("button");
    const rendered = component("Slot");
    const creator = component("Page");
    leaf.return = rendered;
    rendered.return = hostRoot();
    rendered._debugOwner = creator;
    const chain = select(attach(leaf)).componentChain!;
    expect(chain.components.map((record) => record.name?.value)).toEqual(["Slot", "Page"]);
    const [slot, page] = chain.components;
    expect(slot?.ownerId).toBe(page?.componentId);
    expect(page).not.toHaveProperty("renderParentId");
  });

  it("sends at most four frames a record, within the reply's share, and counts every one it held back", () => {
    const frames = (count: number, file: string) => ({
      stack: [
        "Error: react-stack-top-frame",
        "    at jsxDEV (http://localhost/react.js:1:1)",
        ...Array.from({ length: count }, (_, at) => `    at F${at} (${file}:${at + 1}:1)`),
        "    at Object.react_stack_bottom_frame (http://localhost/react-dom.js:1:1)",
      ].join("\n"),
    });
    const leaf = host("button");
    leaf._debugStack = frames(6, "http://localhost/src/leaf.tsx");
    let below = leaf;
    const long = "http://localhost/src/" + "x".repeat(1_500) + ".tsx";
    for (let depth = 0; depth < 40; depth += 1) {
      const next = component(`Level${depth}`, { _debugStack: frames(5, long) });
      below.return = next;
      below = next;
    }
    below.return = hostRoot();
    const contribution = select(attach(leaf));
    const sent = [
      ...(contribution.sourceCandidates ?? []),
      ...contribution.componentChain!.components.flatMap((record) => record.sourceCandidates),
    ];
    expect(contribution.sourceCandidates).toHaveLength(4);
    expect(
      contribution.componentChain!.components.every((record) => record.sourceCandidates.length <= 4)
    ).toBe(true);
    // The outer records' long frames ran past the reply's share.
    expect(contribution.componentChain!.components.at(-1)?.sourceCandidates).toEqual([]);
    const omitted = contribution.frameworkEvidence?.[0];
    expect(omitted).toMatchObject({
      fields: expect.arrayContaining([{ name: "framesOmitted", value: 6 + 40 * 5 - sent.length }]),
    });
    expect(new Set(sent.map((candidate) => candidate.candidateId)).size).toBe(sent.length);
  });

  it("drops frames, then outer records, until a reply of page-sized names fits", () => {
    const stack = {
      stack: [
        "Error: react-stack-top-frame",
        "    at jsxDEV (http://localhost/react.js:1:1)",
        "    at A (http://localhost/src/a.tsx:1:1)",
        "    at B (http://localhost/src/b.tsx:2:2)",
        "    at Object.react_stack_bottom_frame (http://localhost/react-dom.js:1:1)",
      ].join("\n"),
    };
    const leaf = host("button");
    let below = leaf;
    for (let depth = 0; depth < 64; depth += 1) {
      // Every character escapes to six in JSON.
      const next = component("\u0001".repeat(250) + String(depth).padStart(2, "0"), {
        _debugStack: stack,
      });
      below.return = next;
      below = next;
    }
    below.return = hostRoot();
    const contribution = select(attach(leaf));
    const chain = contribution.componentChain!;
    expect(chain.components.length).toBeGreaterThan(0);
    expect(chain.components.length).toBeLessThan(64);
    expect(chain.truncated).toBe(true);
    expect(chain.nearestId).toBe(chain.components[0]?.componentId);
    // Frames went first, every one of them counted, and the line is still the host's to find.
    expect(chain.components.every((record) => record.sourceCandidates.length === 0)).toBe(true);
    expect(contribution.frameworkEvidence?.[0]).toMatchObject({
      fields: expect.arrayContaining([{ name: "framesOmitted", value: 64 * 2 }]),
    });
    expect(contribution.capabilities?.line).toEqual({ state: "unknown" });
    // It survives the bridge, and the host's envelope around it.
    const text = JSON.stringify(contribution);
    expect(text.length).toBeLessThanOrEqual(MAX_BRIDGE_MESSAGE_CHARS);
    expect(new TextEncoder().encode(text).length).toBeLessThan(MAX_ELEMENT_PICKER_MESSAGE_BYTES);
  });

  it("says a build without debug fields is not a dev build, and claims no owners", () => {
    const leaf = host("button");
    delete leaf._debugOwner;
    delete leaf._debugStack;
    const app = component("a");
    delete app._debugOwner;
    delete app._debugStack;
    leaf.return = app;
    app.return = hostRoot();
    const contribution = select(attach(leaf));
    expect(contribution.componentChain?.components[0]).not.toHaveProperty("ownerId");
    expect(contribution.capabilities?.file).toEqual({
      state: "unavailable",
      reason: "production-build",
    });
    expect(contribution.capabilities?.names).toEqual({ state: "available" });
  });
});
