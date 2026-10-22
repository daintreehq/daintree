// @vitest-environment jsdom
import type { App as VueApp, Component } from "vue";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ComponentRecord } from "../../../../../../shared/elementPicker/component.js";
import { COORDINATE_CONVENTIONS } from "../../../../../../shared/elementPicker/coordinates.js";
import type { SelectionObservation } from "../../../../../../shared/elementPicker/observation.js";
import {
  ElementPickerEventSchema,
  type ElementPickerEvent,
} from "../../../../../../shared/elementPicker/protocol.js";
import type { SourceCandidate } from "../../../../../../shared/elementPicker/source.js";
import { EXTRACTOR_REGISTRY_GLOBAL } from "../../../guestChannel.js";
import { createPicker, type PickerHandle } from "../../picker.js";
import { installExtractor } from "../../registry.js";
import { createVueExtractor } from "../vueExtractor.js";
import { Budget, componentFile, field, renderedRoots, type VueInstance } from "../vueInstance.js";
import {
  NUXT_ROOT,
  NUXT_ROOT_COMPONENT,
  VITE_ROOT,
  buildApp,
  fixtureSource,
  loadRuntime,
  nuxtApp,
  removeFixtures,
  renderToHtml,
  stampFor,
  viteApp,
  type Inspector,
  type RuntimeMode,
} from "./vueFixture.js";

/**
 * The extractor against real Vue 3.5 output, through the real bridge: the
 * registry it installs into, and the picker that sends its requests and turns
 * its root tokens into element ids. Every event the picker posts is checked
 * against the host's own schema, so each observation here is one the host
 * would admit.
 */

const CHANNEL = "vue-test";
const scope = globalThis as Record<string, unknown>;
const ENTRY = `${VITE_ROOT}/src/App.vue`;

let events: ElementPickerEvent[] = [];
let picker: PickerHandle | null = null;
let app: VueApp | null = null;
let frames: FrameRequestCallback[] = [];

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
  document.body.innerHTML = '<div id="app"></div><div id="overlay"></div><p id="outside">x</p>';
});

