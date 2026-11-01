// @vitest-environment jsdom
import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import { act, createElement, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { h as preactElement, render as renderPreact, type ComponentChildren } from "preact";
import type { Component } from "vue";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  webContents: { getAllWebContents: () => [], fromId: () => null },
  app: { getAppPath: () => "/nonexistent", isPackaged: false },
}));

import { SitePreviewBridge } from "../../SitePreviewBridge.js";
import { __resetCdpLeasesForTests } from "../../cdp/WebContentsCdpService.js";
import { LATE_PROBE_DELAY_MS } from "../coreGuest.js";
import { BOOTSTRAP_GLOBAL, EXTRACTOR_REGISTRY_GLOBAL } from "../guestChannel.js";
import { buildPickerReselectSource } from "../guestSources.js";
import type { ElementPickerPushPayload } from "../types.js";
import { ELEMENT_PICKER_PROTOCOL_VERSION } from "../../../../shared/elementPicker/protocol.js";
import type {
  Capabilities,
  Capability,
  SelectionObservation,
} from "../../../../shared/elementPicker/observation.js";
import { FakeAngular, type ComponentSpec } from "../guest/extractors/__tests__/angularFixture.js";
import { buildCoreGuestAssets } from "./buildCoreGuestAssets.js";
import {
  LIT_CARD_TAG,
  defineLitCard,
  mountLitPage,
  mountSolidPage,
  mountStaticPage,
} from "./fixtures/pages.js";

/**
 * The acceptance tests for detection-gated loading, run through the real
 * bridge with the bundles the app ships. A fake debugger evaluates every
 * expression in this jsdom realm, so the bootstrap, the probe and the
 * extractors run as they would in the guest — except that jsdom has one world,
 * where Chromium gives the bootstrap its own. That separation was verified
 * against Electron 42 directly; what these tests prove is the loading rule.
 */

const PANEL_ID = "panel-1";
const PROJECT_ID = "project-1";
const WEB_CONTENTS_ID = 42;
const SUBSCRIBER_WC_ID = 77;
const ISOLATED_CONTEXT_ID = 31;
const MAIN_FRAME_ID = "frame-main";
const BINDING_NAME = "__pickerBinding";

const scope = globalThis as unknown as Record<string, unknown>;

type Command = { method: string; params: Record<string, unknown> };

class FakeDebugger extends EventEmitter {
  attached = false;
  readonly commands: Command[] = [];
  /** The main frame's default world; a new one per document, as CDP announces them. */
  mainWorld = 1;
  /** Runs before the next evaluate into the picker's world, which then fails as a gone world does. */
  beforeIsolatedEvaluate: (() => void) | null = null;

  isAttached(): boolean {
    return this.attached;
  }
  attach(): void {
    this.attached = true;
  }

  private announceMainWorld(): void {
    this.emit("message", {} as Electron.Event, "Runtime.executionContextCreated", {
      context: {
        id: this.mainWorld,
        uniqueId: `main-${this.mainWorld}`,
        auxData: { isDefault: true, frameId: MAIN_FRAME_ID },
      },
    });
  }

  /** Set by a navigation: the new main world is announced before the next command's reply. */
  private announcePending = false;

  /**
   * A cross-document navigation in the order Electron 42 delivers it: CDP
   * clears the contexts, Electron reports `did-navigate` — unless
   * `observed` is false, standing in for that event arriving late — and the
   * new document's main world is announced ahead of the next command's reply.
   */
  navigate(wc: EventEmitter, observed = true): void {
    this.emit("message", {} as Electron.Event, "Runtime.executionContextsCleared", {});
    this.mainWorld += 1;
    this.announcePending = true;
    if (observed) wc.emit("did-navigate");
  }

  async sendCommand(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    this.commands.push({ method, params });
    if (this.announcePending) {
      this.announcePending = false;
      this.announceMainWorld();
    }
    switch (method) {
      case "Runtime.enable":
        // The replay of contexts that already exist.
        this.announceMainWorld();
        return {};
      case "Page.getFrameTree":
        return { frameTree: { frame: { id: MAIN_FRAME_ID } } };
      case "Runtime.addBinding": {
        const name = params.name as string;
        // CDP delivers binding calls asynchronously, never inside the evaluate.
        scope[name] = (payload: string) =>
          queueMicrotask(() =>
            this.emit("message", {} as Electron.Event, "Runtime.bindingCalled", {
              name,
              executionContextId: ISOLATED_CONTEXT_ID,
              payload,
            })
          );
        return {};
      }
      case "Runtime.removeBinding":
        delete scope[params.name as string];
        return {};
      case "Page.createIsolatedWorld":
        return { executionContextId: ISOLATED_CONTEXT_ID };
      case "Page.addScriptToEvaluateOnNewDocument":
        return { identifier: "script-1" };
      case "Runtime.evaluate": {
        if (
          params.uniqueContextId !== undefined &&
          params.uniqueContextId !== `main-${this.mainWorld}`
        ) {
          throw new Error("uniqueContextId not found");
        }
        if (params.contextId === ISOLATED_CONTEXT_ID && this.beforeIsolatedEvaluate !== null) {
          const hook = this.beforeIsolatedEvaluate;
          this.beforeIsolatedEvaluate = null;
          hook();
          throw new Error("Cannot find context with specified id");
        }
        try {
          const source = (params.expression as string).trim().replace(/;$/, "");
          const evaluated = new Function(`return ${source}`)() as unknown;
          const value = params.awaitPromise ? await evaluated : evaluated;
          return params.returnByValue
            ? { result: { value: JSON.parse(JSON.stringify(value ?? null)) as unknown } }
            : { result: {} };
        } catch (err) {
          return { exceptionDetails: { text: String(err) } };
        }
      }
      default:
        return {};
    }
  }

  /** The evaluates the host sent, by what they install. */
  evaluates(): Array<{ kind: "isolated" | "probe" | "extractor" | "other"; framework?: string }> {
    return this.commands
      .filter((command) => command.method === "Runtime.evaluate")
      .map(({ params }) => {
        const expression = params.expression as string;
        if (params.contextId === ISOLATED_CONTEXT_ID) return { kind: "isolated" as const };
        if (expression.includes("const api = { result: null,")) return { kind: "probe" as const };
        const framework = /framework: "([a-z0-9.-]+)", installed: false/.exec(expression)?.[1];
        if (framework !== undefined) return { kind: "extractor" as const, framework };
        return { kind: "other" as const };
      });
  }
}

class FakeWebContents extends EventEmitter {
  readonly debugger = new FakeDebugger();
  url = "http://localhost:5173/";
  constructor(readonly id: number) {
    super();
  }
  isDestroyed(): boolean {
    return false;
  }
  getURL(): string {
    return this.url;
  }
}

/** The bundles the app ships. */
let shipped: Record<string, string> = {};
/** The same, with the contributing fixture standing in for React's extractor. */
let assets: Record<string, string> = {};

