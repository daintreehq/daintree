// @vitest-environment jsdom
import {
  Activity,
  Fragment,
  Suspense,
  act,
  cloneElement,
  createElement,
  createRef,
  forwardRef,
  memo,
  use,
  useEffect,
  useState,
  type ComponentType,
  type ReactElement,
  type ReactNode,
} from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ComponentRecord } from "../../../../../../shared/elementPicker/component.js";
import type { SelectionObservation } from "../../../../../../shared/elementPicker/observation.js";
import type { SourceCandidate } from "../../../../../../shared/elementPicker/source.js";
import {
  ElementPickerEventSchema,
  type ElementPickerEvent,
} from "../../../../../../shared/elementPicker/protocol.js";
import { EXTRACTOR_REGISTRY_GLOBAL } from "../../../guestChannel.js";
import { createPicker, type PickerHandle } from "../../picker.js";
import { installExtractor } from "../../registry.js";
import { createReactExtractor } from "../reactExtractor.js";
import { FIBER_KEY_PREFIX } from "../reactFiber.js";
import { importFixture, removeFixtures } from "./reactFixture.js";

/**
 * The extractor against real React 19 dev output, through the real bridge:
 * the registry it installs into, and the picker that sends its requests and
 * turns its root tokens into element ids. Every event the picker posts is
 * checked against the host's own schema, so each observation here is one the
 * host would admit.
 */

const CHANNEL = "react-test";
const scope = globalThis as Record<string, unknown>;

let fixtures: Record<"plain" | "compiled", ComponentType<{ portal: Element }>>;
let events: ElementPickerEvent[] = [];
let picker: PickerHandle | null = null;
let root: Root | null = null;
let frames: FrameRequestCallback[] = [];

const actFlag = Object.getOwnPropertyDescriptor(scope, "IS_REACT_ACT_ENVIRONMENT");

beforeAll(async () => {
  scope.IS_REACT_ACT_ENVIRONMENT = true;
  fixtures = {
    plain: (await importFixture(false)).App,
    compiled: (await importFixture(true)).App,
  };
}, 60_000);

afterAll(() => {
  removeFixtures();
  if (actFlag) Object.defineProperty(scope, "IS_REACT_ACT_ENVIRONMENT", actFlag);
  else delete scope.IS_REACT_ACT_ENVIRONMENT;
});

beforeEach(() => {
  events = [];
  frames = [];
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    frames.push(callback);
    return frames.length;
  });
  vi.stubGlobal("cancelAnimationFrame", () => {});
  document.body.innerHTML = '<div id="root"></div><div id="portal"></div>';
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  picker?.dispose();
  picker = null;
  (scope[EXTRACTOR_REGISTRY_GLOBAL] as { dispose(): void } | undefined)?.dispose();
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

function mount(App: ComponentType<{ portal: Element }>): void {
  mountTree(createElement(App, { portal: document.getElementById("portal")! }));
}

function mountTree(element: ReactElement): void {
  root = createRoot(document.getElementById("root")!);
  act(() => root!.render(element));
  installExtractor(
    { channel: CHANNEL, framework: "react", installed: false },
    createReactExtractor()
  );
  picker = createPicker({
    channel: CHANNEL,
    mode: "select",
    post: (event) => {
      const parsed = ElementPickerEventSchema.safeParse(event);
      if (!parsed.success) throw new Error(`host would reject ${event.type}: ${parsed.error}`);
      events.push(event);
    },
  });
}

function query(selector: string): Element {
  const node = document.querySelector(selector);
  if (node === null) throw new Error(`no ${selector}`);
  return node;
}

function pick(selector: string): SelectionObservation {
  query(selector).dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  const last = events.filter((event) => event.type === "selectionChanged").at(-1);
  const observation = last?.type === "selectionChanged" ? last.observations[0] : undefined;
  if (observation === undefined) throw new Error(`nothing selected for ${selector}`);
  return observation;
}

function idOf(selector: string): string {
  return pick(selector).elementId;
}

