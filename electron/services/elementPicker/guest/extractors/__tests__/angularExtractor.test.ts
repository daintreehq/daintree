// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ComponentRecord } from "../../../../../../shared/elementPicker/component.js";
import type { GenericEvidence } from "../../../../../../shared/elementPicker/evidence.js";
import type {
  HoverObservation,
  SelectionObservation,
} from "../../../../../../shared/elementPicker/observation.js";
import {
  ElementPickerEventSchema,
  type ElementPickerEvent,
} from "../../../../../../shared/elementPicker/protocol.js";
import { EXTRACTOR_REGISTRY_GLOBAL } from "../../../guestChannel.js";
import { createPicker, type PickerHandle } from "../../picker.js";
import { installExtractor } from "../../registry.js";
import { createAngularExtractor } from "../angularExtractor.js";
import { FakeAngular, type ComponentSpec, type TemplateNode } from "./angularFixture.js";

/**
 * The extractor against a stand-in for Angular 22's debug API, through the
 * real bridge: the registry it installs into, and the picker that sends its
 * requests and turns its root tokens into element ids. Every event the picker
 * posts is checked against the host's own schema, so each observation here is
 * one the host would admit.
 */

const CHANNEL = "angular-test";
const scope = globalThis as Record<string, unknown>;

const Button: ComponentSpec = {
  selector: "app-button",
  className: "_ButtonComponent",
  debugInfo: {
    className: "ButtonComponent",
    filePath: "src/app/button/button.component.ts",
    lineNumber: 12,
  },
  template: [{ tag: "button", attrs: { class: "go" }, children: [{ text: "Go" }] }],
};

const Card: ComponentSpec = {
  selector: "app-card",
  className: "_CardComponent",
  debugInfo: {
    className: "CardComponent",
    filePath: "src/app/card/card.component.ts",
    lineNumber: 8,
  },
  template: [
    {
      tag: "section",
      attrs: { class: "card" },
      children: [{ tag: "div", attrs: { class: "body" }, children: [{ projection: true }] }],
    },
  ],
};

function appOf(content: TemplateNode[], overrides: Partial<ComponentSpec> = {}): ComponentSpec {
  return {
    selector: "app-root",
    className: "_AppComponent",
    debugInfo: { className: "AppComponent", filePath: "src/app/app.component.ts", lineNumber: 20 },
    template: [{ tag: "main", attrs: { class: "app" }, children: content }],
    ...overrides,
  };
}

/** A card with a button and a note written into it from the app's own template. */
const App = appOf([
  {
    component: Card,
    children: [
      { component: Button },
      { tag: "span", attrs: { class: "projected" }, children: [{ text: "note" }] },
    ],
  },
]);

let angular: FakeAngular;
let events: ElementPickerEvent[] = [];
let picker: PickerHandle | null = null;
let frames: FrameRequestCallback[] = [];

beforeEach(() => {
  angular = new FakeAngular();
  events = [];
  frames = [];
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    frames.push(callback);
    return frames.length;
  });
  vi.stubGlobal("cancelAnimationFrame", () => {});
  document.body.innerHTML = '<div id="root"></div>';
});

afterEach(() => {
  picker?.dispose();
  picker = null;
  (scope[EXTRACTOR_REGISTRY_GLOBAL] as { dispose(): void } | undefined)?.dispose();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  document.body.innerHTML = "";
});

/**
 * Bootstraps `spec` as a dev build does, publishing `ng` (or the given stand-in
 * for it) and `ngDevMode`; null leaves either global undefined.
 */
function mount(spec: ComponentSpec, ng: unknown = angular.ng, devMode: unknown = {}): void {
  angular.bootstrap(spec, query("#root"));
  if (ng !== null) vi.stubGlobal("ng", ng);
  if (devMode !== null) vi.stubGlobal("ngDevMode", devMode);
  installExtractor(
    { channel: CHANNEL, framework: "angular", installed: false },
    createAngularExtractor()
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

function pickNode(node: Element): SelectionObservation {
  node.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, composed: true }));
  const last = events.filter((event) => event.type === "selectionChanged").at(-1);
  const observation = last?.type === "selectionChanged" ? last.observations[0] : undefined;
  if (observation === undefined) throw new Error(`nothing selected for ${node.localName}`);
  return observation;
}

