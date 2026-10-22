import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({ app: { getAppPath: () => "/app", isPackaged: false } }));

import type { FrameworkDetection } from "../../../../shared/elementPicker/observation.js";
import { CoreGuest, type CoreGuestDeps } from "../coreGuest.js";
import type { CoreGuestAssetId } from "../guestAssets.js";
import { EXTRACTOR_INSTALL_STATUS } from "../guestChannel.js";
import type { PickerAvailability } from "../guest/types.js";
import type { ElementPickerPushPayload } from "../types.js";

const CONTEXT_ID = 5;
const SVELTE: FrameworkDetection[] = [
  { framework: "svelte", signals: [{ via: "expando", name: "__svelte_meta" }] },
];
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
  } = {}
) {
  const calls: Call[] = [];
  const emitted: ElementPickerPushPayload[] = [];
  const state = { epoch: 0 as number | null };
  const main = { uniqueId: "main-1" as string | null, generation: 3 };
  let queue: Promise<void> = Promise.resolve();
  const timers: Array<() => void> = [];
  const assets: Partial<Record<CoreGuestAssetId, string | Error>> = {
    bootstrap: "/* bootstrap */",
    probe: "/* probe */",
    "extractor:svelte": "/* svelte */",
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
      if (method !== "Runtime.evaluate") return {};
      const expression = params.expression as string;
      if (params.contextId === CONTEXT_ID && overrides.worldGone) {
        throw new Error("Cannot find context with specified id");
      }
      if (expression.includes("const api = { result: null }")) {
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
      if (id.startsWith("extractor:") && overrides.assetGate) await overrides.assetGate;
      const asset = assets[id];
      if (asset instanceof Error) throw asset;
      return asset ?? null;
    },
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
  return {
    guest,
    deps,
    calls,
    emitted,
    state,
    main,
    timers,
    install,
    settle,
    extractorEvaluates,
    availabilities,
  };
}

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
        String(call.params.expression).includes("const api = { result: null }")
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
    ["the build ships no reader for it", { framework: "angular" }, "unavailable"],
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

  it("leaves a framework the build ships no extractor for detected and uninstalled, silently", async () => {
    const h = harness();
    await h.install();
    h.guest.onGuestEvent(0, {
      type: "frameworksDetected",
      detections: [{ framework: "vue", signals: [{ via: "attribute", name: "data-v-app" }] }],
    });
    await h.settle();
    expect(h.extractorEvaluates()).toHaveLength(0);
    expect(h.emitted).toEqual([]);
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