function chainNames(observation: SelectionObservation): Array<string | null> {
  return observation.componentChain.components.map((record) => record.name?.value ?? null);
}

function record(observation: SelectionObservation, name: string): ComponentRecord {
  const found = observation.componentChain.components.find((entry) => entry.name?.value === name);
  if (found === undefined) throw new Error(`no ${name} in ${chainNames(observation).join(", ")}`);
  return found;
}

function kinds(component: ComponentRecord): string[] {
  return component.sourceCandidates.map((candidate) => candidate.kind);
}

function definitionOf(component: ComponentRecord): SourceCandidate | undefined {
  const found = component.sourceCandidates.filter((entry) => entry.kind === "component-definition");
  expect(found.length).toBeLessThanOrEqual(1);
  return found[0];
}

function locationOf(candidate: SourceCandidate | undefined): unknown {
  return candidate !== undefined && candidate.kind !== "file-hint" ? candidate.location : undefined;
}

function nameOf(observation: SelectionObservation, id: string | null | undefined): string | null {
  const found = observation.componentChain.components.find((entry) => entry.componentId === id);
  return found?.name?.value ?? null;
}

function fiberOf(node: Element): Record<string, unknown> {
  const key = Object.keys(node).find((entry) => entry.startsWith(FIBER_KEY_PREFIX))!;
  return (node as unknown as Record<string, Record<string, unknown>>)[key]!;
}

/** Click through React itself, with the picker out of the way of the page's click. */
function press(selector: string): void {
  picker!.setMode("browse");
  act(() => (query(selector) as HTMLButtonElement).click());
  picker!.setMode("select");
}

function bump(): void {
  press(".bump");
}

