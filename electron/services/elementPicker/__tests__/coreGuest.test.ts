import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({ app: { getAppPath: () => "/app", isPackaged: false } }));

import { ELEMENT_PICKER_PROTOCOL_VERSION } from "../../../../shared/elementPicker/protocol.js";
import type { FrameworkDetection } from "../../../../shared/elementPicker/observation.js";
import type { ElementPickerProviderContribution } from "../../../../shared/elementPicker/providers.js";
import {
  registerElementPickerProviders,
  unregisterElementPickerProviders,
} from "../../elementPickerProviderRegistry.js";
import { CoreGuest, type CoreGuestDeps } from "../coreGuest.js";
import type { CoreGuestAssetId } from "../guestAssets.js";
import { EXTRACTOR_INSTALL_STATUS } from "../guestChannel.js";
import type { PickerAvailability } from "../guest/types.js";
import type { ElementPickerPushPayload } from "../types.js";

const CONTEXT_ID = 5;
const SVELTE: FrameworkDetection[] = [
  { framework: "svelte", signals: [{ via: "expando", name: "__svelte_meta" }] },
];
const REACT: FrameworkDetection[] = [
  { framework: "react", signals: [{ via: "expando", name: "__reactFiber" }] },
];
const ASTRO: FrameworkDetection[] = [
  { framework: "astro", signals: [{ via: "document-sample", name: "<astro-dev-toolbar>" }] },
];
const SERVED = {
  url: "http://localhost/",
  html: '<h1 data-astro-source-file="/p/src/pages/index.astro" data-astro-source-loc="6:9">Shop</h1>',
};
const READY = {
  type: "documentReady",
  url: "http://localhost/",
  viewport: { width: 1, height: 1, deviceScaleFactor: 1 },
} as const;

type Call = { method: string; params: Record<string, unknown> };

/**
 * A guest whose evaluates answer by what they install: the probe returns
 * `probeResult`, an extractor returns `extractorStatus`. Everything else in the
 * host's sequence is acknowledged.
 */