beforeAll(() => {
  shipped = buildCoreGuestAssets([
    {
      id: "fixture:react",
      entry: "electron/services/elementPicker/__tests__/fixtures/contributingExtractor.ts",
    },
  ]);
  assets = { ...shipped, "extractor:react": shipped["fixture:react"]! };
}, 60_000);

function makeHarness(options: { catalog?: Record<string, string> } = {}) {
  const catalog = options.catalog ?? assets;
  const wc = new FakeWebContents(WEB_CONTENTS_ID);
  const subscriber = new FakeWebContents(SUBSCRIBER_WC_ID);
  const sunk: ElementPickerPushPayload[] = [];
  const extractorLoad: { gate: Promise<void> | null } = { gate: null };
  let sessions = 0;
  const bridge = new SitePreviewBridge({
    getWebContents: (id) => {
      if (id === WEB_CONTENTS_ID) return wc as unknown as Electron.WebContents;
      if (id === SUBSCRIBER_WC_ID) return subscriber as unknown as Electron.WebContents;
      return null;
    },
    resolveWebContentsId: (panelId) => (panelId === PANEL_ID ? WEB_CONTENTS_ID : undefined),
    getPanelKind: () => "dev-preview",
    resolveGuestProject: () => PROJECT_ID,
    newSessionId: () => `session-${++sessions}`,
    newBindingName: () => BINDING_NAME,
    loadCoreGuestAsset: async (id) => {
      if (id.startsWith("extractor:") && extractorLoad.gate) await extractorLoad.gate;
      return catalog[id] ?? null;
    },
  });
  const bind = (mode: "select" | "browse" = "select") =>
    bridge.bindElementPicker({
      projectId: PROJECT_ID,
      panelId: PANEL_ID,
      mode,
      subscriberWebContentsId: SUBSCRIBER_WC_ID,
      sink: (payload) => sunk.push(payload),
    });
  const kinds = <K extends ElementPickerPushPayload["kind"]>(kind: K) =>
    sunk.filter((payload): payload is Extract<ElementPickerPushPayload, { kind: K }> => {
      return payload.kind === kind;
    });
  const pickerEvents = (type: string) =>
    sunk.flatMap((payload) =>
      payload.kind === "picker-event" && payload.event.type === type ? [payload] : []
    );
  const navigate = (observed = true) => wc.debugger.navigate(wc, observed);
  return { bridge, wc, sunk, extractorLoad, bind, navigate, kinds, pickerEvents };
}

/** Lets the binding queue, binding calls and probes settle. */
async function settle(): Promise<void> {
  for (let round = 0; round < 50; round += 1) await vi.advanceTimersByTimeAsync(0);
}

function svelteNode(): Element {
  document.body.innerHTML = '<main><button id="cta">Start</button></main>';
  const node = document.getElementById("cta")!;
  (node as unknown as Record<string, unknown>).__svelte_meta = {
    loc: { file: "src/App.svelte", line: 3, column: 2 },
  };
  return node;
}

/**
 * The least of a page that has each shipped extractor's framework detected:
 * one marker the framework leaves, and nothing of its runtime.
 */
const SHIPPED_DETECTIONS: Array<[string, () => void]> = [
  ["svelte", () => void svelteNode()],
  [
    "react",
    () => {
      document.body.innerHTML = '<div id="root"></div>';
      (document.getElementById("root") as unknown as Record<string, unknown>)[
        "__reactContainer$fixture"
      ] = {};
    },
  ],
  ["vue", () => void (document.body.innerHTML = '<div id="app" data-v-app=""></div>')],
  ["angular", () => void (document.body.innerHTML = '<app-root ng-version="20.0.0"></app-root>')],
  [
    "astro",
    () =>
      void (document.body.innerHTML =
        '<main data-astro-source-file="/proj/src/pages/index.astro"></main>'),
  ],
  [
    "preact",
    () => {
      document.body.innerHTML = '<div id="app"></div>';
      (document.getElementById("app") as unknown as Record<string, unknown>).__k = {};
    },
  ],
  ["solid", () => void (document.body.innerHTML = '<div data-hk="0"></div>')],
];

beforeEach(() => {
  __resetCdpLeasesForTests();
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  // Astro's extractor fetches the page's markup before it installs. Nothing
  // serves this realm's URL, and a real request would hold the install until
  // the read's deadline, which these fake timers never reach.
  vi.stubGlobal("fetch", () => Promise.reject(new TypeError("Failed to fetch")));
  document.body.innerHTML = "";
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  const api = scope[BOOTSTRAP_GLOBAL] as { dispose?: (() => void) | null } | undefined;
  try {
    api?.dispose?.();
  } catch {
    // asserted where it matters
  }
  delete scope[BOOTSTRAP_GLOBAL];
  delete scope[EXTRACTOR_REGISTRY_GLOBAL];
  delete scope[BINDING_NAME];
  __resetCdpLeasesForTests();
});