describe.each(["plain", "compiled"] as const)("the React extractor, compiler %s", (variant) => {
  it("runs the variant it names", () => {
    mount(fixtures[variant]);
    // Compiled components keep their render cache on the fiber; plain ones never make one.
    const app = fiberOf(query("main.app")).return as Record<string, unknown>;
    const cache = (app.updateQueue as { memoCache?: unknown } | null)?.memoCache;
    expect(cache != null).toBe(variant === "compiled");
  });

  it("names the chain by render parent and, separately, by owner", () => {
    mount(fixtures[variant]);
    const observation = pick("button.action-go");
    expect(chainNames(observation)).toEqual(["Button", "Card", "App"]);
    const button = record(observation, "Button");
    expect(observation.componentChain.nearestId).toBe(button.componentId);
    expect(button.name).toEqual({
      value: "Button",
      extraction: { kind: "runtime-field", field: "type.name" },
    });
    // Passed to Card as children: Card renders it, App made it.
    expect(nameOf(observation, button.renderParentId)).toBe("Card");
    expect(nameOf(observation, button.ownerId)).toBe("App");
    const app = record(observation, "App");
    expect(app.renderParentId).toBeNull();
    expect(app.ownerId).toBeNull();
    expect(observation.componentChain.truncated).toBe(false);
    expect(
      observation.componentChain.components.every((entry) => entry.environment === "client")
    ).toBe(true);
  });

  it("reports the element's and its component's creation frames raw, in generated coordinates", () => {
    mount(fixtures[variant]);
    const observation = pick("button.action-go");
    const [own] = observation.sourceCandidates;
    expect(own).toMatchObject({
      kind: "element-creation",
      framework: "react",
      extraction: { kind: "generated-stack-frame", field: "_debugStack" },
      location: { lineBase: 1, columnBase: 1, columnUnit: "utf16" },
    });
    expect(own?.file).toContain(`reactFixture.${variant}`);
    const invocation = record(observation, "Button").sourceCandidates[0];
    expect(invocation).toMatchObject({ kind: "component-invocation", framework: "react" });
    expect(invocation?.file).toContain(`reactFixture.${variant}`);
    // Button's element is made in App, its <button> in Button: two different sites.
    const at = (candidate: typeof own) =>
      candidate !== undefined && candidate.kind !== "file-hint" ? candidate.location : undefined;
    expect(at(invocation)).toBeDefined();
    expect(at(invocation)).not.toEqual(at(own));
    expect(observation.capabilities.file).toEqual({ state: "unknown" });
    expect(observation.capabilities.line).toEqual({ state: "unknown" });
    // App's element was made by this test, outside any render: its stack has no
    // bottom marker and runs past what one record sends, and the rest is counted.
    expect(kinds(record(observation, "App"))).toEqual([
      "component-invocation",
      "component-invocation",
      "component-invocation",
      "component-definition",
    ]);
    const fields =
      observation.frameworkEvidence[0]?.kind === "generic"
        ? observation.frameworkEvidence[0].fields
        : [];
    expect(fields.slice(0, 2)).toEqual([
      { name: "fiberLookup", value: "element" },
      { name: "debugFields", value: true },
    ]);
    const omitted = fields.find((entry) => entry.name === "framesOmitted")?.value;
    expect(typeof omitted === "number" && omitted > 0).toBe(true);
  });

  it("reports where each component is written, from an element it made itself", () => {
    mount(fixtures[variant]);
    const button = pick("button.action-go");
    const [own] = button.sourceCandidates;
    const definition = definitionOf(record(button, "Button"));
    // <button> is Button's own, made directly in the function React called.
    expect(definition).toMatchObject({
      kind: "component-definition",
      framework: "react",
      extraction: { kind: "generated-stack-frame", field: "_debugStack", frameIndex: 1 },
    });
    expect(locationOf(definition)).toEqual(locationOf(own));
    expect(definition?.file).toBe(own?.file);
    // Not where it was called: that is App's code.
    expect(locationOf(definition)).not.toEqual(
      locationOf(record(button, "Button").sourceCandidates[0])
    );

    // Each <li> is made in a callback; the frame React called is Items itself, further down.
    const item = pick("li.item");
    const items = definitionOf(record(item, "Items"));
    const [li] = item.sourceCandidates;
    expect(items?.kind === "component-definition" && items.extraction).toMatchObject({
      kind: "generated-stack-frame",
    });
    const frameIndex = (candidate: SourceCandidate | undefined) =>
      candidate?.extraction.kind === "generated-stack-frame" ? candidate.extraction.frameIndex : -1;
    expect(frameIndex(items)).toBeGreaterThan(frameIndex(li));
    expect(locationOf(items)).not.toEqual(locationOf(li));

    // A memo with a compare renders through its implementation, on its behalf.
    expect(definitionOf(record(pick("span.badge"), "Badge"))).toBeDefined();
    expect(definitionOf(record(pick("input.field"), "Field"))).toBeDefined();
  });

  it("lists every element of a fragment as its component's roots", () => {
    mount(fixtures[variant]);
    const items = [...document.querySelectorAll("li.item")].map((_node, index) =>
      idOf(`li.item:nth-child(${index + 1})`)
    );
    expect(items).toHaveLength(3);
    const list = record(pick("li.item"), "Items");
    expect(list.rootElementIds).toEqual(items);
    // The <li>s' text is inside them, so nothing the component rendered is missing.
    expect(list.rootsComplete).toBe(true);
  });

  it("places a portal's content under the component that rendered it, and among its roots", () => {
    mount(fixtures[variant]);
    const body = idOf(".modal-body");
    const main = idOf("main.app");
    const observation = pick(".modal-body button");
    expect(chainNames(observation)).toEqual(["Button", "Modal", "App"]);
    expect(record(observation, "Modal").rootElementIds).toEqual([body]);
    // The portal's target is outside <main>, so App has two roots.
    expect(record(observation, "App").rootElementIds).toEqual([main, body]);
    expect(record(observation, "App").rootsComplete).toBe(true);
  });

  it("treats memo and forwardRef wrappers as the one component they wrap", () => {
    mount(fixtures[variant]);
    const badge = pick("span.badge");
    // memo with a compare: React's own implementation fiber below it is not a second record.
    expect(chainNames(badge)).toEqual(["Badge", "App"]);
    expect(record(badge, "Badge").name?.extraction).toEqual({
      kind: "runtime-field",
      field: "type.type.name",
    });
    expect(record(badge, "Badge").rootElementIds).toEqual([badge.elementId]);

    const pill = pick("em.pill");
    expect(chainNames(pill)).toEqual(["StatusPill", "App"]);
    expect(record(pill, "StatusPill").name?.extraction).toEqual({
      kind: "runtime-field",
      field: "elementType.displayName",
    });

    const field = pick("input.field");
    expect(chainNames(field)).toEqual(["Field", "App"]);
    expect(record(field, "Field").name?.extraction).toEqual({
      kind: "runtime-field",
      field: "type.render.name",
    });
    expect(record(field, "Field").rootElementIds).toEqual([field.elementId]);
  });

  it("keeps a component's id across renders and reads its roots from the committed tree", () => {
    mount(fixtures[variant]);
    const before = pick("b.notice-title");
    const notice = record(before, "Notice");
    expect(notice.rootElementIds).toEqual([before.elementId]);
    const badgeBefore = record(pick("span.badge"), "Badge").componentId;

    bump();
    // One render on, the title's fiber key is the half React retired, and so is
    // the Notice it returns to: that half still lists the title alone.
    const reached = fiberOf(query("b.notice-title")).return as Record<string, unknown>;
    let children = 0;
    for (
      let child = reached.child as Record<string, unknown> | null;
      child;
      child = child.sibling as Record<string, unknown> | null
    ) {
      children += 1;
    }
    expect(children).toBe(1);

    const after = pick("b.notice-title");
    const noticeAfter = record(after, "Notice");
    expect(noticeAfter.componentId).toBe(notice.componentId);
    expect(noticeAfter.rootElementIds).toEqual([after.elementId, idOf("p.notice-body")]);
    expect(record(pick("span.badge"), "Badge").componentId).toBe(badgeBefore);

    bump();
    expect(record(pick("b.notice-title"), "Notice").componentId).toBe(notice.componentId);
  });

  it("labels a hover with the nearest component alone", () => {
    mount(fixtures[variant]);
    query("button.action-go").dispatchEvent(
      new MouseEvent("pointermove", { bubbles: true, composed: true })
    );
    for (const callback of frames.splice(0)) callback(0);
    const hover = events.find((event) => event.type === "hoverChanged");
    const observation = hover?.type === "hoverChanged" ? hover.observation : null;
    expect(observation?.componentChain.components.map((entry) => entry.name?.value)).toEqual([
      "Button",
    ]);
    expect(observation?.componentChain.truncated).toBe(true);
    expect(observation?.componentChain.components[0]).toMatchObject({
      rootElementIds: [],
      rootsComplete: false,
      sourceCandidates: [],
    });
    expect(observation?.componentChain.components[0]).not.toHaveProperty("renderParentId");
    expect(observation?.sourceCandidates).toEqual([]);
    // The same instance a selection names.
    expect(observation?.componentChain.nearestId).toBe(
      pick("button.action-go").componentChain.nearestId
    );
  });

  it("reads no stack, owner, child or sibling anywhere up the chain on hover", () => {
    mount(fixtures[variant]);
    // Rendered again first, so the ancestry has both halves to read from.
    bump();
    const target = query("button.action-go");
    const fibers = new Set<Record<string, unknown>>();
    for (
      let at = fiberOf(target) as Record<string, unknown> | null;
      at !== null && fibers.size < 200;
      at = at.return as Record<string, unknown> | null
    ) {
      fibers.add(at);
      if (at.alternate) fibers.add(at.alternate as Record<string, unknown>);
    }
    expect([...fibers].some((fiber) => fiber.alternate !== null)).toBe(true);
    const reads: string[] = [];
    const restores: Array<() => void> = [];
    for (const fiber of fibers) {
      for (const key of ["_debugStack", "_debugOwner", "child", "sibling", "stateNode"]) {
        const descriptor = Object.getOwnPropertyDescriptor(fiber, key)!;
        Object.defineProperty(fiber, key, {
          configurable: true,
          get: () => {
            reads.push(key);
            return descriptor.value;
          },
        });
        restores.push(() => Object.defineProperty(fiber as object, key, descriptor));
      }
    }
    try {
      const contribution = createReactExtractor().extract(target, "hover", {
        ref: () => {
          throw new Error("hover named an element");
        },
      });
      expect(contribution?.componentChain?.components).toHaveLength(1);
      expect(reads).toEqual([]);
    } finally {
      for (const restore of restores) restore();
    }
  });
});