function harness(
  overrides: {
    probeResult?: unknown;
    /** Answers for successive probes, in order; past the last, `probeResult`. */
    probeResults?: unknown[];
    extractorStatus?: unknown;
    extractorError?: Error;
    assets?: Partial<Record<CoreGuestAssetId, string | Error>>;
    assetGate?: Promise<void>;
    noWorld?: true;
    /** The bootstrap evaluate fails as an evaluate into a world whose document is gone does. */
    worldGone?: true;
    /** How the page answers a reselect: a value, or a thrown error. */
    reselect?: (() => unknown) | { error: Error };
    /** Reads a plugin provider's entry; the default returns a stub body. */
    loadPluginAsset?: CoreGuestDeps["loadPluginAsset"];
    /** How the browser answers a read of the document as served; the default is `SERVED`. */
    servedContent?: () => Promise<unknown>;
  } = {}
) {
  const calls: Call[] = [];
  const emitted: ElementPickerPushPayload[] = [];
  const state = { epoch: 0 as number | null };
  const main = { uniqueId: "main-1" as string | null, generation: 3 };
  let queue: Promise<void> = Promise.resolve();
  const timers: Array<() => void> = [];
  const loaded: CoreGuestAssetId[] = [];
  const assets: Partial<Record<CoreGuestAssetId, string | Error>> = {
    bootstrap: "/* bootstrap */",
    probe: "/* probe */",
    "extractor:svelte": "/* svelte */",
    "extractor:react": "/* react */",
    "extractor:astro": "/* astro */",
    "plugin-runtime": "/* runtime */",
    ...overrides.assets,
  };

  const deps: CoreGuestDeps = {
    sessionId: "session-1",
    projectId: "project-1",
    bindingName: "__binding",
    async send(method, params = {}) {
      calls.push({ method, params });
      if (method === "Page.createIsolatedWorld") {
        return overrides.noWorld ? {} : { executionContextId: CONTEXT_ID };
      }
      if (method === "Page.getFrameTree") {
        return { frameTree: { frame: { id: "main", url: SERVED.url, mimeType: "text/html" } } };
      }
      if (method === "Page.getResourceContent") {
        return overrides.servedContent
          ? overrides.servedContent()
          : { content: SERVED.html, base64Encoded: false };
      }
      if (method !== "Runtime.evaluate") return {};
      const expression = params.expression as string;
      if (params.contextId === CONTEXT_ID && overrides.worldGone) {
        throw new Error("Cannot find context with specified id");
      }
      if (expression.includes("api.reselect(")) {
        const reselect = overrides.reselect ?? (() => ({ result: { value: true } }));
        if (typeof reselect !== "function") throw reselect.error;
        return reselect();
      }
      if (expression.includes("const api = { result: null,")) {
        const next = overrides.probeResults?.shift();
        return { result: { value: next ?? overrides.probeResult ?? null } };
      }
      if (expression.includes("installed: false")) {
        if (overrides.extractorError) throw overrides.extractorError;
        return {
          result: { value: overrides.extractorStatus ?? EXTRACTOR_INSTALL_STATUS.installed },
        };
      }
      return { result: {} };
    },
    enqueue(work) {
      const next = queue.then(work, work);
      queue = next.catch(() => undefined);
      return next;
    },
    async loadAsset(id) {
      loaded.push(id);
      if (id.startsWith("extractor:") && overrides.assetGate) await overrides.assetGate;
      const asset = assets[id];
      if (asset instanceof Error) throw asset;
      return asset ?? null;
    },
    loadPluginAsset: overrides.loadPluginAsset ?? (async () => "/* plugin entry */"),
    emit: (payload) => emitted.push(payload),
    liveEpoch: () => state.epoch,
    mainWorld: () => ({ ...main }),
    evaluateTimeoutMs: 1000,
    setTimer: (callback) => {
      timers.push(callback);
      return timers.length;
    },
    clearTimer: vi.fn(),
    newChannel: () => "channel-1",
  };
  const guest = new CoreGuest(deps);
  const install = () =>
    guest.install({ epoch: 0, installId: 7, mode: "select", origins: "any", frameId: "main" });
  const settle = async () => {
    for (let round = 0; round < 20; round += 1) await queue;
  };
  const extractorEvaluates = () =>
    calls.filter(
      (call) =>
        call.method === "Runtime.evaluate" &&
        (call.params.expression as string).includes("installed: false")
    );
  /** What the host told the picker about the document's readers, in the order it said it. */
  const availabilities = () =>
    calls.flatMap((call) => {
      const match = /api\.setAvailability\((.*)\);/.exec(String(call.params.expression ?? ""));
      return match === null ? [] : [JSON.parse(match[1]!) as PickerAvailability];
    });
  const removals = () =>
    calls.filter(
      (call) =>
        call.method === "Runtime.evaluate" &&
        (call.params.expression as string).includes("registry.unregister(")
    );
  const pluginInstalls = () =>
    calls.filter(
      (call) =>
        call.method === "Runtime.evaluate" &&
        (call.params.expression as string).includes('framework: "acme.qwik.qwik"')
    );
  /** The extractor assets read, in the order they were asked for. */
  const extractorsLoaded = () => loaded.filter((id) => id.startsWith("extractor:"));
  return {
    guest,
    deps,
    calls,
    emitted,
    state,
    main,
    timers,
    loaded,
    install,
    settle,
    extractorEvaluates,
    extractorsLoaded,
    availabilities,
    removals,
    pluginInstalls,
  };
}

describe("CoreGuest provider admission", () => {
  afterEach(() => unregisterElementPickerProviders("acme.qwik"));

  const admission = { sessionId: "s1", documentEpoch: 0, lastSequence: -1 };
  const runtimeIssue = (framework: string) =>
    JSON.stringify({
      protocolVersion: ELEMENT_PICKER_PROTOCOL_VERSION,
      sessionId: "s1",
      documentEpoch: 0,
      sequence: 0,
      event: {
        type: "runtimeIssue",
        code: "extractor-failed",
        framework,
        detail: "x",
      },
    });

  it("admits a core framework and refuses an unregistered provider id", () => {
    const { guest } = harness();
    expect(guest.admit(runtimeIssue("react"), admission).ok).toBe(true);
    expect(guest.admit(runtimeIssue("acme.qwik.qwik"), admission).ok).toBe(false);
  });

  it("admits a registered provider, and refuses it again once its plugin unloads", () => {
    const { guest } = harness();
    registerElementPickerProviders("acme.qwik", "acme.qwik", [
      {
        id: "qwik",
        name: "Qwik",
        detection: [{ kind: "global", name: "qwikevents", match: "exact" }],
        guestEntry: "guest/qwik.js",
      },
    ]);
    expect(guest.admit(runtimeIssue("acme.qwik.qwik"), admission).ok).toBe(true);
    unregisterElementPickerProviders("acme.qwik");
    expect(guest.admit(runtimeIssue("acme.qwik.qwik"), admission).ok).toBe(false);
  });

  it("drops a probed detection naming an unregistered provider but keeps the rest", async () => {
    const { guest, emitted, install, settle } = harness({
      probeResult: [
        { framework: "acme.qwik.qwik", signals: [{ via: "global", name: "qwikevents" }] },
        ...REACT,
      ],
    });
    await install();
    guest.onGuestEvent(0, READY);
    await settle();
    const probed = emitted.find((payload) => payload.kind === "frameworks-probed");
    expect(
      probed?.kind === "frameworks-probed" && probed.detections.map((d) => d.framework)
    ).toEqual(["react"]);
  });
});