afterEach(() => {
  app?.unmount();
  app = null;
  picker?.dispose();
  picker = null;
  (scope[EXTRACTOR_REGISTRY_GLOBAL] as { dispose(): void } | undefined)?.dispose();
  delete scope.__NUXT__;
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

function startPicker(): void {
  installExtractor({ channel: CHANNEL, framework: "vue", installed: false }, createVueExtractor());
  picker = createPicker({
    channel: CHANNEL,
    mode: "select",
    post: (event) => {
      const parsed = ElementPickerEventSchema.safeParse(event);
      if (!parsed.success) throw new Error(`host would reject ${event.type}: ${parsed.error}`);
      events.push(event);
    },
  });
  picker.setAvailability({ detection: "settled", extractors: { vue: "installed" } });
}

async function mountVite(
  options: { runtime?: RuntimeMode; inspector?: Inspector } = {}
): Promise<void> {
  const runtime = options.runtime ?? "dev";
  const root = await buildApp(viteApp(), ENTRY, {
    runtime,
    inspector: options.inspector ?? "none",
    root: VITE_ROOT,
  });
  const vue = await loadRuntime(runtime);
  app = vue.createApp(root);
  app.mount("#app");
  startPicker();
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

function evidenceOf(observation: SelectionObservation): Record<string, unknown> {
  const entry = observation.frameworkEvidence.find((item) => item.kind === "generic");
  if (entry?.kind !== "generic") throw new Error("no generic evidence");
  return Object.fromEntries(entry.fields.map((item) => [item.name, item.value]));
}

function kinds(candidates: SourceCandidate[]): string[] {
  return candidates.map((candidate) => candidate.kind);
}

/**
 * The claim a stamp turns into: its position as Vue's parser counts it, and
 * the file it names, spelled as the component holding the tag reports it.
 */
function stampedAt(stamp: string, file: string) {
  const [, relative, line, column] = /^(.+):(\d+):(\d+)$/.exec(stamp)!;
  expect(file.endsWith(`/${relative}`)).toBe(true);
  return {
    file,
    location: {
      ...COORDINATE_CONVENTIONS.vueInspector,
      columnUnit: "utf16",
      line: Number(line),
      column: Number(column),
    },
  };
}

const APP_SOURCE = fixtureSource("App.vue");
const BADGE_SOURCE = fixtureSource("Badge.vue");

describe("the Vue extractor against a dev build", () => {
  it("reads the runtime the way a stock dev build marks it", async () => {
    await mountVite();
    const button = query("button.cta") as unknown as Record<string, Record<string, unknown>>;
    // Non-enumerable, which is why nothing here lists keys.
    expect(Object.keys(button)).not.toContain("__vueParentComponent");
    const instance = button.__vueParentComponent!;
    expect((instance.type as Record<string, unknown>).name).toBe("FancyCard");
    const owner = (button.__vnode!.ctx as Record<string, unknown>).type as Record<string, unknown>;
    expect(owner.__name).toBe("App");
    expect(owner.__file).toBe(ENTRY);
  });

  it("names the chain by render parent and, separately, by owner", async () => {
    await mountVite();
    const observation = pick("span.badge:not(.wrapped)");
    expect(chainNames(observation)).toEqual(["Badge", "FancyCard", "App"]);
    const badge = record(observation, "Badge");
    expect(observation.componentChain.nearestId).toBe(badge.componentId);
    expect(badge.name).toEqual({
      value: "Badge",
      extraction: { kind: "runtime-field", field: "type.__name" },
    });
    expect(record(observation, "FancyCard").name?.extraction).toEqual({
      kind: "runtime-field",
      field: "type.name",
    });
    // Passed to the card in its slot: the card renders it, App wrote it.
    expect(nameOf(observation, badge.renderParentId)).toBe("FancyCard");
    expect(nameOf(observation, badge.ownerId)).toBe("App");
    const root = record(observation, "App");
    expect(root.renderParentId).toBeNull();
    expect(root.ownerId).toBeNull();
    expect(observation.componentChain.truncated).toBe(false);
    expect(
      observation.componentChain.components.every((entry) => entry.environment === "client")
    ).toBe(true);
  });

  it("files slot content under the component that wrote it, not the one rendering it", async () => {
    await mountVite();
    const observation = pick("button.cta");
    expect(chainNames(observation)).toEqual(["FancyCard", "App"]);
    expect(observation.sourceCandidates).toEqual([
      expect.objectContaining({
        kind: "file-hint",
        framework: "vue",
        file: ENTRY,
        extraction: { kind: "runtime-field", field: "__vnode.ctx.type.__file" },
      }),
    ]);
    expect(record(observation, "FancyCard").sourceCandidates).toEqual([
      expect.objectContaining({
        kind: "file-hint",
        file: `${VITE_ROOT}/src/Card.vue`,
        extraction: { kind: "runtime-field", field: "type.__file" },
      }),
    ]);
  });

  it("gives a file without a line when no inspector stamps the page", async () => {
    await mountVite();
    const observation = pick("button.cta");
    const all = [
      ...observation.sourceCandidates,
      ...observation.componentChain.components.flatMap((entry) => entry.sourceCandidates),
    ];
    expect(new Set(kinds(all))).toEqual(new Set(["file-hint"]));
    expect(all.every((candidate) => !("location" in candidate))).toBe(true);
    expect(observation.capabilities).toEqual({
      names: { state: "available" },
      chain: { state: "available" },
      componentSelection: { state: "available" },
      file: { state: "available" },
      line: { state: "unavailable", reason: "not-exposed" },
      exactRange: { state: "unavailable", reason: "not-exposed" },
    });
    expect(evidenceOf(observation)).toMatchObject({
      instanceLookup: "element",
      version: "3.5.44",
      elementStamp: null,
    });
  });

  it("lists each component's rendered roots: fragments, Teleports, nothing at all, and bare text", async () => {
    await mountVite();
    const roots = (selector: string, name: string) => record(pick(selector), name);
    const first = idOf("p.first");
    const second = idOf("p.second");
    expect(roots("p.first", "Pair")).toMatchObject({
      rootElementIds: [first, second],
      rootsComplete: true,
    });
    // The dialog is in the overlay, outside the component's own element.
    const wrap = idOf("div.modal-wrap");
    const dialog = idOf("aside.dialog");
    const modal = roots("p.dialog-text", "Modal");
    expect(modal).toMatchObject({ rootElementIds: [wrap, dialog], rootsComplete: true });
    expect(nameOf(pick("p.dialog-text"), modal.renderParentId)).toBe("App");
    const card = idOf("section.card");
    expect(roots("button.cta", "FancyCard")).toMatchObject({
      rootElementIds: [card],
      rootsComplete: true,
    });
  });

  it("says a component that rendered only a comment has no roots, and one that rendered text is incomplete", async () => {
    await mountVite();
    // App's output includes the dialog its Modal teleported out of `main`.
    expect(record(pick("main.app"), "App").rootElementIds).toEqual([
      idOf("main.app"),
      idOf("aside.dialog"),
    ]);
    // Neither renders an element anyone could pick, so they are read as the page holds them.
    const root = (query("main.app") as unknown as { __vueParentComponent: VueInstance })
      .__vueParentComponent;
    const children = field(field(root, "subTree"), "children") as Array<Record<string, unknown>>;
    const child = (file: string) => {
      const found = children
        .map((vnode) => vnode.component as VueInstance)
        .find((instance) => componentFile(instance) === `${VITE_ROOT}/src/${file}`);
      if (found === undefined) throw new Error(`no instance for ${file}`);
      return found;
    };
    expect(renderedRoots(child("Nothing.vue"), 32, new Budget(1_000))).toEqual({
      elements: [],
      complete: true,
    });
    expect(renderedRoots(child("Words.vue"), 32, new Budget(1_000))).toEqual({
      elements: [],
      complete: false,
    });
  });

  it("reads markup a static block inserted through its nearest mounted ancestor", async () => {
    await mountVite();
    const clause = query("p.clause-5") as unknown as Record<string, unknown>;
    // Vue inserted the run of clauses as markup: no instance on any of them.
    expect(clause.__vueParentComponent).toBeUndefined();
    const observation = pick("p.clause-5");
    expect(chainNames(observation)).toEqual([null, "App"]);
    expect(evidenceOf(observation)).toMatchObject({
      instanceLookup: "ancestor",
      elementSource: "static-block",
    });
    // The block's own vnode still says whose template it came from.
    expect(observation.sourceCandidates).toEqual([
      expect.objectContaining({
        kind: "file-hint",
        file: `${VITE_ROOT}/src/Legal.vue`,
        extraction: { kind: "runtime-field", field: "staticVNode.ctx.type.__file" },
      }),
    ]);
  });

  it("finds a component whose whole root is a static block below the node it was found through", async () => {
    await mountVite();
    // No node of Glossary's is marked, so the nearest marked one is App's <main>.
    expect(
      (query("p.term-3") as unknown as Record<string, unknown>).__vueParentComponent
    ).toBeUndefined();
    const observation = pick("p.term-3");
    expect(chainNames(observation)).toEqual(["Glossary", "App"]);
    expect(evidenceOf(observation).elementSource).toBe("static-block");
    expect(observation.sourceCandidates).toEqual([
      expect.objectContaining({ kind: "file-hint", file: `${VITE_ROOT}/src/Glossary.vue` }),
    ]);
  });

  it("gives nothing for a node outside every Vue app", async () => {
    await mountVite();
    const observation = pick("#outside");
    expect(observation.componentChain.components).toEqual([]);
    expect(observation.frameworkEvidence).toEqual([]);
    // Vue's reader looked and found nothing, which is an answer, not an open question.
    expect(observation.capabilities.names).toEqual({ state: "unavailable", reason: "not-exposed" });
  });

  it("leaves a node open when its component is further up than the reader will look", async () => {
    await mountVite();
    // Markup a widget built inside App's <main>, deeper than the walk goes.
    let leaf = query("main.app");
    for (let depth = 0; depth < 128; depth += 1) {
      const child = document.createElement("div");
      leaf.append(child);
      leaf = child;
    }
    leaf.id = "deep";
    const observation = pick("#deep");
    expect(observation.componentChain.components).toEqual([]);
    // Not "Vue has nothing here": the reader gave up before it could say.
    expect(observation.capabilities.names).toEqual({ state: "unknown" });
  });

  it("labels a hover with the nearest component alone", async () => {
    await mountVite();
    query("button.cta").dispatchEvent(
      new MouseEvent("pointermove", { bubbles: true, composed: true })
    );
    for (const callback of frames.splice(0)) callback(0);
    const hover = events.find((event) => event.type === "hoverChanged");
    const observation = hover?.type === "hoverChanged" ? hover.observation : null;
    expect(observation?.componentChain.components.map((entry) => entry.name?.value)).toEqual([
      "FancyCard",
    ]);
    expect(observation?.componentChain.truncated).toBe(true);
    expect(observation?.componentChain.components[0]).toMatchObject({
      rootElementIds: [],
      rootsComplete: false,
      sourceCandidates: [],
    });
    expect(observation?.sourceCandidates).toEqual([]);
    expect(observation?.capabilities.line).toEqual({ state: "unknown" });
    expect(observation?.componentChain.nearestId).toBe(pick("button.cta").componentChain.nearestId);
  });

  it("keeps one id per instance, and gives two copies of a component two", async () => {
    await mountVite();
    const inSlot = record(pick("span.badge:not(.wrapped)"), "Badge").componentId;
    const wrapped = record(pick("span.wrapped"), "Badge").componentId;
    expect(inSlot).not.toBe(wrapped);
    expect(record(pick("span.badge:not(.wrapped)"), "Badge").componentId).toBe(inSlot);
  });
});

describe("the Vue extractor with vite-plugin-vue-inspector's stamps", () => {
  const ownStamp = stampFor("src/App.vue", APP_SOURCE, '<button class="cta"');
  const badgeCall = stampFor("src/App.vue", APP_SOURCE, '<Badge :count="3"');
  const wrapperCall = stampFor("src/App.vue", APP_SOURCE, '<Wrapper class="wrapped"');

  it("takes an element's own stamp from its attribute", async () => {
    await mountVite({ inspector: "attribute" });
    expect(query("button.cta").getAttribute("data-v-inspector")).toBe(ownStamp);
    const observation = pick("button.cta");
    expect(observation.sourceCandidates[0]).toEqual({
      kind: "template-location",
      candidateId: expect.any(String),
      framework: "vue",
      extraction: { kind: "attribute", attribute: "data-v-inspector" },
      ...stampedAt(ownStamp, ENTRY),
    });
    // The owner's file is a separate observation, and stays one.
    expect(kinds(observation.sourceCandidates)).toEqual(["template-location", "file-hint"]);
    expect(observation.capabilities.line).toEqual({ state: "available" });
    expect(observation.capabilities.exactRange).toEqual({ state: "unknown" });
  });

  it("never takes the stamp a component was handed for its root element's own", async () => {
    await mountVite({ inspector: "attribute" });
    // The card's tag in App passed its stamp down onto the badge's span.
    expect(query("span.badge:not(.wrapped)").getAttribute("data-v-inspector")).toBe(badgeCall);
    const observation = pick("span.badge:not(.wrapped)");
    expect(kinds(observation.sourceCandidates)).toEqual(["file-hint"]);
    expect(record(observation, "Badge").sourceCandidates[0]).toEqual({
      kind: "component-invocation",
      candidateId: expect.any(String),
      framework: "vue",
      extraction: { kind: "runtime-field", field: "vnode.props.data-v-inspector" },
      ...stampedAt(badgeCall, ENTRY),
    });
  });

  it("gives a stamp passed through a wrapper to the wrapper's call site alone", async () => {
    await mountVite({ inspector: "attribute" });
    const observation = pick("span.wrapped");
    expect(chainNames(observation)).toEqual(["Badge", "Wrapper", "App"]);
    expect(kinds(observation.sourceCandidates)).toEqual(["file-hint"]);
    // Badge's own call site in Wrapper was replaced by Wrapper's in App: unknown, so absent.
    expect(kinds(record(observation, "Badge").sourceCandidates)).toEqual(["file-hint"]);
    expect(record(observation, "Wrapper").sourceCandidates[0]).toMatchObject({
      kind: "component-invocation",
      ...stampedAt(wrapperCall, ENTRY),
    });
  });

  it("follows a stamp passed down through the fragment a dev build wraps around a commented root", async () => {
    await mountVite({ inspector: "attribute" });
    const noteCall = stampFor("src/App.vue", APP_SOURCE, '<Note class="noted"');
    expect(query("p.note").getAttribute("data-v-inspector")).toBe(noteCall);
    const observation = pick("p.note");
    expect(chainNames(observation)).toEqual(["Note", "App"]);
    expect(kinds(observation.sourceCandidates)).toEqual(["file-hint"]);
    expect(record(observation, "Note").sourceCandidates[0]).toMatchObject({
      kind: "component-invocation",
      ...stampedAt(noteCall, ENTRY),
    });
  });

  it("holds a static block's stamps to the component that wrote it, not the one it was found through", async () => {
    await mountVite({ inspector: "recorded" });
    const observation = pick("p.term-3");
    expect(observation.sourceCandidates[0]).toMatchObject({
      kind: "template-location",
      extraction: { kind: "attribute", attribute: "data-v-inspector" },
      ...stampedAt(
        stampFor("src/Glossary.vue", fixtureSource("Glossary.vue"), '<p class="term term-3"'),
        `${VITE_ROOT}/src/Glossary.vue`
      ),
    });
  });

  it("reads version 7's hidden stamps, which never reach the DOM", async () => {
    await mountVite({ inspector: "recorded" });
    expect(query("button.cta").hasAttribute("data-v-inspector")).toBe(false);
    const button = pick("button.cta");
    expect(button.sourceCandidates[0]).toMatchObject({
      kind: "template-location",
      extraction: { kind: "runtime-field", field: "__vnode.props.__v_inspector" },
      ...stampedAt(ownStamp, ENTRY),
    });
    // Hidden stamps never fall through, so the span keeps its own.
    const badge = pick("span.badge:not(.wrapped)");
    expect(badge.sourceCandidates[0]).toMatchObject({
      kind: "template-location",
      ...stampedAt(
        stampFor("src/Badge.vue", BADGE_SOURCE, '<span class="badge"'),
        `${VITE_ROOT}/src/Badge.vue`
      ),
    });
    expect(record(badge, "Badge").sourceCandidates[0]).toMatchObject({
      kind: "component-invocation",
      extraction: { kind: "runtime-field", field: "vnode.props.__v_inspector" },
      ...stampedAt(badgeCall, ENTRY),
    });
  });

  it("reports nothing where version 7 lost a stamp to a root's fallthrough copy", async () => {
    await mountVite({ inspector: "recorded" });
    // Wrapper hands its class to Badge, and Badge to its span: both vnodes are
    // copies made without the hidden prop.
    const observation = pick("span.wrapped");
    expect(kinds(observation.sourceCandidates)).toEqual(["file-hint"]);
    expect(kinds(record(observation, "Badge").sourceCandidates)).toEqual(["file-hint"]);
    expect(record(observation, "Wrapper").sourceCandidates[0]).toMatchObject({
      kind: "component-invocation",
      ...stampedAt(wrapperCall, ENTRY),
    });
  });

  it("takes a stamp off markup a static block inserted, where the attribute survives", async () => {
    await mountVite({ inspector: "recorded" });
    const observation = pick("p.clause-5");
    expect(kinds(observation.sourceCandidates)).toEqual(["template-location", "file-hint"]);
    expect(observation.sourceCandidates.slice(0, 1)).toEqual([
      expect.objectContaining({
        kind: "template-location",
        extraction: { kind: "attribute", attribute: "data-v-inspector" },
        ...stampedAt(
          stampFor("src/Legal.vue", fixtureSource("Legal.vue"), '<p class="clause clause-5"'),
          `${VITE_ROOT}/src/Legal.vue`
        ),
      }),
    ]);
  });
});

describe("the Vue extractor on a page with no dev metadata", () => {
  it("says the build is a production one, and claims nothing", async () => {
    await mountVite({ runtime: "prod" });
    expect((query("button.cta") as unknown as Record<string, unknown>).__vueParentComponent).toBe(
      undefined
    );
    const observation = pick("button.cta");
    expect(observation.componentChain.components).toEqual([]);
    expect(observation.sourceCandidates).toEqual([]);
    const production = { state: "unavailable", reason: "production-build" };
    expect(observation.capabilities).toEqual({
      names: production,
      chain: production,
      componentSelection: production,
      file: production,
      line: production,
      exactRange: production,
    });
    expect(evidenceOf(observation)).toMatchObject({
      instanceLookup: "none",
      version: "3.5.44",
      appInstanceExposed: false,
    });
  });
});

describe("the Vue extractor on a hydrated Nuxt 4 page", () => {
  const PAGE = `${NUXT_ROOT}/app/pages/index.vue`;
  const PAGE_SOURCE = fixtureSource("nuxt/pages/index.vue");

  async function serve(): Promise<Component> {
    // The server compiles with the inspector's attribute step only; its client
    // step runs in the browser.
    const server = await buildApp(nuxtApp(), NUXT_ROOT_COMPONENT, {
      runtime: "dev",
      inspector: "attribute",
      root: NUXT_ROOT,
      ssr: true,
    });
    document.body.innerHTML = `<div id="__nuxt">${await renderToHtml(server)}</div>`;
    scope.__NUXT__ = { serverRendered: true, config: { public: {}, app: { baseURL: "/" } } };
    return buildApp(nuxtApp(), NUXT_ROOT_COMPONENT, {
      runtime: "dev",
      inspector: "recorded",
      root: NUXT_ROOT,
    });
  }

  it("has nothing to say before the page hydrates", async () => {
    await serve();
    startPicker();
    const observation = pick("button.buy");
    expect(observation.componentChain.components).toEqual([]);
    expect(observation.frameworkEvidence).toEqual([]);
  });

  it("reads the chain through Nuxt's root and Suspense once it does", async () => {
    const client = await serve();
    const vue = await loadRuntime("dev");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    app = vue.createSSRApp(client);
    app.mount("#__nuxt");
    await vue.nextTick();
    expect(warn.mock.calls.filter((call) => String(call[0]).includes("Hydration"))).toEqual([]);
    warn.mockRestore();
    startPicker();

    const observation = pick("button.buy");
    expect(chainNames(observation)).toEqual(["ProductCard", "index", "app", "nuxt-root"]);
    const card = record(observation, "ProductCard");
    expect(nameOf(observation, card.ownerId)).toBe("index");
    expect(observation.sourceCandidates[0]).toMatchObject({
      kind: "template-location",
      ...stampedAt(stampFor("app/pages/index.vue", PAGE_SOURCE, '<button class="buy"'), PAGE),
    });
    expect(observation.sourceCandidates[1]).toMatchObject({ kind: "file-hint", file: PAGE });
    expect(card.sourceCandidates[0]).toMatchObject({
      kind: "component-invocation",
      ...stampedAt(stampFor("app/pages/index.vue", PAGE_SOURCE, "<ProductCard"), PAGE),
    });
    // Nuxt's own root reports its file in the dependency; the host decides what that is worth.
    expect(record(observation, "nuxt-root").sourceCandidates).toContainEqual(
      expect.objectContaining({ kind: "file-hint", file: NUXT_ROOT_COMPONENT })
    );
    expect(record(observation, "nuxt-root").rootElementIds).toEqual([idOf("div.layout")]);
  });

  it("drops the server's fallthrough stamp from a root the client copied", async () => {
    const client = await serve();
    const vue = await loadRuntime("dev");
    app = vue.createSSRApp(client);
    app.mount("#__nuxt");
    startPicker();
    const section = query("section.product");
    // The server passed the page's stamp for the card down onto its root.
    expect(section.getAttribute("data-v-inspector")).toBe(
      stampFor("app/pages/index.vue", PAGE_SOURCE, "<ProductCard")
    );
    expect(kinds(pick("section.product").sourceCandidates)).toEqual(["file-hint"]);
  });
});