describe("the React extractor on what a render hides or hands elsewhere", () => {
  it("leaves content a fallback replaced out of the roots, and lists the fallback", () => {
    const never = new Promise<never>(() => {});
    function Content({ suspended }: { suspended: boolean }) {
      if (suspended) use(never);
      return createElement("article", { className: "content" }, "ready");
    }
    function Gate() {
      const [suspended, setSuspended] = useState(false);
      return createElement(
        Fragment,
        null,
        createElement("button", { className: "suspend", onClick: () => setSuspended(true) }),
        createElement(
          Suspense,
          { fallback: createElement("i", { className: "loading" }, "loading") },
          createElement(Content, { suspended })
        )
      );
    }
    mountTree(createElement(Gate));
    const toggle = idOf("button.suspend");
    const before = record(pick("article.content"), "Gate");
    expect(before.rootElementIds).toEqual([toggle, idOf("article.content")]);

    press("button.suspend");
    // React keeps the content's nodes, hidden; the fallback is what is on screen.
    expect(document.querySelector("article.content")).not.toBeNull();
    const after = record(pick("i.loading"), "Gate");
    expect(after.componentId).toBe(before.componentId);
    expect(after.rootElementIds).toEqual([toggle, idOf("i.loading")]);
    expect(after.rootsComplete).toBe(true);
  });

  it("leaves an Activity it hid out of the roots", () => {
    function Panels() {
      const [hidden, setHidden] = useState(false);
      return createElement(
        Fragment,
        null,
        createElement("nav", { className: "nav", onClick: () => setHidden(true) }),
        createElement(Activity, {
          mode: hidden ? "hidden" : "visible",
          children: createElement("aside", { className: "panel" }),
        })
      );
    }
    mountTree(createElement(Panels));
    const nav = idOf("nav.nav");
    const panel = idOf("aside.panel");
    expect(record(pick("nav.nav"), "Panels").rootElementIds).toEqual([nav, panel]);

    press("nav.nav");
    expect(document.querySelector("aside.panel")).not.toBeNull();
    expect(record(pick("nav.nav"), "Panels").rootElementIds).toEqual([nav]);
  });

  it("names an element's creator even where another component renders it", () => {
    function Badge() {
      return createElement("b", { className: "made" }, "made");
    }
    // Makes the element in its own render and hands it up; renders only text itself.
    function Producer({ onMade }: { onMade: (node: ReactNode) => void }) {
      const [made] = useState(() => createElement(Badge));
      useEffect(() => onMade(made), [made, onMade]);
      return "producer";
    }
    function Consumer({ children }: { children?: ReactNode }) {
      return createElement("div", { className: "consumer" }, children);
    }
    function Page() {
      const [made, setMade] = useState<ReactNode>(null);
      return createElement(
        Fragment,
        null,
        createElement(Producer, { onMade: setMade }),
        createElement(Consumer, null, made)
      );
    }
    mountTree(createElement(Page));
    const observation = pick("b.made");
    expect(chainNames(observation)).toEqual(["Badge", "Consumer", "Page", "Producer"]);
    const badge = record(observation, "Badge");
    expect(nameOf(observation, badge.renderParentId)).toBe("Consumer");
    expect(nameOf(observation, badge.ownerId)).toBe("Producer");
    const producer = record(observation, "Producer");
    // Its record came from the owner edge; nobody walked its render parent.
    expect(producer).not.toHaveProperty("renderParentId");
    expect(nameOf(observation, producer.ownerId)).toBe("Page");
    // Text is all it rendered, and text has no element id.
    expect(producer.rootElementIds).toEqual([]);
    expect(producer.rootsComplete).toBe(false);
    // Nor a stack: the element it made renders under Consumer, so nothing says where it is written.
    expect(kinds(producer)).not.toContain("component-definition");
    expect(kinds(record(observation, "Consumer"))).toContain("component-definition");
    expect(kinds(badge)).toContain("component-definition");
  });
});