describe("CoreGuest", () => {
  it("installs the bootstrap into its own world, with the binding scoped to that world", async () => {
    const h = harness();
    expect(h.guest.isTrustedContext(CONTEXT_ID)).toBe(false);
    await h.install();
    expect(h.calls.map((call) => call.method)).toEqual([
      "Runtime.addBinding",
      "Page.createIsolatedWorld",
      "Runtime.evaluate",
    ]);
    expect(h.calls[0]!.params.executionContextName).toBe(h.guest.worldName);
    expect(h.calls[2]!.params.contextId).toBe(CONTEXT_ID);
    expect(h.guest.isTrustedContext(CONTEXT_ID)).toBe(true);
    expect(h.guest.isTrustedContext(CONTEXT_ID + 1)).toBe(false);
  });

  it("reports an install whose world went with its document as not installed, not as a failure", async () => {
    const h = harness({ worldGone: true });
    await expect(h.install()).resolves.toBe(false);
    await expect(harness().install()).resolves.toBe(true);
  });

  it("fails the install when the catalog has no bootstrap or the guest makes no world", async () => {
    await expect(harness({ assets: { bootstrap: undefined } }).install()).rejects.toThrow(
      "bootstrap is missing"
    );
    await expect(harness({ noWorld: true }).install()).rejects.toThrow("isolated world");
  });

  it("probes on documentReady and trusts only a result that matches the wire schema", async () => {
    const h = harness({
      probeResult: [{ framework: "svelte", signals: [{ via: "expando", name: "x".repeat(500) }] }],
    });
    await h.install();
    h.guest.onGuestEvent(0, READY);
    await h.settle();
    expect(h.emitted).toEqual([]);
    expect(h.extractorEvaluates()).toHaveLength(0);
    // Nor is it evidence the page has no framework: the picker is told nothing.
    expect(h.availabilities()).toEqual([]);
  });

  it("settles detection once its late look also found nothing, and tells the picker so once", async () => {
    const h = harness({ probeResult: [] });
    await h.install();
    h.guest.onGuestEvent(0, READY);
    await h.settle();
    // An app that mounts after it reported ready would be missed by the first look alone.
    expect(h.availabilities()).toEqual([]);
    h.timers[0]!();
    await h.settle();
    expect(h.emitted).toEqual([]);
    expect(h.availabilities()).toEqual([{ detection: "settled", extractors: {} }]);
    const call = h.calls.find((entry) =>
      String(entry.params.expression).includes("api.setAvailability(")
    );
    // Into the picker's own world, for this install's bootstrap only.
    expect(call?.params.contextId).toBe(CONTEXT_ID);
    expect(call?.params.expression).toContain("api.installId !== 7");
  });

  it("tells the picker each framework is pending, then what its install came to", async () => {
    const h = harness({ probeResult: SVELTE });
    await h.install();
    h.guest.onGuestEvent(0, READY);
    await h.settle();
    h.timers[0]!();
    await h.settle();
    expect(h.availabilities()).toEqual([
      { detection: "pending", extractors: { svelte: "pending" } },
      { detection: "pending", extractors: { svelte: "installed" } },
      { detection: "settled", extractors: { svelte: "installed" } },
    ]);
  });

  it("settles on a late look that comes back well-formed after a first that did not", async () => {
    const h = harness({ probeResults: [{ forged: true }, []] });
    await h.install();
    h.guest.onGuestEvent(0, READY);
    await h.settle();
    h.timers[0]!();
    await h.settle();
    expect(h.availabilities()).toEqual([{ detection: "settled", extractors: {} }]);
  });

  it("keeps detection open when the late look's answer fails the schema", async () => {
    const h = harness({ probeResults: [[], { forged: true }] });
    await h.install();
    h.guest.onGuestEvent(0, READY);
    await h.settle();
    h.timers[0]!();
    await h.settle();
    expect(h.availabilities()).toEqual([]);
  });

  it("probes again for a reinstall into the same document", async () => {
    const h = harness({ probeResult: [] });
    const probes = () =>
      h.calls.filter((call) =>
        String(call.params.expression).includes("const api = { result: null,")
      ).length;
    await h.install();
    h.guest.onGuestEvent(0, READY);
    await h.settle();
    expect(probes()).toBe(1);
    await h.install();
    h.guest.onGuestEvent(0, READY);
    await h.settle();
    expect(probes()).toBe(2);
  });

  it("ends an install whose evaluate lost its world as failed, so the picker stops waiting on it", async () => {
    const h = harness({ extractorError: new Error("Cannot find context with specified id") });
    await h.install();
    h.guest.onGuestEvent(0, { type: "frameworksDetected", detections: SVELTE });
    await h.settle();
    expect(h.emitted).toEqual([]);
    expect(h.availabilities().at(-1)).toEqual({
      detection: "pending",
      extractors: { svelte: "failed" },
    });
  });

  it.each([
    ["the catalog lists no reader for it", { framework: "angular" }, "unavailable"],
    ["its reader fails to install", { extractorStatus: EXTRACTOR_INSTALL_STATUS.threw }, "failed"],
  ] as const)("tells the picker when %s", async (_label, overrides, expected) => {
    const framework = "framework" in overrides ? overrides.framework : "svelte";
    const h = harness("extractorStatus" in overrides ? overrides : {});
    await h.install();
    h.guest.onGuestEvent(0, {
      type: "frameworksDetected",
      detections: [{ framework, signals: [{ via: "attribute", name: "marker" }] }],
    });
    await h.settle();
    // No probe has come back, so detection itself is still open.
    expect(h.availabilities()).toEqual([
      { detection: "pending", extractors: { [framework]: "pending" } },
      { detection: "pending", extractors: { [framework]: expected } },
    ]);
  });

  it("tells a document that is no longer current nothing", async () => {
    let release!: () => void;
    const h = harness({ assetGate: new Promise((resolve) => (release = resolve)) });
    await h.install();
    h.guest.onGuestEvent(0, { type: "frameworksDetected", detections: SVELTE });
    const told = h.availabilities().length;
    h.state.epoch = 1;
    h.guest.invalidate();
    release();
    await h.settle();
    expect(h.availabilities()).toHaveLength(told);
  });

  it("schedules exactly one late probe per document, and cancels it with the document", async () => {
    const h = harness();
    await h.install();
    h.guest.onGuestEvent(0, READY);
    h.guest.onGuestEvent(0, READY);
    expect(h.timers).toHaveLength(1);

    h.guest.invalidate();
    // A timer left armed would keep a dead binding's guest alive until it fired.
    expect(h.deps.clearTimer).toHaveBeenCalledWith(1);
  });

  it("aims the probe and extractors at the bootstrap document's main world", async () => {
    const h = harness({ probeResult: SVELTE });
    await h.install();
    h.guest.onGuestEvent(0, READY);
    await h.settle();
    const mainWorld = h.calls.filter(
      (call) => call.method === "Runtime.evaluate" && call.params.contextId === undefined
    );
    expect(mainWorld.map((call) => call.params.uniqueContextId)).toEqual(["main-1", "main-1"]);
    expect(h.extractorEvaluates()).toHaveLength(1);
  });

  it("evaluates nothing in the main world when it cannot name the bootstrap's document", async () => {
    const unknown = harness({ probeResult: SVELTE });
    unknown.main.uniqueId = null;
    await unknown.install();
    unknown.guest.onGuestEvent(0, READY);
    unknown.guest.onGuestEvent(0, { type: "frameworksDetected", detections: SVELTE });
    await unknown.settle();
    expect(
      unknown.calls.filter(
        (c) => c.method === "Runtime.evaluate" && c.params.contextId === undefined
      )
    ).toHaveLength(0);

    // The lease has moved to a later document the bridge has not heard about yet.
    const later = harness();
    await later.install();
    later.main.generation += 1;
    later.main.uniqueId = "main-2";
    later.guest.onGuestEvent(0, { type: "frameworksDetected", detections: SVELTE });
    await later.settle();
    expect(later.extractorEvaluates()).toHaveLength(0);
    expect(later.emitted).toEqual([]);
  });

  it("drops a detection for a document that is no longer current", async () => {
    const h = harness();
    await h.install();
    h.guest.onGuestEvent(1, { type: "frameworksDetected", detections: SVELTE });
    await h.settle();
    expect(h.extractorEvaluates()).toHaveLength(0);
  });

  it("never evaluates an extractor whose read finished after the document changed", async () => {
    let release!: () => void;
    const h = harness({ assetGate: new Promise((resolve) => (release = resolve)) });
    await h.install();
    h.guest.onGuestEvent(0, { type: "frameworksDetected", detections: SVELTE });
    h.state.epoch = 1;
    h.guest.invalidate();
    release();
    await h.settle();
    expect(h.extractorEvaluates()).toHaveLength(0);
    expect(h.emitted).toEqual([]);
  });

  it("leaves a framework the catalog lists no extractor for detected and uninstalled, silently", async () => {
    const h = harness();
    await h.install();
    h.guest.onGuestEvent(0, {
      type: "frameworksDetected",
      detections: [{ framework: "angular", signals: [{ via: "attribute", name: "ng-version" }] }],
    });
    await h.settle();
    expect(h.extractorEvaluates()).toHaveLength(0);
    expect(h.emitted).toEqual([]);
  });

  it("reads no extractor before the page says which frameworks it uses, nor after it says none", async () => {
    const h = harness({ probeResult: [] });
    await h.install();
    expect(h.loaded).toEqual(["bootstrap"]);
    h.guest.onGuestEvent(0, READY);
    await h.settle();
    h.timers[0]!();
    await h.settle();
    // Both looks ran and settled the document as a plain page.
    expect(h.loaded.filter((id) => id === "probe")).toHaveLength(2);
    expect(h.availabilities().at(-1)).toEqual({ detection: "settled", extractors: {} });
    expect(h.extractorsLoaded()).toEqual([]);
    expect(h.extractorEvaluates()).toHaveLength(0);
  });

  it("gives a React page React's extractor and nothing else", async () => {
    const h = harness({ probeResult: REACT });
    await h.install();
    h.guest.onGuestEvent(0, READY);
    await h.settle();
    h.timers[0]!();
    await h.settle();
    expect(h.extractorsLoaded()).toEqual(["extractor:react"]);
    const evaluated = h.extractorEvaluates().map((call) => call.params.expression as string);
    expect(evaluated).toHaveLength(1);
    expect(evaluated[0]).toContain("/* react */");
    expect(evaluated[0]).not.toContain("/* svelte */");
    expect(h.availabilities().at(-1)).toEqual({
      detection: "settled",
      extractors: { react: "installed" },
    });
  });

  it("gives a mixed page each framework it uses once, and a later one only its own", async () => {
    const h = harness({
      probeResult: [...REACT, ...SVELTE],
      assets: { "extractor:solid": "/* solid */" },
    });
    await h.install();
    h.guest.onGuestEvent(0, READY);
    await h.settle();
    // The late look and a selection's markup name the same frameworks again.
    h.timers[0]!();
    h.guest.onGuestEvent(0, { type: "frameworksDetected", detections: [...SVELTE, ...REACT] });
    await h.settle();
    expect([...h.extractorsLoaded()].sort()).toEqual(["extractor:react", "extractor:svelte"]);
    expect(h.extractorEvaluates()).toHaveLength(2);

    h.guest.onGuestEvent(0, {
      type: "frameworksDetected",
      detections: [{ framework: "solid", signals: [{ via: "global", name: "Solid$$" }] }],
    });
    await h.settle();
    expect(h.extractorsLoaded().slice(2)).toEqual(["extractor:solid"]);
    expect(h.availabilities().at(-1)?.extractors).toEqual({
      react: "installed",
      svelte: "installed",
      solid: "installed",
    });
  });

  it.each([
    ["the asset cannot be read", { assets: { "extractor:svelte": new Error("EIO") } }],
    ["the extractor throws", { extractorStatus: EXTRACTOR_INSTALL_STATUS.threw }],
    ["the extractor never registers", { extractorStatus: EXTRACTOR_INSTALL_STATUS.unregistered }],
    ["the guest returns something else", { extractorStatus: { forged: true } }],
    ["the evaluate fails unexpectedly", { extractorError: new Error("Internal error") }],
  ])("reports extractor-failed once when %s", async (_label, overrides) => {
    const h = harness(overrides as Parameters<typeof harness>[0]);
    await h.install();
    h.guest.onGuestEvent(0, { type: "frameworksDetected", detections: SVELTE });
    h.guest.onGuestEvent(0, { type: "frameworksDetected", detections: SVELTE });
    await h.settle();
    expect(h.emitted).toEqual([
      expect.objectContaining({
        kind: "host-issue",
        documentEpoch: 0,
        issue: expect.objectContaining({ code: "extractor-failed", framework: "svelte" }),
      }),
    ]);
  });

  it.each([
    ["no bootstrap of this install answers the handshake", { extractorStatus: "absent" }],
    ["the guest navigated away", { extractorError: new Error("Inspected target navigated") }],
  ])("stays silent when %s", async (_label, overrides) => {
    const h = harness(overrides as Parameters<typeof harness>[0]);
    await h.install();
    h.guest.onGuestEvent(0, { type: "frameworksDetected", detections: SVELTE });
    await h.settle();
    expect(h.emitted).toEqual([]);
  });

  describe("on an Astro page", () => {
    const servedReads = (h: ReturnType<typeof harness>) =>
      h.calls.filter((call) => call.method === "Page.getResourceContent");
    const astroInstall = (h: ReturnType<typeof harness>) =>
      h.extractorEvaluates()
        .map((call) => call.params.expression as string)
        .find((expression) => expression.includes("/* astro */"));
    /** Lets queued work run up to a read that has not answered, without waiting on the queue. */
    const flush = async () => {
      for (let round = 0; round < 50; round += 1) await Promise.resolve();
    };

    it("hands Astro's extractor the markup as served, read once from the frame, and no other extractor", async () => {
      const h = harness({ probeResult: [...ASTRO, ...REACT] });
      await h.install();
      h.guest.onGuestEvent(0, READY);
      await h.settle();
      expect(servedReads(h)).toEqual([
        {
          method: "Page.getResourceContent",
          params: { frameId: "main", url: SERVED.url },
        },
      ]);
      expect(astroInstall(h)).toContain(`served: ${JSON.stringify(SERVED)}`);
      const react = h.extractorEvaluates().find((call) =>
        (call.params.expression as string).includes("/* react */")
      );
      expect(react?.params.expression).not.toContain("served:");
      expect(h.availabilities().at(-1)?.extractors).toEqual({
        astro: "installed",
        react: "installed",
      });
    });

    it("reads nothing as served for a page with no Astro on it", async () => {
      const h = harness({ probeResult: REACT });
      await h.install();
      h.guest.onGuestEvent(0, READY);
      await h.settle();
      expect(h.calls.filter((call) => call.method.startsWith("Page.get"))).toEqual([]);
    });

    it("still installs Astro's extractor, with nothing as served, when the read fails", async () => {
      const h = harness({
        probeResult: ASTRO,
        servedContent: () => Promise.reject(new Error("Content unavailable")),
      });
      await h.install();
      h.guest.onGuestEvent(0, READY);
      await h.settle();
      expect(astroInstall(h)).toContain("served: null");
      expect(h.availabilities().at(-1)?.extractors).toEqual({ astro: "installed" });
    });

    it("stops waiting on a read that never answers", async () => {
      const h = harness({ probeResult: ASTRO, servedContent: () => new Promise(() => {}) });
      await h.install();
      h.guest.onGuestEvent(0, READY);
      await flush();
      // The late probe's timer, then the read's deadline.
      expect(h.timers).toHaveLength(2);
      expect(h.extractorEvaluates()).toHaveLength(0);
      h.timers[1]!();
      await h.settle();
      expect(astroInstall(h)).toContain("served: null");
    });

    it("installs nothing when the document changes while the markup is being read", async () => {
      let answer!: (value: unknown) => void;
      const h = harness({
        probeResult: ASTRO,
        servedContent: () => new Promise((resolve) => (answer = resolve)),
      });
      await h.install();
      h.guest.onGuestEvent(0, READY);
      await flush();
      h.state.epoch = 1;
      h.guest.invalidate();
      answer({ content: SERVED.html, base64Encoded: false });
      await h.settle();
      expect(h.extractorEvaluates()).toHaveLength(0);
    });

    it("drops markup read while the main world was replaced, rather than hand it to the new one", async () => {
      let answer!: (value: unknown) => void;
      const h = harness({
        probeResult: ASTRO,
        servedContent: () => new Promise((resolve) => (answer = resolve)),
      });
      await h.install();
      h.guest.onGuestEvent(0, READY);
      await flush();
      h.main.uniqueId = "main-2";
      answer({ content: SERVED.html, base64Encoded: false });
      await h.settle();
      expect(astroInstall(h)).toContain("served: null");
    });
  });

  describe("reselect", () => {
    const request = {
      elementId: "el-3",
      framework: "svelte" as const,
      locator: { loc: { file: "src/App.svelte", line: 3, column: 2 }, index: 1 },
      reveal: true,
    };
    const reselects = (h: ReturnType<typeof harness>) =>
      h.calls.filter((call) => String(call.params.expression ?? "").includes("api.reselect("));

    it("asks its own bootstrap, in the picker's world, for the answer by value", async () => {
      const h = harness();
      await h.install();

      await expect(h.guest.reselect(request)).resolves.toBe(true);

      const [call] = reselects(h);
      expect(call?.params).toMatchObject({
        contextId: CONTEXT_ID,
        returnByValue: true,
        timeout: 1000,
      });
      expect(call?.params.uniqueContextId).toBeUndefined();
      const expression = String(call?.params.expression);
      expect(expression).toContain("api.installId !== 7");
      expect(expression).toContain(JSON.stringify(request));
    });

    it("asks nothing before an install, or of a document that is no longer current", async () => {
      const fresh = harness();
      await expect(fresh.guest.reselect(request)).resolves.toBe(false);
      expect(reselects(fresh)).toHaveLength(0);

      const h = harness();
      await h.install();
      h.state.epoch = 1;
      await expect(h.guest.reselect(request)).resolves.toBe(false);
      h.state.epoch = 0;
      h.guest.invalidate();
      await expect(h.guest.reselect(request)).resolves.toBe(false);
      expect(reselects(h)).toHaveLength(0);
    });

    it("discards a yes from a document replaced while it was asked", async () => {
      const state = { epoch: 0 as number | null };
      const h = harness({
        reselect: () => {
          state.epoch = 1;
          return { result: { value: true } };
        },
      });
      h.deps.liveEpoch = () => state.epoch;
      await h.install();
      await expect(h.guest.reselect(request)).resolves.toBe(false);
      expect(reselects(h)).toHaveLength(1);
    });

    it("answers false for anything short of the page's own yes", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        for (const reselect of [
          () => ({ result: { value: "true" } }),
          () => ({ result: { value: 1 } }),
          () => ({ result: {} }),
          () => ({ exceptionDetails: { text: "threw" }, result: { value: true } }),
          { error: new Error("Cannot find context with specified id") },
        ]) {
          const h = harness({ reselect });
          await h.install();
          await expect(h.guest.reselect(request)).resolves.toBe(false);
        }
        // A world that went with its document is expected; nothing to report.
        expect(warn).not.toHaveBeenCalled();

        const h = harness({ reselect: { error: new Error("Target crashed") } });
        await h.install();
        await expect(h.guest.reselect(request)).resolves.toBe(false);
        expect(warn).toHaveBeenCalledTimes(1);
      } finally {
        warn.mockRestore();
      }
    });
  });

  it("disposes the bootstrap it installed, by install id, and then trusts nothing", async () => {
    const h = harness();
    await h.install();
    await h.guest.disposeInGuest();
    const dispose = h.calls.at(-1)!;
    expect(dispose.params.contextId).toBe(CONTEXT_ID);
    expect(dispose.params.expression).toContain("api.installId !== 7");
    expect(h.guest.isTrustedContext(CONTEXT_ID)).toBe(false);
  });
});