describe("core Element Picker guest loading", () => {
  it("never gives a page with no recognised framework an extractor", async () => {
    document.body.innerHTML = "<main><h1>Plain</h1><p>Static page</p></main>";
    const h = makeHarness();
    await h.bind();
    await settle();
    await vi.advanceTimersByTimeAsync(LATE_PROBE_DELAY_MS);
    await settle();

    expect(h.pickerEvents("documentReady")).toHaveLength(1);
    // Both looks happened — the first and the one late probe — and found nothing.
    expect(h.wc.debugger.evaluates().filter((entry) => entry.kind === "probe")).toHaveLength(2);
    expect(h.wc.debugger.evaluates().some((entry) => entry.kind === "extractor")).toBe(false);
    expect(h.kinds("frameworks-probed")).toHaveLength(0);
    expect(scope[EXTRACTOR_REGISTRY_GLOBAL]).toBeUndefined();
  });

  it("injects an extractor only after a detection names its framework", async () => {
    svelteNode();
    const h = makeHarness();
    await h.bind();
    await settle();

    const order = h.wc.debugger.evaluates().map((entry) => entry.kind);
    const firstProbe = order.indexOf("probe");
    const firstExtractor = order.indexOf("extractor");
    expect(firstProbe).toBeGreaterThanOrEqual(0);
    expect(firstExtractor).toBeGreaterThan(firstProbe);
    expect(h.wc.debugger.evaluates().filter((entry) => entry.kind === "extractor")).toEqual([
      { kind: "extractor", framework: "svelte" },
    ]);
    // Both aimed at the bootstrap's own document, never "whatever is there now".
    const mainWorldTargets = h.wc.debugger.commands
      .filter((c) => c.method === "Runtime.evaluate" && c.params.contextId === undefined)
      .map((c) => c.params.uniqueContextId);
    expect(mainWorldTargets).toEqual(["main-1", "main-1"]);

    const probed = h.kinds("frameworks-probed");
    expect(probed).toHaveLength(1);
    expect(probed[0]).toMatchObject({
      documentEpoch: 0,
      detections: [{ framework: "svelte", signals: [{ via: "expando", name: "__svelte_meta" }] }],
    });
    expect(h.kinds("extractor-installed")).toEqual([
      expect.objectContaining({ framework: "svelte", documentEpoch: 0 }),
    ]);
    const registry = scope[EXTRACTOR_REGISTRY_GLOBAL] as { has(framework: string): boolean };
    expect(registry.has("svelte")).toBe(true);
  });

  it("installs each framework once per document however often it is detected", async () => {
    svelteNode();
    const h = makeHarness();
    await h.bind();
    await settle();
    // The late probe sees the same framework again.
    await vi.advanceTimersByTimeAsync(LATE_PROBE_DELAY_MS);
    await settle();

    expect(h.kinds("frameworks-probed")).toHaveLength(2);
    expect(h.wc.debugger.evaluates().filter((entry) => entry.kind === "extractor")).toHaveLength(1);
  });

  it("finds a framework that mounts after the page reported ready with its one late probe", async () => {
    document.body.innerHTML = '<div id="root"></div>';
    const h = makeHarness();
    await h.bind();
    await settle();
    expect(h.kinds("extractor-installed")).toHaveLength(0);

    svelteNode();
    await vi.advanceTimersByTimeAsync(LATE_PROBE_DELAY_MS);
    await settle();
    expect(h.kinds("extractor-installed")).toEqual([
      expect.objectContaining({ framework: "svelte" }),
    ]);

    // One late probe, not a poll.
    await vi.advanceTimersByTimeAsync(LATE_PROBE_DELAY_MS * 4);
    await settle();
    expect(h.wc.debugger.evaluates().filter((entry) => entry.kind === "probe")).toHaveLength(2);
  });

  it("loads an extractor for a framework the selected element's markup names, and describes the selection again with it", async () => {
    document.body.innerHTML = "<main></main>";
    const h = makeHarness();
    await h.bind();
    await settle();
    await vi.advanceTimersByTimeAsync(LATE_PROBE_DELAY_MS);
    await settle();

    // An island that arrived after both probes: only pointing at it finds it.
    document.querySelector("main")!.innerHTML =
      '<astro-island renderer-url="/@id/@astrojs/react/client.js"><button id="buy">Buy</button></astro-island>';
    (document.getElementById("buy") as HTMLButtonElement).click();
    await settle();

    const detected = h.pickerEvents("frameworksDetected");
    expect(detected).toHaveLength(1);
    expect(
      (detected[0]!.event as { detections: Array<{ framework: string }> }).detections.map(
        (entry) => entry.framework
      )
    ).toEqual(["astro", "react"]);
    // Both are installed, in the order the markup named them.
    expect(h.wc.debugger.evaluates().filter((entry) => entry.kind === "extractor")).toEqual([
      { kind: "extractor", framework: "astro" },
      { kind: "extractor", framework: "react" },
    ]);
    expect(h.kinds("host-issue")).toHaveLength(0);

    // Described again as each reader arrives, since each changes what it says.
    const selections = h.pickerEvents("selectionChanged");
    expect(selections.map((entry) => (entry.event as { cause: string }).cause)).toEqual([
      "user",
      "reselect",
      "reselect",
    ]);
    type Described = {
      observations: Array<{
        componentChain: { components: Array<{ name: { value: string } }> };
        frameworkEvidence: Array<{ framework: string }>;
      }>;
    };
    const [, withAstro, withReact] = selections.map(
      (entry) => (entry.event as Described).observations[0]!
    );
    expect(withAstro!.frameworkEvidence.map((entry) => entry.framework)).toEqual(["astro"]);
    expect(withAstro!.componentChain.components).toEqual([]);
    expect(withReact!.componentChain.components[0]!.name.value).toBe("FixtureButton");
    expect(withReact!.frameworkEvidence.map((entry) => entry.framework)).toEqual(["astro"]);
  });

  it("traces an Astro element its dev toolbar took the stamps off, from the markup as served", async () => {
    const page = "/proj/src/pages/index.astro";
    const h = makeHarness();
    const served = `<!doctype html><html><head></head><body>
      <main data-astro-source-file="${page}" data-astro-source-loc="18:5">
        <h1 id="title" data-astro-source-file="${page}" data-astro-source-loc="19:11">Shop</h1>
      </main></body></html>`;
    const fetched: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => {
      fetched.push(url);
      return new Response(served, { headers: { "content-type": "text/html" } });
    });
    // All the toolbar leaves: the markup unstamped, and itself, which is all that says Astro.
    document.body.innerHTML = `
      <main>
        <h1 id="title">Shop</h1>
      </main><astro-dev-toolbar></astro-dev-toolbar>`;
    await h.bind();
    await settle();
    expect(h.wc.debugger.evaluates().filter((entry) => entry.kind === "extractor")).toEqual([
      { kind: "extractor", framework: "astro" },
    ]);
    expect(fetched).toEqual([location.href.split("#")[0]]);

    (document.getElementById("title") as HTMLElement).click();
    await settle();
    const selected = h.pickerEvents("selectionChanged").at(-1)!.event as {
      observations: SelectionObservation[];
    };
    expect(selected.observations[0]!.sourceCandidates).toEqual([
      expect.objectContaining({
        kind: "template-location",
        framework: "astro",
        extraction: { kind: "attribute", attribute: "data-astro-source-loc" },
        file: page,
        location: expect.objectContaining({ line: 19, column: 11 }),
      }),
    ]);
    expect(h.kinds("host-issue")).toHaveLength(0);
  });

  it("describes Astro, React and Svelte selections side by side on a page of islands", async () => {
    const page = "/proj/src/pages/index.astro";
    document.body.innerHTML = `
      <main data-astro-cid-x1="" data-astro-source-file="${page}" data-astro-source-loc="4:7">
        <h1 id="title" data-astro-source-file="${page}" data-astro-source-loc="5:9">Shop</h1>
        <astro-island renderer-url="/@id/@astrojs/react/client.js" client="load"
          opts='{"name":"BuyButton","value":true}' props='{"token":[0,"s3cret"]}'><button id="buy">Buy</button></astro-island>
        <astro-island renderer-url="/@id/@astrojs/svelte/client.js" client="visible"><span id="count">0</span></astro-island>
      </main>`;
    const h = makeHarness();
    await h.bind();
    await settle();
    expect(
      h.wc.debugger
        .evaluates()
        .filter((entry) => entry.kind === "extractor")
        .map((entry) => entry.framework)
        .sort()
    ).toEqual(["astro", "react", "svelte"]);

    type Described = {
      observations: Array<{
        sourceCandidates: Array<{ framework: string; kind: string }>;
        componentChain: { components: Array<{ name: { value: string } | null }> };
        capabilities: Record<string, { state: string }>;
        frameworkEvidence: Array<{
          framework: string;
          fields: Array<{ name: string; value: unknown }>;
        }>;
      }>;
    };
    const select = async (id: string) => {
      (document.getElementById(id) as HTMLElement).click();
      await settle();
      return (h.pickerEvents("selectionChanged").at(-1)!.event as Described).observations[0]!;
    };

    const title = await select("title");
    expect(title.sourceCandidates).toEqual([
      expect.objectContaining({ framework: "astro", kind: "template-location" }),
    ]);

    const buy = await select("buy");
    expect(buy.componentChain.components.map((record) => record.name?.value)).toEqual([
      "FixtureButton",
    ]);
    expect(buy.frameworkEvidence.map((entry) => entry.framework)).toEqual(["astro"]);
    expect(buy.frameworkEvidence[0]!.fields).toContainEqual({
      name: "astro-island[opts].name",
      value: "BuyButton",
    });

    // Svelte's extractor in this build says nothing: Astro's evidence stands,
    // and no capability is claimed absent on Svelte's behalf.
    const count = await select("count");
    expect(new Set(Object.values(count.capabilities).map((entry) => entry.state))).toEqual(
      new Set(["unknown"])
    );
    expect(count.frameworkEvidence[0]!.fields).toContainEqual({
      name: "islandRenderer",
      value: "svelte",
    });

    expect(JSON.stringify(h.sunk)).not.toContain("s3cret");
    expect(h.kinds("host-issue")).toHaveLength(0);
  });

  it("drops an install still in flight when the document changes, and starts over in the new one", async () => {
    svelteNode();
    const h = makeHarness();
    let release!: () => void;
    h.extractorLoad.gate = new Promise((resolve) => {
      release = resolve;
    });
    await h.bind();
    await settle();
    // The probe found Svelte; its extractor is waiting on the asset read.
    expect(h.kinds("frameworks-probed")).toHaveLength(1);
    expect(h.wc.debugger.evaluates().some((entry) => entry.kind === "extractor")).toBe(false);

    h.navigate();
    release();
    await settle();

    expect(h.kinds("epoch-advanced")).toHaveLength(1);
    // The first document's install never ran; only the new document's did.
    expect(h.wc.debugger.evaluates().filter((entry) => entry.kind === "extractor")).toHaveLength(1);
    expect(h.kinds("extractor-installed")).toEqual([
      expect.objectContaining({ framework: "svelte", documentEpoch: 1 }),
    ]);
  });

  it("tears down a document's extractors when the epoch moves on", async () => {
    svelteNode();
    const h = makeHarness();
    await h.bind();
    await settle();
    const first = scope[EXTRACTOR_REGISTRY_GLOBAL] as {
      channel: string;
      has(framework: string): boolean;
    };
    expect(first.has("svelte")).toBe(true);

    h.navigate();
    await settle();

    // jsdom keeps the old document, so the old registry is still reachable
    // here: the new bootstrap superseding the old one is what retired it.
    expect(first.has("svelte")).toBe(false);
    const second = scope[EXTRACTOR_REGISTRY_GLOBAL] as { channel: string };
    expect(second).not.toBe(first);
    expect(second.channel).not.toBe(first.channel);
    expect(h.kinds("extractor-installed").map((entry) => entry.documentEpoch)).toEqual([0, 1]);
  });

  it("detects a framework for every extractor the app ships", () => {
    expect(SHIPPED_DETECTIONS.map(([framework]) => `extractor:${framework}`).sort()).toEqual(
      Object.keys(shipped)
        .filter((id) => id.startsWith("extractor:"))
        .sort()
    );
  });

  it.each(SHIPPED_DETECTIONS)(
    "installs the shipped %s extractor again in the document a navigation brings, and retires the old one",
    async (framework, mount) => {
      mount();
      const h = makeHarness({ catalog: shipped });
      await h.bind();
      await settle();
      const first = scope[EXTRACTOR_REGISTRY_GLOBAL] as { has(framework: string): boolean };
      expect(first.has(framework)).toBe(true);

      h.navigate();
      await settle();
      // Detected again in the new document, which must not install it twice.
      await vi.advanceTimersByTimeAsync(LATE_PROBE_DELAY_MS);
      await settle();

      expect(first.has(framework)).toBe(false);
      const second = scope[EXTRACTOR_REGISTRY_GLOBAL] as { has(framework: string): boolean };
      expect(second).not.toBe(first);
      expect(second.has(framework)).toBe(true);
      expect(
        h.kinds("extractor-installed").map((entry) => [entry.framework, entry.documentEpoch])
      ).toEqual([
        [framework, 0],
        [framework, 1],
      ]);
      expect(h.kinds("host-issue")).toHaveLength(0);
    }
  );

  it("removes the bootstrap and its extractors on detach, and stops probing", async () => {
    svelteNode();
    const h = makeHarness();
    const state = await h.bind();
    await settle();
    expect(scope[BOOTSTRAP_GLOBAL]).toBeDefined();

    await h.bridge.detach(PROJECT_ID, state.sessionId);
    await settle();

    expect(scope[BOOTSTRAP_GLOBAL]).toBeUndefined();
    expect(scope[EXTRACTOR_REGISTRY_GLOBAL]).toBeUndefined();
    expect(scope[BINDING_NAME]).toBeUndefined();
    expect(h.sunk.at(-1)).toMatchObject({ kind: "detached", reason: "requested" });

    const probes = h.wc.debugger.evaluates().filter((entry) => entry.kind === "probe").length;
    await vi.advanceTimersByTimeAsync(LATE_PROBE_DELAY_MS * 2);
    await settle();
    expect(h.wc.debugger.evaluates().filter((entry) => entry.kind === "probe")).toHaveLength(
      probes
    );
  });

  it("scopes the binding to the picker's world and trusts no other context", async () => {
    const h = makeHarness();
    const state = await h.bind();
    await settle();

    const addBinding = h.wc.debugger.commands.find((c) => c.method === "Runtime.addBinding");
    const world = h.wc.debugger.commands.find((c) => c.method === "Page.createIsolatedWorld");
    expect(addBinding?.params.executionContextName).toBe(world?.params.worldName);
    expect(world?.params).toMatchObject({ frameId: MAIN_FRAME_ID, grantUniveralAccess: false });
    // No registration that would outlive the document.
    expect(
      h.wc.debugger.commands.some((c) => c.method === "Page.addScriptToEvaluateOnNewDocument")
    ).toBe(false);

    const before = h.sunk.length;
    h.wc.debugger.emit("message", {} as Electron.Event, "Runtime.bindingCalled", {
      name: BINDING_NAME,
      executionContextId: ISOLATED_CONTEXT_ID + 1,
      payload: JSON.stringify({
        protocolVersion: ELEMENT_PICKER_PROTOCOL_VERSION,
        sessionId: state.sessionId,
        documentEpoch: 0,
        sequence: 99,
        event: { type: "frameworksDetected", detections: [] },
      }),
    });
    expect(h.sunk.length).toBe(before);
    expect(h.bridge.getState(PROJECT_ID, state.sessionId)?.droppedMessages).toBe(1);
  });

  it("supersedes the panel's previous binding, and keeps each one's traffic on its own sink", async () => {
    const h = makeHarness();
    const earlier: ElementPickerPushPayload[] = [];
    const first = await h.bridge.bindElementPicker({
      projectId: PROJECT_ID,
      panelId: PANEL_ID,
      mode: "browse",
      subscriberWebContentsId: SUBSCRIBER_WC_ID,
      sink: (payload) => earlier.push(payload),
    });
    await settle();
    const earlierCount = earlier.length;
    await h.bind();
    await settle();

    expect(earlier.slice(earlierCount)).toEqual([
      expect.objectContaining({ kind: "detached", sessionId: first.sessionId, reason: "rebound" }),
    ]);
    expect(h.bridge.getState(PROJECT_ID, first.sessionId)).toBeNull();
    expect(h.pickerEvents("documentReady")).toHaveLength(1);
    expect(h.sunk.some((payload) => payload.sessionId === first.sessionId)).toBe(false);
  });

  it("never evaluates an extractor in a document that replaced its own before the host saw it go", async () => {
    svelteNode();
    const h = makeHarness();
    let release!: () => void;
    h.extractorLoad.gate = new Promise((resolve) => {
      release = resolve;
    });
    await h.bind();
    await settle();
    expect(h.kinds("frameworks-probed")).toHaveLength(1);

    // CDP has replaced the document; Electron's `did-navigate` is still on its way.
    h.navigate(false);
    release();
    await settle();

    expect(h.wc.debugger.evaluates().some((entry) => entry.kind === "extractor")).toBe(false);
    expect(h.kinds("extractor-installed")).toHaveLength(0);
    expect(h.kinds("host-issue")).toHaveLength(0);
  });

  it("keeps the binding through a reload that lands under its first install", async () => {
    const h = makeHarness();
    h.wc.debugger.beforeIsolatedEvaluate = () => h.navigate();
    const state = await h.bind();
    await settle();

    expect(h.kinds("detached")).toHaveLength(0);
    expect(h.pickerEvents("documentReady").map((entry) => entry.documentEpoch)).toEqual([1]);
    expect(h.bridge.getState(PROJECT_ID, state.sessionId)?.guestReady).toBe(true);
  });

  it("retires an older picker it cannot reach through its own world", async () => {
    svelteNode();
    const h = makeHarness();
    const first = await h.bind();
    await settle();
    const registry = scope[EXTRACTOR_REGISTRY_GLOBAL] as { has(framework: string): boolean };
    expect(registry.has("svelte")).toBe(true);
    // Out of reach, as in a world a debugger session that came back cannot
    // see, so its disposal never arrives.
    delete scope[BOOTSTRAP_GLOBAL];
    await h.bridge.detach(PROJECT_ID, first.sessionId);

    let pageClicks = 0;
    const button = document.getElementById("cta")!;
    button.addEventListener("click", () => {
      pageClicks += 1;
    });
    button.click();
    expect(pageClicks).toBe(0);

    await h.bind("browse");
    await settle();
    button.click();
    expect(pageClicks).toBe(1);
    expect(registry.has("svelte")).toBe(false);
  });

  it("reports an extractor that fails to register, once, without retrying it", async () => {
    svelteNode();
    const h = makeHarness({
      catalog: { ...assets, "extractor:svelte": "/* registers nothing */" },
    });
    await h.bind();
    await settle();
    await vi.advanceTimersByTimeAsync(LATE_PROBE_DELAY_MS);
    await settle();

    expect(h.kinds("host-issue")).toEqual([
      expect.objectContaining({
        documentEpoch: 0,
        issue: expect.objectContaining({ code: "extractor-failed", framework: "svelte" }),
      }),
    ]);
    expect(h.wc.debugger.evaluates().filter((entry) => entry.kind === "extractor")).toHaveLength(1);
  });

  it("describes a React selection with the shipped extractor: names, owner, raw frames, and roots as element ids", async () => {
    const scope = globalThis as Record<string, unknown>;
    const actFlag = Object.getOwnPropertyDescriptor(scope, "IS_REACT_ACT_ENVIRONMENT");
    scope.IS_REACT_ACT_ENVIRONMENT = true;
    document.body.innerHTML = '<div id="root"></div>';
    const Card = ({ children }: { children?: ReactNode }) =>
      createElement("section", { className: "card" }, children);
    const Label = () => createElement("button", { id: "cta" }, "Go");
    const App = () => createElement(Card, null, createElement(Label));
    const root = createRoot(document.getElementById("root")!);
    try {
      act(() => root.render(createElement(App)));
      const h = makeHarness({ catalog: shipped });
      await h.bind();
      await settle();
      expect(h.kinds("extractor-installed")).toEqual([
        expect.objectContaining({ framework: "react" }),
      ]);

      document.getElementById("cta")!.click();
      await settle();
      const selections = h.pickerEvents("selectionChanged");
      const observation = (
        selections.at(-1)!.event as {
          observations: Array<{
            elementId: string;
            componentChain: {
              nearestId: string;
              components: Array<{
                componentId: string;
                name: { value: string } | null;
                renderParentId?: string | null;
                ownerId?: string | null;
                rootElementIds: string[];
              }>;
            };
            sourceCandidates: Array<{ kind: string; file: string }>;
          }>;
        }
      ).observations[0]!;
      const records = observation.componentChain.components;
      expect(records.map((record) => record.name?.value)).toEqual(["Label", "Card", "App"]);
      const [label, card, app] = records;
      expect(observation.componentChain.nearestId).toBe(label!.componentId);
      expect(label!.renderParentId).toBe(card!.componentId);
      expect(label!.ownerId).toBe(app!.componentId);
      // The page-world tokens arrived as the picker's own id for the picked element.
      expect(label!.rootElementIds).toEqual([observation.elementId]);
      expect(observation.sourceCandidates[0]).toMatchObject({ kind: "element-creation" });
      expect(observation.sourceCandidates[0]!.file).toContain("coreGuestHost.test.ts");
    } finally {
      act(() => root.unmount());
      if (actFlag) Object.defineProperty(scope, "IS_REACT_ACT_ENVIRONMENT", actFlag);
      else delete scope.IS_REACT_ACT_ENVIRONMENT;
    }
  });

  it("names the React component that renders a web component when a pick lands in its shadow root", async () => {
    const actFlag = Object.getOwnPropertyDescriptor(scope, "IS_REACT_ACT_ENVIRONMENT");
    scope.IS_REACT_ACT_ENVIRONMENT = true;
    document.body.innerHTML = '<div id="root"></div>';
    const tag = defineLitCard();
    const Hero = () =>
      createElement(tag, { id: "hero" }, createElement("p", { className: "projected" }, "Copy"));
    const Buy = () => createElement("button", { id: "buy" }, "Buy");
    const App = () => createElement("main", null, createElement(Hero), createElement(Buy));
    const root = createRoot(document.getElementById("root")!);
    try {
      act(() => root.render(createElement(App)));
      const h = makeHarness({ catalog: shipped });
      await h.bind();
      await settle();
      expect(h.kinds("extractor-installed")).toEqual([
        expect.objectContaining({ framework: "react" }),
      ]);
      const names = (observation: Observed) =>
        observation.componentChain.components.map((record) => record.name?.value);

      const host = document.getElementById("hero")!;
      (host.shadowRoot!.querySelector("button.action") as HTMLElement).click();
      await settle();
      const inside = lastObservation(h)!;
      expect(inside.context?.shadowHosts).toEqual([
        { elementId: expect.any(String), tagName: tag, label: `${tag}#hero` },
      ]);
      expect(names(inside)).toEqual(["Hero", "App"]);
      // React made the host, not the element inside it, so nothing says where that was written.
      expect(inside.sourceCandidates).toEqual([]);

      document.getElementById("buy")!.click();
      await settle();
      const buy = lastObservation(h)!;
      expect(names(buy)).toEqual(["Buy", "App"]);
      expect(buy.sourceCandidates[0]).toMatchObject({
        framework: "react",
        kind: "element-creation",
      });
      expect(buy.context?.shadowHosts ?? []).toEqual([]);
    } finally {
      act(() => root.unmount());
      if (actFlag) Object.defineProperty(scope, "IS_REACT_ACT_ENVIRONMENT", actFlag);
      else delete scope.IS_REACT_ACT_ENVIRONMENT;
    }
  });

  it("describes an Angular selection with the built extractor: host ancestry, declaring owner, file hints and hosts as element ids", async () => {
    document.body.innerHTML = '<div id="root"></div>';
    const angular = new FakeAngular();
    const Label: ComponentSpec = {
      selector: "app-label",
      className: "_LabelComponent",
      debugInfo: {
        className: "LabelComponent",
        filePath: "src/app/label.component.ts",
        lineNumber: 4,
      },
      template: [{ tag: "button", attrs: { id: "cta" }, children: [{ text: "Go" }] }],
    };
    const Card: ComponentSpec = {
      selector: "app-card",
      className: "_CardComponent",
      template: [{ tag: "section", children: [{ projection: true }] }],
    };
    angular.bootstrap(
      {
        selector: "app-root",
        className: "_AppComponent",
        debugInfo: { className: "AppComponent" },
        template: [{ component: Card, children: [{ component: Label }] }],
      },
      document.getElementById("root")!
    );
    vi.stubGlobal("ng", angular.ng);
    vi.stubGlobal("ngDevMode", {});
    try {
      const h = makeHarness({ catalog: shipped });
      await h.bind();
      await settle();
      expect(h.kinds("extractor-installed")).toEqual([
        expect.objectContaining({ framework: "angular" }),
      ]);

      document.getElementById("cta")!.click();
      await settle();
      const observation = (
        h.pickerEvents("selectionChanged").at(-1)!.event as {
          observations: Array<{
            componentChain: {
              nearestId: string;
              components: Array<{
                componentId: string;
                name: { value: string } | null;
                renderParentId?: string | null;
                ownerId?: string | null;
                rootElementIds: string[];
                sourceCandidates: Array<{ kind: string; file: string }>;
              }>;
            };
          }>;
        }
      ).observations[0]!;
      const records = observation.componentChain.components;
      expect(records.map((record) => record.name?.value)).toEqual([
        "LabelComponent",
        "_CardComponent",
        "AppComponent",
      ]);
      const [label, card, app] = records;
      expect(observation.componentChain.nearestId).toBe(label!.componentId);
      expect(label!.renderParentId).toBe(card!.componentId);
      expect(label!.ownerId).toBe(app!.componentId);
      expect(label!.sourceCandidates).toEqual([
        expect.objectContaining({ kind: "file-hint", file: "src/app/label.component.ts" }),
      ]);
      // Each root is that component's host, arrived as the picker's own id for it.
      const hostId = async (selector: string): Promise<string> => {
        (document.querySelector(selector) as HTMLElement).click();
        await settle();
        const event = h.pickerEvents("selectionChanged").at(-1)!.event as {
          observations: Array<{ elementId: string }>;
        };
        return event.observations[0]!.elementId;
      };
      expect(label!.rootElementIds).toEqual([await hostId("app-label")]);
      expect(card!.rootElementIds).toEqual([await hostId("app-card")]);
      expect(app!.rootElementIds).toEqual([await hostId("app-root")]);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("describes a Vue selection with the built Vue extractor: names, owner, roots, and a file without a line", async () => {
    // Taken before the runtime loads, which sets them as it evaluates.
    const globals = ["__VUE__", "__VUE_HMR_RUNTIME__"].filter((name) => !(name in scope));
    const vue = (await import(
      /* @vite-ignore */ createRequire(import.meta.url).resolve("vue/dist/vue.esm-browser.js")
    )) as typeof import("vue");
    document.body.innerHTML = '<div id="app"></div>';
    // As `@vitejs/plugin-vue` leaves components in dev; `withCtx` is what a compiled slot is wrapped in.
    const Card = {
      name: "Card",
      __file: "/projects/shop/src/Card.vue",
      render(this: { $slots: { default?: () => unknown[] } }) {
        return vue.h("section", { class: "card" }, this.$slots.default?.() as never);
      },
    } as unknown as Component;
    const App = {
      __name: "App",
      __file: "/projects/shop/src/App.vue",
      render: () =>
        vue.h(Card, null, { default: vue.withCtx(() => [vue.h("button", { id: "cta" }, "Go")]) }),
    } as unknown as Component;
    const app = vue.createApp(App);
    app.mount("#app");
    try {
      const h = makeHarness({ catalog: shipped });
      await h.bind();
      await settle();
      expect(h.kinds("extractor-installed")).toEqual([
        expect.objectContaining({ framework: "vue" }),
      ]);

      document.getElementById("cta")!.click();
      await settle();
      const observation = (
        h.pickerEvents("selectionChanged").at(-1)!.event as {
          observations: Array<{
            componentChain: {
              nearestId: string;
              components: Array<{
                componentId: string;
                name: { value: string } | null;
                renderParentId?: string | null;
                ownerId?: string | null;
                rootElementIds: string[];
              }>;
            };
            sourceCandidates: Array<{ kind: string; file: string; location?: unknown }>;
          }>;
        }
      ).observations[0]!;
      const records = observation.componentChain.components;
      expect(records.map((record) => record.name?.value)).toEqual(["Card", "App"]);
      const [card, root] = records;
      expect(observation.componentChain.nearestId).toBe(card!.componentId);
      expect(card!.renderParentId).toBe(root!.componentId);
      expect(card!.ownerId).toBe(root!.componentId);
      expect(card!.rootElementIds).toHaveLength(1);
      // Written in App, rendered by Card: the file is App's, and only a file.
      expect(observation.sourceCandidates).toEqual([
        expect.objectContaining({ kind: "file-hint", file: "/projects/shop/src/App.vue" }),
      ]);
      expect(observation.sourceCandidates[0]).not.toHaveProperty("location");
    } finally {
      app.unmount();
      for (const name of globals) delete scope[name];
    }
  });
});

describe("the shipped Svelte extractor", () => {
  type Selection = {
    cause: string;
    observations: Array<{
      elementId: string;
      sourceCandidates: Array<{ kind: string; file: string }>;
      frameworkEvidence: Array<{ kind: string; sameLocCount?: number; locIndex?: number }>;
    }>;
  };
  const lastSelection = (h: ReturnType<typeof makeHarness>) =>
    h.pickerEvents("selectionChanged").at(-1)?.event as Selection | undefined;

  it("describes a stamped element in terms the host admits", async () => {
    const node = svelteNode();
    const h = makeHarness();
    const state = await h.bind();
    await settle();

    (node as HTMLButtonElement).click();
    await settle();

    const [observation] = lastSelection(h)?.observations ?? [];
    expect(observation?.sourceCandidates).toEqual([
      expect.objectContaining({ kind: "template-location", file: "src/App.svelte" }),
    ]);
    expect(observation?.frameworkEvidence).toEqual([
      expect.objectContaining({ kind: "svelte", sameLocCount: 1, locIndex: 0 }),
    ]);
    // Every envelope the guest sent was admitted by the host's own schema.
    expect(h.bridge.getState(PROJECT_ID, state.sessionId)?.droppedMessages).toBe(0);
  });

  it("selects again through the host's reselect source, for its own install only", async () => {
    svelteNode();
    const h = makeHarness();
    await h.bind();
    await settle();
    const installId = (scope[BOOTSTRAP_GLOBAL] as { installId: number }).installId;
    const request = {
      framework: "svelte" as const,
      locator: { loc: { file: "src/App.svelte", line: 3, column: 2 }, index: 0 },
    };
    const evaluate = (source: string) => new Function(`return ${source}`)() as unknown;

    expect(evaluate(buildPickerReselectSource(installId + 1, request))).toBe(false);
    expect(evaluate(buildPickerReselectSource(installId, request))).toBe(true);
    await settle();

    expect(lastSelection(h)?.cause).toBe("reselect");
    expect(lastSelection(h)?.observations).toHaveLength(1);
  });

  it("selects again when the view asks the bridge, through the binding's own world", async () => {
    svelteNode();
    const h = makeHarness();
    const state = await h.bind();
    await settle();
    const before = h.pickerEvents("selectionChanged").length;

    const found = await h.bridge.reselectElementPicker(PROJECT_ID, state.sessionId, {
      sessionId: state.sessionId,
      framework: "svelte",
      locator: { loc: { file: "src/App.svelte", line: 3, column: 2 }, index: 0 },
    });
    await settle();

    expect(found).toBe(true);
    expect(h.pickerEvents("selectionChanged")).toHaveLength(before + 1);
    expect(lastSelection(h)?.cause).toBe("reselect");
    // A locator that names nothing in the page selects nothing.
    await expect(
      h.bridge.reselectElementPicker(PROJECT_ID, state.sessionId, {
        sessionId: state.sessionId,
        framework: "svelte",
        locator: { loc: { file: "src/Other.svelte", line: 1, column: 0 }, index: 0 },
      })
    ).resolves.toBe(false);
  });

  it("carries none of the shared schemas into the page", () => {
    expect(assets["extractor:svelte"]).not.toMatch(/ZodError|\$ZodType/);
  });
});

type Observed = SelectionObservation;

function lastObservation(h: ReturnType<typeof makeHarness>): Observed | undefined {
  const event = h.pickerEvents("selectionChanged").at(-1)?.event as
    { observations: Observed[] } | undefined;
  return event?.observations[0];
}

function everyCapability(capability: Capability): Capabilities {
  return {
    names: capability,
    chain: capability,
    componentSelection: capability,
    file: capability,
    line: capability,
    exactRange: capability,
  };
}

describe("DOM-level picking on a page with no component information", () => {
  const cleanups: Array<() => void> = [];
  afterEach(() => {
    while (cleanups.length > 0) cleanups.pop()?.();
  });

  it("settles a static page as having no framework, and describes the element from the DOM", async () => {
    const page = mountStaticPage();
    cleanups.push(page.cleanup);
    const h = makeHarness();
    await h.bind();
    await settle();
    await vi.advanceTimersByTimeAsync(LATE_PROBE_DELAY_MS);
    await settle();

    (page.target as HTMLElement).click();
    await settle();

    const observation = lastObservation(h)!;
    expect(observation.capabilities).toEqual(
      everyCapability({ state: "unavailable", reason: "no-framework" })
    );
    expect(observation.componentChain).toEqual({
      nearestId: null,
      components: [],
      truncated: false,
    });
    expect(observation.sourceCandidates).toEqual([]);
    expect(observation.detections).toEqual([]);
    expect(observation.context?.selector).toBe("button.cta.primary");
    expect(observation.context?.markup).toBe(
      '<button type="button" class="cta primary">Get started</button>'
    );
    expect(observation.context?.styles.map((entry) => entry.property)).toContain("display");
    expect(observation.context?.shadowHosts).toEqual([]);
  });

  it.each([
    ["client-rendered", {}],
    ["server-rendered and hydrated", { hydrated: true }],
  ])(
    "reads a stock %s Solid 1.9 page as Solid whose components and source are not exposed",
    async (_label, options) => {
      const page = mountSolidPage(options);
      cleanups.push(page.cleanup);
      const h = makeHarness();
      await h.bind();
      await settle();
      await vi.advanceTimersByTimeAsync(LATE_PROBE_DELAY_MS);
      await settle();
      expect(h.wc.debugger.evaluates().filter((entry) => entry.kind === "extractor")).toEqual([
        { kind: "extractor", framework: "solid" },
      ]);

      (page.target as HTMLElement).click();
      await settle();

      const observation = lastObservation(h)!;
      expect(observation.capabilities).toEqual(
        everyCapability({ state: "unavailable", reason: "not-exposed" })
      );
      expect(observation.componentChain.components).toEqual([]);
      expect(observation.sourceCandidates).toEqual([]);
      expect(observation.context?.selector).toBe("button.increment");
      expect(observation.context?.markup).toContain("Count: 0");
    }
  );

  it("takes the creation site solid-devtools left on the element, and never calls the debugger", async () => {
    const page = mountSolidPage({ devtools: true });
    cleanups.push(page.cleanup);
    const h = makeHarness();
    let release!: () => void;
    h.extractorLoad.gate = new Promise((resolve) => {
      release = resolve;
    });
    await h.bind();
    await settle();
    await vi.advanceTimersByTimeAsync(LATE_PROBE_DELAY_MS);
    await settle();

    // Pointed at before Solid's reader arrived: nothing is claimed either way.
    (page.target as HTMLElement).click();
    await settle();
    expect(lastObservation(h)!.capabilities).toEqual(everyCapability({ state: "unknown" }));

    release();
    await settle();
    // The install held the binding's queue, so the page's late look came after
    // it: the creation site arrives first, and what Solid does not expose is
    // only said once that look has also come back.
    const selections = h
      .pickerEvents("selectionChanged")
      .map((entry) => entry.event as { cause: string; observations: Observed[] });
    expect(selections.map((event) => event.cause)).toEqual(["user", "reselect", "reselect"]);
    expect(selections[1]!.observations[0]!.capabilities).toEqual({
      ...everyCapability({ state: "unknown" }),
      file: { state: "available" },
      line: { state: "available" },
    });
    const observation = lastObservation(h)!;
    expect(observation.sourceCandidates).toEqual([
      {
        kind: "element-creation",
        candidateId: "solid-source-loc",
        framework: "solid",
        extraction: { kind: "attribute", attribute: "data-source-loc" },
        file: "src/components/Counter.tsx",
        location: { lineBase: 1, columnBase: 0, columnUnit: "utf16", line: 14, column: 8 },
      },
    ]);
    expect(observation.componentChain.components).toEqual([]);
    expect(observation.capabilities).toEqual({
      ...everyCapability({ state: "unavailable", reason: "not-exposed" }),
      file: { state: "available" },
      line: { state: "available" },
    });
    expect(page.debuggerTouches()).toBe(0);
  });

  it("keeps Svelte's reader, finding nothing of its own, from shadowing Solid's creation site on a mixed page", async () => {
    const page = mountSolidPage({ devtools: true });
    cleanups.push(page.cleanup);
    // Detected first, so Svelte's reader registers before Solid's.
    scope.__svelte = {};
    cleanups.push(() => delete scope.__svelte);
    const h = makeHarness();
    await h.bind();
    await settle();
    await vi.advanceTimersByTimeAsync(LATE_PROBE_DELAY_MS);
    await settle();
    expect(h.kinds("extractor-installed").map((entry) => entry.framework)).toEqual([
      "svelte",
      "solid",
    ]);

    (page.target as HTMLElement).click();
    await settle();
    const observation = lastObservation(h)!;
    expect(observation.sourceCandidates.map((candidate) => candidate.framework)).toEqual(["solid"]);
    // Svelte's reader looked at the element and found nothing of Svelte's, so
    // what Solid says it lacks is what the page has to offer.
    expect(observation.capabilities).toEqual({
      ...everyCapability({ state: "unavailable", reason: "not-exposed" }),
      file: { state: "available" },
      line: { state: "available" },
    });
  });

  it("picks inside a Lit element by the DOM alone, naming its shadow host and no framework", async () => {
    const page = mountLitPage();
    cleanups.push(page.cleanup);
    const h = makeHarness();
    await h.bind();
    await settle();
    await vi.advanceTimersByTimeAsync(LATE_PROBE_DELAY_MS);
    await settle();
    expect(h.wc.debugger.evaluates().some((entry) => entry.kind === "extractor")).toBe(false);

    (page.target as HTMLElement).click();
    await settle();
    const inside = lastObservation(h)!;
    expect(inside.detections).toEqual([]);
    expect(inside.capabilities).toEqual(
      everyCapability({ state: "unavailable", reason: "no-framework" })
    );
    expect(inside.componentChain.components).toEqual([]);
    expect(inside.context?.selector).toBe("button.action");
    expect(inside.context?.shadowHosts).toEqual([
      { elementId: expect.any(String), tagName: LIT_CARD_TAG, label: `${LIT_CARD_TAG}#hero` },
    ]);
    // Lit's version globals identify nothing about the element, so nothing of them is sent.
    expect(JSON.stringify(inside)).not.toMatch(/Versions|4\.2\.0|3\.3\.0/);

    window.dispatchEvent(
      new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true, cancelable: true })
    );
    window.dispatchEvent(
      new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true, cancelable: true })
    );
    await settle();
    const host = lastObservation(h)!;
    expect(host.elementId).toBe(inside.context?.shadowHosts?.[0]?.elementId);
    expect(host.context?.markup).toBe(
      `<${LIT_CARD_TAG} id="hero"><template shadowrootmode="open"><article class="card">` +
        '<h2 class="heading">…</h2><div class="body">…</div><button class="action">…</button>' +
        `</article></template><p class="projected">Slotted copy</p></${LIT_CARD_TAG}>`
    );
  });
});