describe("the React extractor on an element one component made and another cloned", () => {
  it("claims no definition from a stack React kept when another component took the element", () => {
    // Slot and `asChild` do this: the ref they set makes the clone theirs, the stack stays Parent's.
    function Slot({ children }: { children: ReactElement }) {
      return cloneElement(children, { ref: createRef<HTMLElement>() } as Record<string, unknown>);
    }
    function Parent() {
      return createElement(Slot, null, createElement("i", { className: "cloned" }));
    }
    mountTree(createElement(Parent));
    const node = query("i.cloned");
    const owner = (fiberOf(node)._debugOwner ?? null) as Record<string, unknown> | null;
    expect((owner?.type as { name?: string } | undefined)?.name).toBe("Slot");

    const observation = pick("i.cloned");
    expect(kinds(record(observation, "Slot"))).not.toContain("component-definition");
    expect(kinds(record(observation, "Parent"))).toContain("component-definition");
  });

  it("tells a clone from the cloner's own element by its stack, not by a name both may lack", () => {
    // Both anonymous, as Radix's SlotClone and a `memo(() => …)` page are.
    const Slot = forwardRef<HTMLElement, { children: ReactElement }>((props, ref) =>
      cloneElement(props.children, { ref } as Record<string, unknown>)
    );
    Slot.displayName = "Slot";
    const Page = memo(() => createElement(Slot, null, createElement("i", { className: "anon" })));
    Page.displayName = "Page";
    mountTree(createElement(Page));
    const observation = pick("i.anon");
    expect(kinds(record(observation, "Slot"))).not.toContain("component-definition");
    expect(kinds(record(observation, "Page"))).toContain("component-definition");
  });

  it("looks past a clone to an element the component made itself", () => {
    function Both({ children }: { children: ReactElement }) {
      return [
        cloneElement(children, { key: "clone", ref: createRef<HTMLElement>() } as Record<
          string,
          unknown
        >),
        createElement("span", { key: "own", className: "own" }),
      ];
    }
    function Host() {
      return createElement(Both, null, createElement("i", { className: "handed" }));
    }
    mountTree(createElement(Host));
    const both = record(pick("i.handed"), "Both");
    const span = pick("span.own");
    // Its own <span> says where Both is written: the same frame as the span's own creation.
    expect(locationOf(definitionOf(both))).toEqual(locationOf(span.sourceCandidates[0]));
  });
});

describe("the React extractor on a node React did not render", () => {
  it("describes the nearest rendered ancestor's components but claims no creation site", () => {
    mount(fixtures.plain);
    const widget = document.createElement("canvas");
    query("section.card").appendChild(widget);
    const observation = pick("section.card canvas");
    expect(chainNames(observation)).toEqual(["Card", "App"]);
    expect(observation.sourceCandidates).toEqual([]);
    expect(observation.frameworkEvidence[0]).toMatchObject({
      fields: expect.arrayContaining([{ name: "fiberLookup", value: "ancestor" }]),
    });
  });

  it("contributes nothing for a page React is not on", () => {
    document.body.innerHTML = "<p>plain</p>";
    const contribution = createReactExtractor().extract(query("p"), "selection", {
      ref: () => null,
    });
    expect(contribution).toBeNull();
  });
});
