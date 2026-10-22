// @vitest-environment jsdom
import { EventEmitter } from "node:events";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  webContents: { getAllWebContents: () => [], fromId: () => null },
  app: { getAppPath: () => "/nonexistent", isPackaged: false },
}));

import { SitePreviewBridge } from "../../SitePreviewBridge.js";
import { __resetCdpLeasesForTests } from "../../cdp/WebContentsCdpService.js";
import { LATE_PROBE_DELAY_MS } from "../coreGuest.js";
import { BOOTSTRAP_GLOBAL, EXTRACTOR_REGISTRY_GLOBAL } from "../guestChannel.js";
import type { ElementPickerPushPayload } from "../types.js";
import type { SitePreviewPushPayload } from "../../../../shared/types/ipc/sitePreview.js";
import { buildCoreGuestAssets } from "./buildCoreGuestAssets.js";

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

  /**
   * A cross-document navigation as CDP reports it, and — unless `observed` is
   * false, standing in for Electron's event arriving late — as Electron does.
   */
  navigate(wc: EventEmitter, observed = true): void {
    this.emit("message", {} as Electron.Event, "Runtime.executionContextsCleared", {});
    this.mainWorld += 1;
    this.announceMainWorld();
    if (observed) wc.emit("did-navigate");
  }

  async sendCommand(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    this.commands.push({ method, params });
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
          const value = new Function(`return ${source}`)() as unknown;
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
        if (expression.includes("const api = { result: null }")) return { kind: "probe" as const };
        const framework = /framework: "([a-z]+)", installed: false/.exec(expression)?.[1];
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

let assets: Record<string, string> = {};

beforeAll(() => {
  assets = buildCoreGuestAssets([
    {
      id: "extractor:react",
      entry: "electron/services/elementPicker/__tests__/fixtures/contributingExtractor.ts",
    },
  ]);
}, 60_000);

function makeHarness(options: { catalog?: Record<string, string> } = {}) {
  const catalog = options.catalog ?? assets;
  const wc = new FakeWebContents(WEB_CONTENTS_ID);
  const subscriber = new FakeWebContents(SUBSCRIBER_WC_ID);
  const sunk: ElementPickerPushPayload[] = [];
  const pushed: SitePreviewPushPayload[] = [];
  const extractorLoad: { gate: Promise<void> | null } = { gate: null };
  let sessions = 0;
  const bridge = new SitePreviewBridge({
    push: (payload) => pushed.push(payload),
    isPluginEnabled: async () => true,
    listGuests: () => [],
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
    resolveGuestAdapter: (adapterId) =>
      adapterId === "test.guest" ? { id: adapterId, pluginId: "test.plugin" } : null,
    loadGuestAdapterSource: async () => "",
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
  return { bridge, wc, sunk, pushed, extractorLoad, bind, navigate, kinds, pickerEvents };
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

beforeEach(() => {
  __resetCdpLeasesForTests();
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  document.body.innerHTML = "";
});

afterEach(() => {
  vi.useRealTimers();
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

  it("injects the dummy extractor only after a detection names its framework", async () => {
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
    // Astro has no extractor in this build; React's fixture does.
    expect(h.wc.debugger.evaluates().filter((entry) => entry.kind === "extractor")).toEqual([
      { kind: "extractor", framework: "react" },
    ]);
    expect(h.kinds("host-issue")).toHaveLength(0);

    const selections = h.pickerEvents("selectionChanged");
    expect(selections.map((entry) => (entry.event as { cause: string }).cause)).toEqual([
      "user",
      "reselect",
    ]);
    const described = selections[1]!.event as {
      observations: Array<{ componentChain: { components: Array<{ name: { value: string } }> } }>;
    };
    expect(described.observations[0]!.componentChain.components[0]!.name.value).toBe(
      "FixtureButton"
    );
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
        protocolVersion: 1,
        sessionId: state.sessionId,
        documentEpoch: 0,
        sequence: 99,
        event: { type: "frameworksDetected", detections: [] },
      }),
    });
    expect(h.sunk.length).toBe(before);
    expect(h.bridge.getState(PROJECT_ID, state.sessionId)?.droppedMessages).toBe(1);
  });

  it("keeps core traffic off the plugin channel and supersedes a plugin binding on the panel", async () => {
    const h = makeHarness();
    await h.bridge.bind({
      projectId: PROJECT_ID,
      panelId: PANEL_ID,
      adapterId: "test.guest",
      mode: "browse",
      subscriberWebContentsId: SUBSCRIBER_WC_ID,
    });
    await h.bind();
    await settle();

    expect(h.pushed.map((payload) => payload.kind)).toEqual(["detached"]);
    expect(h.pushed[0]).toMatchObject({ reason: "rebound" });
    expect(h.pickerEvents("documentReady")).toHaveLength(1);
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
});