describe("the Preact extractor as the app builds it", () => {
  it("is installed on a page Preact rendered, and describes a selection in terms the host admits", async () => {
    document.body.innerHTML = '<div id="root"></div>';
    const root = document.getElementById("root")!;
    const Card = ({ children }: { children?: ComponentChildren }) =>
      preactElement("section", { class: "card" }, children);
    const Label = () => preactElement("button", { id: "cta" }, "Go");
    renderPreact(preactElement(Card, null, preactElement(Label, null)), root);
    try {
      const h = makeHarness({ catalog: shipped });
      const state = await h.bind();
      await settle();
      // Found by the render container's own `__k`; no node Preact drew carries one.
      expect(h.kinds("extractor-installed")).toEqual([
        expect.objectContaining({ framework: "preact" }),
      ]);

      document.getElementById("cta")!.click();
      await settle();
      const observation = (
        h.pickerEvents("selectionChanged").at(-1)!.event as {
          observations: Array<{
            elementId: string;
            componentChain: {
              nearestId: string;
              components: Array<{
                componentId: string;
                name: { value: string } | null;
                renderParentId?: string | null;
                rootElementIds: string[];
              }>;
            };
          }>;
        }
      ).observations[0]!;
      const [label, card] = observation.componentChain.components;
      expect(observation.componentChain.components.map((record) => record.name?.value)).toEqual([
        "Label",
        "Card",
      ]);
      expect(observation.componentChain.nearestId).toBe(label!.componentId);
      expect(label!.renderParentId).toBe(card!.componentId);
      expect(card!.renderParentId).toBeNull();
      expect(label!.rootElementIds).toEqual([observation.elementId]);
      expect(h.bridge.getState(PROJECT_ID, state.sessionId)?.droppedMessages).toBe(0);
    } finally {
      renderPreact(null, root);
    }
  });

  it("carries none of the shared schemas into the page", () => {
    // That it bundles nothing of Preact's is core-picker-assets.test.mjs's to prove, from the bundler's graph.
    expect(shipped["extractor:preact"]).not.toMatch(/ZodError|\$ZodType/);
  });
});
