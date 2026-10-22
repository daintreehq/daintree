import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({ app: { getAppPath: () => "/app", isPackaged: false } }));

import type { FrameworkDetection } from "../../../../shared/elementPicker/observation.js";
import { CoreGuest, type CoreGuestDeps } from "../coreGuest.js";
import type { CoreGuestAssetId } from "../guestAssets.js";
import { EXTRACTOR_INSTALL_STATUS } from "../guestChannel.js";
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
    extractorStatus?: unknown;
    extractorError?: Error;
    assets?: Partial<Record<CoreGuestAssetId, string | Error>>;
    assetGate?: Promise<void>;
    noWorld?: true;
  } = {}
) {
  const calls: Call[] = [];
  const emitted: ElementPickerPushPayload[] = [];
  const state = { epoch: 0 as number | null };
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
      if (expression.includes("const api = { result: null }")) {
        return { result: { value: overrides.probeResult ?? null } };
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
  return { guest, deps, calls, emitted, state, timers, install, settle, extractorEvaluates };
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
      detections: [{ framework: "angular", signals: [{ via: "attribute", name: "ng-version" }] }],
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
