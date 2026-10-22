import { h, render, type ComponentChild, type ComponentChildren } from "preact";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ComponentRecord } from "../../../../../shared/elementPicker/component.js";
import type {
  HoverObservation,
  SelectionObservation,
} from "../../../../../shared/elementPicker/observation.js";
import {
  ElementPickerEventSchema,
  type ElementPickerEvent,
} from "../../../../../shared/elementPicker/protocol.js";
import { EXTRACTOR_REGISTRY_GLOBAL } from "../../guestChannel.js";
import { createPicker, type PickerHandle } from "../picker.js";
import { createPreactExtractor } from "../preact/extractor.js";
import { installExtractor } from "../registry.js";
import { importFixture, removeFixtures, sourcePosition, type Fixture } from "./preactFixture.js";

/**
 * The extractor against a real Preact 11 page, through the real bridge: the
 * registry it installs into, and the picker that sends its requests and turns
 * its root tokens into element ids. Every event the picker posts is checked
 * against the host's own schema, so each observation here is one the host
 * would admit.
 *
 * Run twice, by two files: once on a page that never loaded `preact/debug`,
 * once on one that did. Debug patches Preact's own `options` for the life of
 * the module, so each page needs a module graph of its own.
 */
export function describePreactExtractor(debug: boolean): void {
  const CHANNEL = debug ? "preact-debug-test" : "preact-test";
  const scope = globalThis as Record<string, unknown>;

  let fixture: Fixture;
  let events: ElementPickerEvent[] = [];
  let picker: PickerHandle | null = null;
  let root: Element | null = null;
  let frames: FrameRequestCallback[] = [];

  beforeAll(async () => {
    fixture = await importFixture();
  }, 60_000);

  afterAll(() => {
    removeFixtures();
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
    if (root !== null) render(null, root);
    root = null;
    picker?.dispose();
    picker = null;
    (scope[EXTRACTOR_REGISTRY_GLOBAL] as { dispose(): void } | undefined)?.dispose();
    vi.unstubAllGlobals();
    document.body.innerHTML = "";
  });

  function draw(tree: ComponentChild): void {
    root = document.getElementById("root")!;
    render(tree, root);
  }

  function start(): void {
    installExtractor(
      { channel: CHANNEL, framework: "preact", installed: false },
      createPreactExtractor()
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

  /** Detection done, Preact's the one reader installed: a null from it now reads as nothing found. */
  function settle(): void {
    picker!.setAvailability({ detection: "settled", extractors: { preact: "installed" } });
  }

  function app(count = 0): ComponentChild {
    return h(fixture.App, { portal: document.getElementById("portal")!, count });
  }

  function mount(): void {
    draw(app());
    start();
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

  function hovered(selector: string): HoverObservation | null {
    query(selector).dispatchEvent(new MouseEvent("pointermove", { bubbles: true, composed: true }));
    for (const callback of frames.splice(0)) callback(0);
    const last = events.filter((event) => event.type === "hoverChanged").at(-1);
    return last?.type === "hoverChanged" ? last.observation : null;
  }

  function hover(selector: string): string[] {
    return (hovered(selector)?.componentChain.components ?? []).map(
      (entry) => entry.name?.value ?? "(anonymous)"
    );
  }

  function idOf(selector: string): string {
    return pick(selector).elementId;
  }

  function chainNames(observation: SelectionObservation): Array<string | null> {
    return observation.componentChain.components.map((entry) => entry.name?.value ?? null);
  }

  function record(observation: SelectionObservation, name: string): ComponentRecord {
    const found = observation.componentChain.components.find((entry) => entry.name?.value === name);
    if (found === undefined) throw new Error(`no ${name} in ${chainNames(observation).join(", ")}`);
    return found;
  }

  function nameOf(observation: SelectionObservation, id: string | null | undefined): string | null {
    const found = observation.componentChain.components.find((entry) => entry.componentId === id);
    return found?.name?.value ?? null;
  }

  function evidence(observation: SelectionObservation): Record<string, unknown> {
    const entry = observation.frameworkEvidence[0];
    return entry?.kind === "generic"
      ? Object.fromEntries(entry.fields.map((field) => [field.name, field.value]))
      : {};
  }

  function at(marker: string) {
    return { lineBase: 1, columnBase: 1, columnUnit: "utf16", ...sourcePosition(marker) };
  }

  describe(`the Preact extractor, preact/debug ${debug ? "loaded" : "not loaded"}`, () => {
    it("names the chain by render parent, leaving out Preact's own fragments and providers", () => {
      mount();
      const observation = pick("button.action-go");
      expect(chainNames(observation)).toEqual(["Button", "Card", "App"]);
      const button = record(observation, "Button");
      expect(observation.componentChain.nearestId).toBe(button.componentId);
      expect(button.name).toEqual({
        value: "Button",
        extraction: { kind: "runtime-field", field: "type.name" },
      });
      // Passed to Card as children: Card renders it. Who made it, Preact never records.
      expect(nameOf(observation, button.renderParentId)).toBe("Card");
      expect(record(observation, "App").renderParentId).toBeNull();
      for (const entry of observation.componentChain.components) {
        expect(entry).not.toHaveProperty("ownerId");
        expect(entry.framework).toBe("preact");
      }
      expect(observation.componentChain.truncated).toBe(false);
    });

    it("reports where the element and each invocation were written, from __source", () => {
      mount();
      const observation = pick("button.action-go");
      expect(observation.sourceCandidates).toEqual([
        {
          kind: "element-creation",
          candidateId: expect.any(String),
          framework: "preact",
          extraction: { kind: "runtime-field", field: "__source" },
          file: fixture.file,
          location: at('<button class={"action'),
        },
      ]);
      expect(record(observation, "Button").sourceCandidates).toEqual([
        expect.objectContaining({
          kind: "component-invocation",
          file: fixture.file,
          location: at('<Button label="go"'),
        }),
      ]);
      expect(record(observation, "Card").sourceCandidates).toEqual([
        expect.objectContaining({ location: at('<Card title="Fixture">') }),
      ]);
      // App was made by this test with `h`, by no transform at all.
      expect(record(observation, "App").sourceCandidates).toEqual([]);
      expect(observation.capabilities).toMatchObject({
        file: { state: "available" },
        line: { state: "available" },
        exactRange: { state: "unknown" },
      });
    });

    it("names a class component, and places an aliased invocation where the alias is written", () => {
      mount();
      const observation = pick("button.action-aliased");
      expect(chainNames(observation)).toEqual(["Button", "Panel", "App"]);
      expect(record(observation, "Panel").name?.extraction).toEqual({
        kind: "runtime-field",
        field: "type.name",
      });
      expect(record(observation, "Button").sourceCandidates).toEqual([
        expect.objectContaining({ location: at('<Alias label="aliased"') }),
      ]);
    });

    it("lists every element of a fragment as its component's roots", () => {
      mount();
      const items = [1, 2, 3].map((index) => idOf(`li.item:nth-child(${index})`));
      const observation = pick("li.item");
      expect(chainNames(observation)).toEqual(["Items", "App"]);
      const list = record(observation, "Items");
      expect(list.rootElementIds).toEqual(items);
      expect(list.rootsComplete).toBe(true);
    });

    it("places a portal's content under the component that rendered it, and among its roots", () => {
      mount();
      const body = idOf(".modal-body");
      const main = idOf("main.app");
      const observation = pick(".modal-body button");
      expect(chainNames(observation)).toEqual(["Button", "Modal", "App"]);
      expect(evidence(observation).vnodeLookup).toBe("element");
      expect(record(observation, "Modal").rootElementIds).toEqual([body]);
      // The portal's target is outside <main>, so App has two roots.
      expect(record(observation, "App").rootElementIds).toEqual([main, body]);
      expect(record(observation, "App").rootsComplete).toBe(true);
    });

    it("leaves an anonymous component unnamed rather than guessing", () => {
      mount();
      const observation = pick("i.anonymous");
      expect(chainNames(observation)).toEqual([null, "App"]);
      expect(observation.componentChain.components[0]?.sourceCandidates).toEqual([
        expect.objectContaining({ location: at("<Anonymous />") }),
      ]);
    });

    it("reads an SVG element's source under the element's own case", () => {
      mount();
      const observation = pick("linearGradient");
      expect(observation.tagName).toBe("linearGradient");
      expect(observation.sourceCandidates[0]).toMatchObject({
        kind: "element-creation",
        location: at("<linearGradient"),
      });
    });

    it("gives markup the page inserted its rendered ancestor's components, and no source of its own", () => {
      mount();
      const injected = document.createElement("em");
      injected.className = "injected";
      query("div.panel").appendChild(injected);
      const observation = pick("em.injected");
      expect(chainNames(observation)).toEqual(["Panel", "App"]);
      expect(observation.sourceCandidates).toEqual([]);
      expect(evidence(observation).vnodeLookup).toBe("ancestor");
    });

    it("keeps a component's id across renders", () => {
      mount();
      const before = record(pick("button.action-go"), "Button").componentId;
      draw(app(1));
      expect(query("main.app").getAttribute("data-count")).toBe("1");
      expect(record(pick("button.action-go"), "Button").componentId).toBe(before);
    });

    it("labels a hover with the nearest component alone, the same instance a selection names", () => {
      mount();
      expect(hover("button.action-go")).toEqual(["Button"]);
      const label = events.filter((event) => event.type === "hoverChanged").at(-1);
      const observation = label?.type === "hoverChanged" ? label.observation : null;
      expect(observation?.componentChain.truncated).toBe(true);
      expect(observation?.sourceCandidates).toEqual([]);
      expect(observation?.componentChain.components[0]).toMatchObject({
        rootElementIds: [],
        sourceCandidates: [],
      });
      expect(observation?.componentChain.nearestId).toBe(
        pick("button.action-go").componentChain.nearestId
      );
    });

    it("never sweeps the document on hover: a portal's tree is found once a selection has", () => {
      mount();
      expect(hover(".modal-body")).toEqual([]);
      pick("main.app");
      expect(hover(".modal-body button")).toEqual(["Button"]);
    });

    it("widens to the next component's rendered roots with Alt+ArrowUp", () => {
      mount();
      const items = [1, 2, 3].map((index) => idOf(`li.item:nth-child(${index})`));
      const itemsId = record(pick("li.item"), "Items").componentId;
      const event = new KeyboardEvent("keydown", {
        key: "ArrowUp",
        altKey: true,
        bubbles: true,
        cancelable: true,
      });
      window.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(true);
      const widened = events.filter((entry) => entry.type === "selectionChanged").at(-1);
      expect(widened?.type === "selectionChanged" && widened.scope).toEqual({
        kind: "component",
        componentId: itemsId,
      });
      expect(
        widened?.type === "selectionChanged"
          ? widened.observations.map((observation) => observation.elementId)
          : []
      ).toEqual(items);
    });

    it("names and selects components a tree built without jsx-source still has, saying it gives no file or line", () => {
      const Shell = ({ children }: { children?: ComponentChildren }) =>
        h("section", { class: "shell" }, children);
      const Leaf = () => h("b", { class: "leaf" }, "leaf");
      draw(h(Shell, null, h(Leaf, null)));
      start();
      settle();
      const observation = pick("b.leaf");
      expect(chainNames(observation)).toEqual(["Leaf", "Shell"]);
      expect(observation.sourceCandidates).toEqual([]);
      expect(
        observation.componentChain.components.flatMap((entry) => entry.sourceCandidates)
      ).toEqual([]);
      expect(observation.capabilities).toEqual({
        names: { state: "available" },
        chain: { state: "available" },
        componentSelection: { state: "available" },
        file: { state: "unavailable", reason: "not-exposed" },
        line: { state: "unavailable", reason: "not-exposed" },
        exactRange: { state: "unavailable", reason: "not-exposed" },
      });

      window.dispatchEvent(
        new KeyboardEvent("keydown", { key: "ArrowUp", altKey: true, bubbles: true })
      );
      const widened = events.filter((entry) => entry.type === "selectionChanged").at(-1);
      expect(widened?.type === "selectionChanged" && widened.scope).toEqual({
        kind: "component",
        componentId: record(observation, "Leaf").componentId,
      });
    });

    it(`reads a source a createElement call carried in props${debug ? ", as preact/debug lifted it" : ""}`, () => {
      draw(
        h("button", {
          class: "sourced",
          __source: { fileName: "/app/src/Legacy.jsx", lineNumber: 4, columnNumber: 7 },
        } as Record<string, unknown>)
      );
      start();
      expect(pick("button.sourced").sourceCandidates).toEqual([
        expect.objectContaining({
          extraction: { kind: "runtime-field", field: debug ? "__source" : "props.__source" },
          file: "/app/src/Legacy.jsx",
          location: { lineBase: 1, columnBase: 1, columnUnit: "utf16", line: 4, column: 7 },
        }),
      ]);
    });

    it("says whether the page's vnodes carry preact/debug's prototype", () => {
      mount();
      expect(evidence(pick("button.action-go")).debugPrototype).toBe(debug);
    });

    it("keeps a reply of long paths and wide names inside the bridge's ceiling, sources first", () => {
      const source = {
        fileName: "/app/src/" + "nested/".repeat(285) + "Wide.tsx",
        lineNumber: 1,
        columnNumber: 1,
      };
      const Wide = ({ depth }: { depth: number }): ComponentChild => {
        const props = { depth: depth - 1, __source: source };
        return depth === 0 ? h("i", { class: "wide" }) : h(Wide, props);
      };
      // Three UTF-8 bytes a character, past the name ceiling.
      Wide.displayName = "漢".repeat(300);
      const top = { depth: 64, __source: source };
      draw(h(Wide, top));
      start();
      // Unbounded, this reply would be too big for the bridge, which drops it whole.
      const observation = pick("i.wide");
      const records = observation.componentChain.components;
      expect(records.length).toBeGreaterThan(0);
      expect(records[0]?.name?.value).toBe("漢".repeat(256));
      const omitted = evidence(observation).sourcesOmitted;
      expect(typeof omitted === "number" && omitted > 0).toBe(true);
      // Sources held back for size are still sources the page exposed.
      expect(observation.capabilities.file).toEqual({ state: "available" });
    });

    it("stays within the bridge's ceiling however deep the chain runs", () => {
      const Nest = ({ depth }: { depth: number }): ComponentChild =>
        depth === 0 ? h("i", { class: "deep" }) : h(Nest, { depth: depth - 1 });
      draw(h(Nest, { depth: 100 }));
      start();
      const observation = pick("i.deep");
      expect(observation.componentChain.components).toHaveLength(64);
      expect(observation.componentChain.truncated).toBe(true);
      expect(chainNames(observation).every((name) => name === "Nest")).toBe(true);
      // The outermost record kept has a render parent nobody sent: it is left out, not dangling.
      expect(observation.componentChain.components.at(-1)).not.toHaveProperty("renderParentId");
    });

    it("says Preact drew nothing at a node outside every tree a full sweep found", () => {
      mount();
      settle();
      document.body.appendChild(document.createElement("p")).className = "plain";
      expect(pick("p.plain").capabilities.names).toEqual({
        state: "unavailable",
        reason: "not-exposed",
      });
    });

    it("gives no answer, rather than none found, when a selection's lookup runs out of steps", () => {
      // The root's children alone outrun the lookup before it reaches the picked node's parent.
      const filler = Array.from({ length: 9_000 }, (_, index) => h("i", { key: index }));
      draw([h("div", { class: "holder" }, h("b", { class: "far" }, "far")), ...filler]);
      start();
      settle();
      const observation = pick("b.far");
      expect(observation.componentChain.components).toEqual([]);
      expect(observation.capabilities.names).toEqual({ state: "unknown" });
      expect(observation.capabilities.file).toEqual({ state: "unknown" });
    });

    it("gives no answer where a selection's sweep stopped short of the whole page", () => {
      mount();
      settle();
      for (let index = 0; index < 2_100; index += 1) {
        document.body.appendChild(document.createElement("span"));
      }
      document.body.appendChild(document.createElement("p")).className = "plain";
      expect(pick("p.plain").capabilities.names).toEqual({ state: "unknown" });
    });

    it("gives a hover no answer where only a sweep would find the tree, not that Preact drew nothing", () => {
      mount();
      settle();
      // The portal's content, whose tree no hover has met yet.
      const observation = hovered(".modal-body");
      expect(observation?.componentChain.components).toEqual([]);
      expect(observation?.capabilities.names).toEqual({ state: "unknown" });
    });

    it("throws once disposed, so it never reads as having found nothing", () => {
      draw(h("b", { class: "leaf" }, "leaf"));
      const extractor = createPreactExtractor();
      const target = query("b.leaf");
      const refs = { ref: () => null };
      expect(extractor.extract(target, "selection", refs)).not.toBeNull();
      extractor.dispose?.();
      expect(() => extractor.extract(target, "selection", refs)).toThrow();
      expect(() => extractor.extract(target, "hover", refs)).toThrow();
    });
  });
}