const QWIK: ElementPickerProviderContribution = {
  id: "qwik",
  name: "Qwik",
  detection: [{ kind: "global", name: "qwikevents", match: "exact" }],
  guestEntry: "guest/qwik.js",
};
const QWIK_DETECTED: FrameworkDetection[] = [
  { framework: "acme.qwik.qwik", signals: [{ via: "global", name: "qwikevents" }] },
];
const deferred = () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  return { gate, release };
};

describe("CoreGuest plugin providers", () => {
  afterEach(() => unregisterElementPickerProviders("acme.qwik"));

  it("installs nothing, reads nothing and subscribes to nothing when no provider is registered", async () => {
    const loadPluginAsset = vi.fn(async () => "x");
    const h = harness({ probeResult: REACT, loadPluginAsset });
    await h.install();
    h.guest.onGuestEvent(0, READY);
    await h.settle();
    expect(loadPluginAsset).not.toHaveBeenCalled();
    expect(h.loaded).not.toContain("plugin-runtime");
    const probe = h.calls.find((c) => String(c.params.expression).includes("result: null,"));
    expect(String(probe?.params.expression)).toContain("providers: []");
  });

  it("refuses a detection naming a registered provider by a marker it never declared", async () => {
    registerElementPickerProviders("acme.qwik", "acme.qwik", [QWIK], "/plugins/acme.qwik");
    const loadPluginAsset = vi.fn(async () => "x");
    const h = harness({
      probeResult: [
        { framework: "acme.qwik.qwik", signals: [{ via: "global", name: "somethingElse" }] },
        { framework: "acme.qwik.qwik", signals: [{ via: "attribute", name: "qwikevents" }] },
      ],
      loadPluginAsset,
    });
    await h.install();
    h.guest.onGuestEvent(0, READY);
    await h.settle();
    expect(loadPluginAsset).not.toHaveBeenCalled();
    expect(h.pluginInstalls()).toHaveLength(0);
  });

  it("installs once its declared marker is seen, then removes it only when the registration goes", async () => {
    registerElementPickerProviders("acme.qwik", "acme.qwik", [QWIK], "/plugins/acme.qwik");
    const h = harness({ probeResult: QWIK_DETECTED });
    await h.install();
    h.guest.onGuestEvent(0, READY);
    await h.settle();
    expect(h.pluginInstalls()).toHaveLength(1);
    expect(h.removals()).toHaveLength(0);

    unregisterElementPickerProviders("acme.qwik");
    await h.settle();
    expect(h.removals()).toHaveLength(1);
    expect(h.availabilities().at(-1)?.extractors).toEqual({});
  });

  it("evaluates nothing, and reports nothing, for a plugin disabled while its entry was being read", async () => {
    registerElementPickerProviders("acme.qwik", "acme.qwik", [QWIK], "/plugins/acme.qwik");
    const read = deferred();
    const h = harness({
      probeResult: QWIK_DETECTED,
      loadPluginAsset: async () => {
        await read.gate;
        return "/* entry */";
      },
    });
    await h.install();
    h.guest.onGuestEvent(0, READY);
    // Not `settle`: the queue is held by the read until it is released.
    for (let round = 0; round < 20; round += 1) await Promise.resolve();
    unregisterElementPickerProviders("acme.qwik");
    read.release();
    await h.settle();

    expect(h.pluginInstalls()).toHaveLength(0);
    expect(h.emitted.filter((p) => p.kind === "host-issue")).toHaveLength(0);
    expect(h.emitted.filter((p) => p.kind === "extractor-installed")).toHaveLength(0);
  });

  it("takes out an extractor whose plugin was disabled while it was installing, and reports no failure", async () => {
    registerElementPickerProviders("acme.qwik", "acme.qwik", [QWIK], "/plugins/acme.qwik");
    const h = harness({
      probeResult: QWIK_DETECTED,
      extractorStatus: EXTRACTOR_INSTALL_STATUS.threw,
    });
    const send = h.deps.send;
    h.deps.send = async (method, params = {}) => {
      if (String(params.expression ?? "").includes('framework: "acme.qwik.qwik"')) {
        unregisterElementPickerProviders("acme.qwik");
      }
      return send(method, params);
    };
    await h.install();
    h.guest.onGuestEvent(0, READY);
    await h.settle();

    expect(h.emitted.filter((p) => p.kind === "host-issue")).toHaveLength(0);
    // Removal is idempotent in the page; what matters is that it was sent after the install.
    expect(h.removals().length).toBeGreaterThan(0);
  });

  it("looks again when a registration returns after the plugin was unloaded", async () => {
    registerElementPickerProviders("acme.qwik", "acme.qwik", [QWIK], "/plugins/acme.qwik");
    const h = harness({ probeResult: QWIK_DETECTED });
    await h.install();
    h.guest.onGuestEvent(0, READY);
    await h.settle();
    expect(h.pluginInstalls()).toHaveLength(1);

    // An asynchronous reload: the unload lands first, the new registration later.
    unregisterElementPickerProviders("acme.qwik");
    await h.settle();
    registerElementPickerProviders("acme.qwik", "acme.qwik", [QWIK], "/plugins/acme.qwik");
    await h.settle();

    expect(h.pluginInstalls()).toHaveLength(2);
  });

  it("removes a failed attempt's leftovers, so a half-installed extractor can't outlive its plugin", async () => {
    registerElementPickerProviders("acme.qwik", "acme.qwik", [QWIK], "/plugins/acme.qwik");
    const h = harness({
      probeResult: QWIK_DETECTED,
      extractorStatus: EXTRACTOR_INSTALL_STATUS.unregistered,
    });
    await h.install();
    h.guest.onGuestEvent(0, READY);
    await h.settle();
    expect(h.emitted.filter((p) => p.kind === "host-issue")).toHaveLength(1);
    expect(h.removals().length).toBeGreaterThan(0);
  });

  it("reinstalls once after reloads in a row, and not again for an unrelated plugin", async () => {
    registerElementPickerProviders("acme.qwik", "acme.qwik", [QWIK], "/plugins/acme.qwik");
    const h = harness({ probeResult: QWIK_DETECTED });
    await h.install();
    h.guest.onGuestEvent(0, READY);
    await h.settle();

    unregisterElementPickerProviders("acme.qwik");
    registerElementPickerProviders("acme.qwik", "acme.qwik", [QWIK], "/plugins/acme.qwik");
    unregisterElementPickerProviders("acme.qwik");
    registerElementPickerProviders("acme.qwik", "acme.qwik", [QWIK], "/plugins/acme.qwik");
    await h.settle();
    expect(h.pluginInstalls()).toHaveLength(2);

    const probes = () =>
      h.calls.filter((c) => String(c.params.expression).includes("const api = { result: null,"));
    const before = probes().length;
    registerElementPickerProviders("acme.marko", "acme.marko", [{ ...QWIK, id: "marko" }]);
    await h.settle();
    unregisterElementPickerProviders("acme.marko");
    await h.settle();
    expect(probes()).toHaveLength(before);
  });
});