function pick(selector: string): SelectionObservation {
  return pickNode(query(selector));
}

function idOf(selector: string): string {
  return pick(selector).elementId;
}

function hover(selector: string): HoverObservation {
  query(selector).dispatchEvent(new MouseEvent("pointermove", { bubbles: true, composed: true }));
  for (const callback of frames.splice(0)) callback(0);
  const last = events.filter((event) => event.type === "hoverChanged").at(-1);
  const observation = last?.type === "hoverChanged" ? last.observation : null;
  if (!observation) throw new Error(`nothing hovered for ${selector}`);
  return observation;
}

function chainNames(observation: { componentChain: { components: ComponentRecord[] } }) {
  return observation.componentChain.components.map((record) => record.name?.value ?? null);
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

function diagnostics(observation: SelectionObservation): Record<string, unknown> {
  const entry = observation.frameworkEvidence[0] as GenericEvidence;
  return Object.fromEntries(entry.fields.map((field) => [field.name, field.value]));
}

/** The lines the evidence gives each file hint, by candidate id. */
function classLines(observation: SelectionObservation): Map<string, unknown> {
  const lines = new Map<string, unknown>();
  for (const entry of observation.frameworkEvidence.slice(1) as GenericEvidence[]) {
    const [field, base, ...rest] = entry.fields;
    expect(field).toEqual({ name: "field", value: "constructor.ɵcmp.debugInfo.lineNumber" });
    expect(base).toEqual({ name: "lineBase", value: 1 });
    for (const { name, value } of rest) lines.set(name, value);
  }
  return lines;
}

/** `ng` as published, with some of its functions replaced. */
function ngWith(overrides: Partial<FakeAngular["ng"]>): FakeAngular["ng"] {
  return { ...angular.ng, ...overrides };
}

describe("the Angular extractor", () => {
  it("names the chain by host ancestry and, separately, by the template that declared each", () => {
    mount(App);
    const observation = pick("button.go");
    expect(chainNames(observation)).toEqual(["ButtonComponent", "CardComponent", "AppComponent"]);
    const button = record(observation, "ButtonComponent");
    expect(observation.componentChain.nearestId).toBe(button.componentId);
    expect(button.name).toEqual({
      value: "ButtonComponent",
      extraction: { kind: "runtime-field", field: "constructor.ɵcmp.debugInfo.className" },
    });
    // Projected into the card, written in the app's template.
    expect(nameOf(observation, button.renderParentId)).toBe("CardComponent");
    expect(nameOf(observation, button.ownerId)).toBe("AppComponent");
    const card = record(observation, "CardComponent");
    expect(nameOf(observation, card.renderParentId)).toBe("AppComponent");
    expect(nameOf(observation, card.ownerId)).toBe("AppComponent");
    const app = record(observation, "AppComponent");
    expect(app.renderParentId).toBeNull();
    expect(app.ownerId).toBeNull();
    expect(observation.componentChain.truncated).toBe(false);
    expect(diagnostics(observation)).toMatchObject({ debugApi: true, componentLookup: "ancestor" });
  });

  it("keeps the template projected content is written in apart from the component it renders inside", () => {
    mount(App);
    const observation = pick("span.projected");
    expect(chainNames(observation)).toEqual(["CardComponent", "AppComponent"]);
    expect(nameOf(observation, observation.componentChain.nearestId)).toBe("CardComponent");
    expect(nameOf(observation, diagnostics(observation).templateOwnerId as string)).toBe(
      "AppComponent"
    );
  });

  it("selects a component by its host element", () => {
    mount(App);
    const observation = pick("app-button");
    expect(diagnostics(observation).componentLookup).toBe("host");
    // The host element is written in the app's template, as the button's owner edge says too.
    expect(nameOf(observation, diagnostics(observation).templateOwnerId as string)).toBe(
      "AppComponent"
    );
    expect(nameOf(observation, observation.componentChain.nearestId)).toBe("ButtonComponent");
    const roots = Object.fromEntries(
      observation.componentChain.components.map((entry) => [entry.name?.value, entry])
    );
    expect(roots.ButtonComponent).toMatchObject({
      rootElementIds: [observation.elementId],
      rootsComplete: true,
    });
    expect(roots.CardComponent!.rootElementIds).toEqual([idOf("app-card")]);
    expect(roots.AppComponent!.rootElementIds).toEqual([idOf("app-root")]);
    expect(observation.capabilities.componentSelection).toEqual({ state: "available" });
  });

  it("reports each class's file as a hint and its line beside it, never as a position", () => {
    mount(App);
    const observation = pick("button.go");
    const [hint] = record(observation, "ButtonComponent").sourceCandidates;
    expect(hint).toEqual({
      kind: "file-hint",
      candidateId: expect.any(String),
      framework: "angular",
      extraction: { kind: "runtime-field", field: "constructor.ɵcmp.debugInfo.filePath" },
      file: "src/app/button/button.component.ts",
    });
    expect(classLines(observation).get(hint!.candidateId)).toBe(12);
    const app = record(observation, "AppComponent").sourceCandidates[0]!;
    expect(classLines(observation).get(app.candidateId)).toBe(20);
    expect(observation.sourceCandidates).toEqual([]);
    expect(observation.capabilities).toMatchObject({
      names: { state: "available" },
      chain: { state: "available" },
      file: { state: "unknown" },
      line: { state: "unknown" },
      exactRange: { state: "unavailable", reason: "not-exposed" },
    });
  });

  it("names components but places none when the build recorded no class debug info", () => {
    const jit = (spec: ComponentSpec): ComponentSpec => ({ ...spec, debugInfo: undefined });
    mount(
      appOf([{ component: jit(Card), children: [{ component: jit(Button) }] }], {
        // A file outside the compiler's root dirs keeps its name and loses its path.
        debugInfo: { className: "AppComponent" },
      })
    );
    const observation = pick("button.go");
    expect(chainNames(observation)).toEqual(["_ButtonComponent", "_CardComponent", "AppComponent"]);
    expect(record(observation, "_ButtonComponent").name?.extraction).toEqual({
      kind: "runtime-field",
      field: "constructor.name",
    });
    expect(
      observation.componentChain.components.every((r) => r.sourceCandidates.length === 0)
    ).toBe(true);
    expect(observation.frameworkEvidence).toHaveLength(1);
    expect(observation.capabilities).toMatchObject({
      names: { state: "available" },
      file: { state: "unavailable", reason: "not-exposed" },
      line: { state: "unavailable", reason: "not-exposed" },
    });
  });

  it.each([0, -3, 1.5, "12", Number.MAX_SAFE_INTEGER])(
    "keeps a class's file but no line when the line reads %s",
    (lineNumber) => {
      mount(
        appOf([], {
          debugInfo: {
            className: "AppComponent",
            filePath: "src/app/app.component.ts",
            lineNumber,
          } as never,
        })
      );
      const observation = pick("main.app");
      expect(record(observation, "AppComponent").sourceCandidates).toEqual([
        expect.objectContaining({ kind: "file-hint", file: "src/app/app.component.ts" }),
      ]);
      expect(classLines(observation).size).toBe(0);
      expect(observation.capabilities.file).toEqual({ state: "unknown" });
      expect(observation.capabilities.line).toEqual({
        state: "unavailable",
        reason: "not-exposed",
      });
    }
  );

  it("reads the template stamps an app opted into, for the element and for each host", () => {
    const stamped: ComponentSpec = {
      ...Button,
      template: [
        {
          tag: "button",
          attrs: {
            class: "go",
            "data-ng-source-location": "node_modules/@acme/ui/button.html@o:4,l:0,c:4",
          },
        },
      ],
    };
    mount(
      appOf([
        {
          component: stamped,
          attrs: { "data-ng-source-location": "src/app/app.component.html@o:120,l:6,c:2" },
        },
      ])
    );
    const observation = pick("button.go");
    expect(observation.sourceCandidates).toEqual([
      {
        kind: "template-location",
        candidateId: expect.any(String),
        framework: "angular",
        extraction: { kind: "attribute", attribute: "data-ng-source-location" },
        file: "node_modules/@acme/ui/button.html",
        location: { lineBase: 0, columnBase: 0, columnUnit: "utf16", line: 0, column: 4 },
      },
    ]);
    expect(diagnostics(observation).templateOffset).toBe(4);
    const [invocation, definition] = record(observation, "ButtonComponent").sourceCandidates;
    expect(invocation).toMatchObject({
      kind: "component-invocation",
      file: "src/app/app.component.html",
      location: { lineBase: 0, columnBase: 0, line: 6, column: 2 },
    });
    expect(definition).toMatchObject({ kind: "file-hint" });
    // The root's host is written in index.html, which no template stamps.
    expect(record(observation, "AppComponent").sourceCandidates.map((c) => c.kind)).toEqual([
      "file-hint",
    ]);
  });

  it.each([
    "src/app/x.html@o:1,l:2",
    "src/app/x.html@o:1,l:2,c:3 ",
    "@o:1,l:2,c:3",
    "src/app/x.html@o:-1,l:0,c:0",
    "src/app/x.html@o:1,l:20000000,c:0",
    `${"a".repeat(3000)}@o:1,l:2,c:3`,
  ])("ignores a stamp it cannot read whole: %s", (stamp) => {
    mount(appOf([{ tag: "p", attrs: { class: "stamped", "data-ng-source-location": stamp } }]));
    expect(pick("p.stamped").sourceCandidates).toEqual([]);
  });

  it("takes no element stamp from an ancestor", () => {
    mount(
      appOf([
        {
          tag: "section",
          attrs: { "data-ng-source-location": "src/app/app.component.html@o:0,l:0,c:0" },
          children: [{ tag: "em", attrs: { class: "inner" } }],
        },
      ])
    );
    expect(pick("em.inner").sourceCandidates).toEqual([]);
  });

  it("crosses an open shadow root to the host its view renders in", () => {
    const Shadowed: ComponentSpec = {
      selector: "app-shadowed",
      className: "_ShadowedComponent",
      debugInfo: { className: "ShadowedComponent" },
      shadow: true,
      template: [{ tag: "p", attrs: { class: "inside" } }],
    };
    mount(appOf([{ component: Shadowed }]));
    const inside = query("app-shadowed").shadowRoot!.querySelector("p.inside")!;
    const observation = pickNode(inside);
    expect(chainNames(observation)).toEqual(["ShadowedComponent", "AppComponent"]);
    expect(record(observation, "AppComponent").renderParentId).toBeNull();
  });

  it("names an owner whose component's host was moved out of its subtree", () => {
    mount(App);
    // As an overlay does: the host is reparented to the body, still declared by the app.
    document.body.appendChild(query("app-button"));
    const observation = pick("button.go");
    expect(chainNames(observation)).toEqual(["ButtonComponent", "AppComponent"]);
    const button = record(observation, "ButtonComponent");
    expect(button.renderParentId).toBeNull();
    expect(nameOf(observation, button.ownerId)).toBe("AppComponent");
    const app = record(observation, "AppComponent");
    // Its record came from the owner edge; nobody walked its host ancestry.
    expect(app).not.toHaveProperty("renderParentId");
    expect(app.rootElementIds).toEqual([idOf("app-root")]);
  });

  it("keeps one id per instance across selections, and two for two of one class", () => {
    mount(appOf([{ component: Button }, { component: Button }]));
    const [first, second] = [...document.querySelectorAll("app-button")];
    const a = pickNode(first!).componentChain.nearestId;
    const b = pickNode(second!).componentChain.nearestId;
    expect(a).not.toBe(b);
    expect(pickNode(first!).componentChain.nearestId).toBe(a);
  });

  it("keys the nodes a real Angular 22.2.3 app keyed on the same markup", () => {
    mount(App);
    const keyed = [...query("#root").querySelectorAll("*")]
      .filter((node) => Object.prototype.hasOwnProperty.call(node, "__ngContext__"))
      .map(
        (node) =>
          node.localName + (node.getAttribute("class") ? `.${node.getAttribute("class")}` : "")
      );
    // Read off a zoneless app bootstrapped from this template; the card's inner div is not keyed.
    expect(keyed).toEqual([
      "app-root",
      "main.app",
      "app-card",
      "section.card",
      "app-button",
      "button.go",
      "span.projected",
    ]);
  });

  it("walks the owners of a template owner found outside the host chain", () => {
    const Frame: ComponentSpec = {
      selector: "app-frame",
      className: "_FrameComponent",
      debugInfo: { className: "FrameComponent" },
      template: [{ component: Card, children: [{ tag: "span", attrs: { class: "moved" } }] }],
    };
    mount(appOf([{ component: Frame }]));
    // Written in the frame's template, then moved where no host encloses it.
    document.body.appendChild(query("span.moved"));
    const observation = pick("span.moved");
    expect(observation.componentChain.nearestId).toBeNull();
    const frame = record(observation, "FrameComponent");
    expect(diagnostics(observation).templateOwnerId).toBe(frame.componentId);
    expect(nameOf(observation, frame.ownerId)).toBe("AppComponent");
    expect(record(observation, "AppComponent").ownerId).toBeNull();
  });

  it("gives every file hint its line exactly once, across as many entries as it takes", () => {
    let inner: ComponentSpec = Button;
    for (let depth = 20; depth > 0; depth -= 1) {
      inner = {
        selector: `app-c${depth}`,
        className: `_C${depth}`,
        debugInfo: {
          className: `C${depth}`,
          filePath: `src/app/c${depth}.ts`,
          lineNumber: depth * 3,
        },
        template: [{ component: inner }],
      };
    }
    mount(appOf([{ component: inner }]));
    const observation = pick("button.go");
    const lines = classLines(observation);
    const sent = observation.frameworkEvidence
      .slice(1)
      .reduce((count, entry) => count + (entry as GenericEvidence).fields.length - 2, 0);
    expect(observation.frameworkEvidence.length).toBeGreaterThan(2);
    expect(sent).toBe(lines.size);
    const expected = new Map(
      observation.componentChain.components.map((entry) => {
        const depth = /^C(\d+)$/.exec(entry.name!.value)?.[1];
        const line = entry.name!.value === "ButtonComponent" ? 12 : depth ? Number(depth) * 3 : 20;
        return [entry.sourceCandidates[0]!.candidateId, line];
      })
    );
    expect(lines).toEqual(expected);
  });

  it("describes the components around a node Angular did not render, and contributes nothing outside them", () => {
    mount(App);
    const widget = document.createElement("canvas");
    query("section.card").appendChild(widget);
    const observation = pick("section.card canvas");
    expect(chainNames(observation)).toEqual(["CardComponent", "AppComponent"]);
    expect(observation.sourceCandidates).toEqual([]);

    const foreign = document.createElement("p");
    document.body.appendChild(foreign);
    expect(createAngularExtractor().extract(foreign, "selection", { ref: () => null })).toBeNull();
  });
});

describe("the Angular extractor on a debug API it cannot fully trust", () => {
  it("draws no edge across a host Angular would not answer for", () => {
    mount(
      App,
      ngWith({
        getComponent: (element: unknown) => {
          if (element instanceof Element && element.localName === "app-card") {
            throw new Error("Expecting instance of DOM Element");
          }
          return angular.ng.getComponent(element);
        },
      })
    );
    const observation = pick("button.go");
    const button = record(observation, "ButtonComponent");
    expect(button).not.toHaveProperty("renderParentId");
    expect(observation.componentChain.truncated).toBe(true);
    // Its owner is still Angular's to name, and is.
    expect(nameOf(observation, button.ownerId)).toBe("AppComponent");
  });

  it("leaves out an owner Angular cannot name rather than claiming there is none", () => {
    mount(App);
    const button = angular.instanceOn(query("app-button"));
    vi.stubGlobal(
      "ng",
      ngWith({
        getOwningComponent: (target: unknown) => {
          // What Angular does for an instance no live view holds.
          if (target === button)
            throw new Error("The provided value must be an instance of a DOM Node");
          return angular.ng.getOwningComponent(target);
        },
      })
    );
    const observation = pick("button.go");
    expect(record(observation, "ButtonComponent")).not.toHaveProperty("ownerId");
    expect(nameOf(observation, record(observation, "CardComponent").ownerId)).toBe("AppComponent");
    expect(record(observation, "AppComponent").ownerId).toBeNull();
  });

  it("names no host for an instance a destroyed view held", () => {
    mount(App);
    const card = angular.instanceOn(query("app-card"));
    vi.stubGlobal(
      "ng",
      ngWith({
        // A stale owner: the card was destroyed but the button still names it.
        getOwningComponent: (target: unknown) =>
          target === angular.instanceOn(query("app-button"))
            ? card
            : angular.ng.getOwningComponent(target),
      })
    );
    angular.destroy(card);
    const observation = pick("button.go");
    const stale = observation.componentChain.components.find(
      (entry) => entry.componentId === record(observation, "ButtonComponent").ownerId
    )!;
    expect(stale.name?.value).toBe("CardComponent");
    expect(stale).toMatchObject({ rootElementIds: [], rootsComplete: false });
    expect(stale).not.toHaveProperty("renderParentId");
  });

  it("reads the chain without getOwningComponent or getHostElement, and says which it lacked", () => {
    mount(App, { getComponent: angular.ng.getComponent });
    const observation = pick("button.go");
    expect(chainNames(observation)).toEqual(["ButtonComponent", "CardComponent", "AppComponent"]);
    expect(observation.componentChain.components.some((r) => "ownerId" in r)).toBe(false);
    expect(diagnostics(observation)).toMatchObject({
      owningComponentApi: false,
      hostElementApi: false,
      templateOwnerId: null,
    });
    expect(record(observation, "ButtonComponent").rootElementIds).toEqual([idOf("app-button")]);
  });

  it("cuts an owner cycle the page made", () => {
    mount(App);
    const button = angular.instanceOn(query("app-button"));
    const app = angular.instanceOn(query("app-root"));
    vi.stubGlobal(
      "ng",
      ngWith({
        getOwningComponent: (target: unknown) =>
          target === app ? button : angular.ng.getOwningComponent(target),
      })
    );
    const observation = pick("button.go");
    expect(observation.componentChain.truncated).toBe(true);
    // The schema the picker checks every event against refuses a cycle, so one edge went.
    expect(chainNames(observation)).toEqual(["ButtonComponent", "CardComponent", "AppComponent"]);
    expect(record(observation, "AppComponent")).not.toHaveProperty("ownerId");
  });

  it.each([
    ["off", false],
    ["undefined", null],
  ])(
    "says a page with no debug API is a production build when ngDevMode is %s",
    (_label, devMode) => {
      mount(App, null, devMode);
      for (const observation of [hover("button.go"), pick("button.go")]) {
        expect(observation.componentChain.components).toEqual([]);
        expect(observation.capabilities).toEqual({
          names: { state: "unavailable", reason: "production-build" },
          chain: { state: "unavailable", reason: "production-build" },
          componentSelection: { state: "unavailable", reason: "production-build" },
          file: { state: "unavailable", reason: "production-build" },
          line: { state: "unavailable", reason: "production-build" },
          exactRange: { state: "unavailable", reason: "production-build" },
        });
      }
    }
  );

  it.each([
    ["missing", null],
    ["not Angular's", { getComponent: "not a function" }],
  ])("says only that the API is not there when it is %s in a dev build", (_label, ng) => {
    mount(App, ng, {});
    for (const observation of [hover("button.go"), pick("button.go")]) {
      expect(observation.componentChain.components).toEqual([]);
      expect(Object.values(observation.capabilities)).toEqual(
        Array(6).fill({ state: "unavailable", reason: "not-exposed" })
      );
    }
  });

  it("reads the API afresh, so one published or replaced after a first look is the one used", () => {
    mount(App, null, {});
    expect(pick("button.go").componentChain.components).toEqual([]);
    vi.stubGlobal("ng", angular.ng);
    expect(chainNames(pick("button.go"))).toEqual([
      "ButtonComponent",
      "CardComponent",
      "AppComponent",
    ]);
    vi.stubGlobal("ng", { getComponent: angular.ng.getComponent });
    expect(diagnostics(pick("button.go")).owningComponentApi).toBe(false);
  });

  it("treats an answer of the wrong shape as Angular not saying", () => {
    mount(App);
    const { proxy, revoke } = Proxy.revocable({}, {});
    revoke();
    vi.stubGlobal(
      "ng",
      ngWith({
        getComponent: (element: unknown) =>
          element instanceof Element && element.localName === "app-card"
            ? (42 as never)
            : angular.ng.getComponent(element),
        getOwningComponent: (target: unknown) =>
          target instanceof Element
            ? ("AppComponent" as never)
            : angular.ng.getOwningComponent(target),
        // A revoked proxy throws on the `instanceof` that would check it.
        getHostElement: () => proxy as never,
      })
    );
    const observation = pick("button.go");
    // The card's answer is a gap: the button gets no render parent across it.
    expect(chainNames(observation)).toEqual(["ButtonComponent", "AppComponent"]);
    expect(record(observation, "ButtonComponent")).not.toHaveProperty("renderParentId");
    expect(diagnostics(observation).templateOwnerId).toBeNull();
    // Reached by its owner edge, its host was Angular's to name, and was no element.
    expect(record(observation, "AppComponent")).toMatchObject({
      rootElementIds: [],
      rootsComplete: false,
    });
  });

  it("names nothing it cannot read off an instance", () => {
    mount(App);
    const hostile = new Proxy(
      {},
      {
        get(_target, key) {
          if (key === "constructor") throw new Error("no constructor for you");
          return undefined;
        },
      }
    );
    vi.stubGlobal(
      "ng",
      ngWith({
        getComponent: (element: unknown) =>
          element instanceof Element && element.localName === "app-button"
            ? hostile
            : angular.ng.getComponent(element),
      })
    );
    // The host itself, so its template owner is the app rather than the real instance behind it.
    const observation = pick("app-button");
    expect(chainNames(observation)).toEqual([null, "CardComponent", "AppComponent"]);
    expect(observation.componentChain.components[0]!.sourceCandidates).toEqual([]);
  });

  it("ends a detached subtree's chain at its top without claiming it reached the document", () => {
    const detached = document.createElement("div");
    angular.bootstrap(App, detached);
    vi.stubGlobal("ng", angular.ng);
    vi.stubGlobal("ngDevMode", {});
    const contribution = createAngularExtractor().extract(
      detached.querySelector("button.go")!,
      "selection",
      { ref: () => null }
    );
    const records = contribution!.componentChain!.components;
    expect(records.map((entry) => entry.name?.value)).toEqual([
      "ButtonComponent",
      "CardComponent",
      "AppComponent",
    ]);
    expect(records[2]).not.toHaveProperty("renderParentId");
    expect(
      records.every((entry) => entry.rootElementIds.length === 0 && !entry.rootsComplete)
    ).toBe(true);
  });
});

describe("the Angular extractor's bounds", () => {
  it("labels a hover with the nearest component alone", () => {
    mount(App);
    const observation = hover("button.go");
    expect(chainNames(observation)).toEqual(["ButtonComponent"]);
    expect(observation.componentChain.truncated).toBe(true);
    expect(observation.componentChain.components[0]).toMatchObject({
      rootElementIds: [],
      rootsComplete: false,
      sourceCandidates: [],
    });
    expect(observation.componentChain.components[0]).not.toHaveProperty("ownerId");
    expect(observation.sourceCandidates).toEqual([]);
    expect(observation.componentChain.nearestId).toBe(pick("button.go").componentChain.nearestId);
  });

  it("asks Angular for nothing but the nearest host on hover", () => {
    mount(App);
    const calls: string[] = [];
    const counted = Object.fromEntries(
      Object.entries(angular.ng).map(([name, fn]) => [
        name,
        (argument: unknown) => {
          calls.push(name);
          return (fn as (value: unknown) => unknown)(argument);
        },
      ])
    );
    vi.stubGlobal("ng", counted);
    const getAttribute = vi.spyOn(Element.prototype, "getAttribute");
    const contribution = createAngularExtractor().extract(query("button.go"), "hover", {
      ref: () => {
        throw new Error("hover named an element");
      },
    });
    expect(contribution?.componentChain?.components).toHaveLength(1);
    // The button heads its component's view and is keyed, so it is asked, then its host.
    expect(calls).toEqual(["getComponent", "getComponent"]);
    expect(getAttribute).not.toHaveBeenCalled();
  });

  it("fits a chain deeper than its record limit inside the bridge's ceiling", () => {
    const long = (depth: number) => `src/app/${"nested/".repeat(250)}level-${depth}.component.ts`;
    let inner: ComponentSpec = Button;
    for (let depth = 80; depth > 0; depth -= 1) {
      inner = {
        selector: `app-level-${depth}`,
        className: `_Level${depth}`,
        debugInfo: {
          className: `${"L".repeat(300)}${depth}`,
          filePath: long(depth),
          lineNumber: depth,
        },
        template: [{ component: inner }],
      };
    }
    mount(appOf([{ component: inner }]));
    const observation = pick("button.go");
    const records = observation.componentChain.components;
    expect(records).toHaveLength(64);
    expect(observation.componentChain.truncated).toBe(true);
    expect(records[0]!.name?.value).toBe("ButtonComponent");
    expect(records[1]!.name?.value).toHaveLength(256);
    // The innermost claims are sent, the rest counted, and file and line still said to exist.
    expect(records[0]!.sourceCandidates).toHaveLength(1);
    expect(diagnostics(observation).claimsOmitted).toBeGreaterThan(0);
    expect(observation.capabilities.file).toEqual({ state: "unknown" });
    expect(new TextEncoder().encode(JSON.stringify(observation)).length).toBeLessThan(128 * 1024);
  });

  it("looks for Angular's key only as far up as a hover walks", () => {
    const nest = (depth: number, leaf: TemplateNode): TemplateNode => {
      let node = leaf;
      for (let level = 0; level < depth; level += 1) node = { tag: "div", children: [node] };
      return node;
    };
    // Below the app's keyed <main>: one inside the bound, one past it.
    mount(
      appOf([
        nest(250, { tag: "i", attrs: { class: "near" } }),
        nest(300, { tag: "i", attrs: { class: "far" } }),
      ])
    );
    expect(chainNames(pick("i.near"))).toEqual(["AppComponent"]);
    expect(
      createAngularExtractor().extract(query("i.far"), "selection", { ref: () => null })
    ).toBeNull();
  });

  it("drops every claim, and the lines beside them, before a record when the reply would pass its ceiling", () => {
    let inner: ComponentSpec = Button;
    for (let depth = 16; depth > 0; depth -= 1) {
      inner = {
        selector: `app-wide-${depth}`,
        className: `_Wide${depth}`,
        // Three UTF-8 bytes a character: the claims fit their share in characters, not in bytes.
        debugInfo: {
          className: `${"€".repeat(250)}${depth}`,
          filePath: `src/${"€".repeat(2030)}${depth}.ts`,
          lineNumber: depth,
        },
        template: [{ component: inner }],
      };
    }
    mount(appOf([{ component: inner }]));
    const observation = pick("button.go");
    const records = observation.componentChain.components;
    expect(records).toHaveLength(18);
    expect(observation.componentChain.truncated).toBe(false);
    expect(records.every((entry) => entry.sourceCandidates.length === 0)).toBe(true);
    expect(observation.frameworkEvidence).toHaveLength(1);
    expect(diagnostics(observation).claimsOmitted).toBe(18);
    // Held back for size, the files and lines are still ones the build exposed.
    expect(observation.capabilities.file).toEqual({ state: "unknown" });
    expect(observation.capabilities.line).toEqual({ state: "unknown" });
  });

  it("drops the outermost records last, leaving no edge or template owner pointing at them", () => {
    // JSON escapes each control character to six bytes.
    const noisy = (depth: number) => `${"\u0001".repeat(250)}${depth}`;
    let content: TemplateNode[] = [{ tag: "span", attrs: { class: "deep" } }];
    for (let depth = 60; depth > 0; depth -= 1) {
      const level: ComponentSpec = {
        selector: `app-noisy-${depth}`,
        className: noisy(depth),
        template: [{ projection: true }],
      };
      // All written in the app's template, each projected into the one around it.
      content = [{ component: level, children: content }];
    }
    mount(appOf(content));
    const observation = pick("span.deep");
    const records = observation.componentChain.components;
    expect(records.length).toBeLessThan(61);
    expect(observation.componentChain.truncated).toBe(true);
    expect(observation.componentChain.nearestId).toBe(records[0]!.componentId);
    expect(records[0]!.name?.value.endsWith("60")).toBe(true);
    // Every owner was the app, whose record went.
    expect(records.some((entry) => "ownerId" in entry)).toBe(false);
    expect(records.at(-1)).not.toHaveProperty("renderParentId");
    expect(diagnostics(observation).templateOwnerId).toBeNull();
  });
});
