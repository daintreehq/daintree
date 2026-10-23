// @vitest-environment jsdom
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  webContents: { getAllWebContents: () => [], fromId: () => null },
  app: { getAppPath: () => "/nonexistent", isPackaged: false },
}));

import { __resetCdpLeasesForTests } from "../../cdp/WebContentsCdpService.js";
import {
  registerElementPickerProviders,
  unregisterElementPickerProviders,
} from "../../elementPickerProviderRegistry.js";
import { LATE_PROBE_DELAY_MS } from "../coreGuest.js";
import { BOOTSTRAP_GLOBAL, EXTRACTOR_REGISTRY_GLOBAL } from "../guestChannel.js";
import { buildCoreGuestAssets } from "./buildCoreGuestAssets.js";
import { buildFixtureGuestEntry } from "./buildFixtureGuestEntry.js";
import {
  BINDING_NAME,
  makeHarness,
  scope,
  settle as settleMicrotasks,
} from "./fixtures/fakeCdp.js";
// Loaded up front: the host imports it on the first plugin install, and a module
// load needs more real time than the microtask rounds `settle` gives.
import "../pluginGuestAssets.js";
import { mountLitPage } from "./fixtures/pages.js";

/**
 * Plugin providers through the real bridge: the fixture plugin under
 * `fixtures/plugins/lit-picker` is a framework outside the built-in enum,
 * packaged the way an installed plugin is (a manifest and a built guest entry
 * in its own directory) and loaded through the real host loader.
 */

const FIXTURE = "electron/services/elementPicker/__tests__/fixtures/plugins/lit-picker";
const PROVIDER_ID = "fixture.lit-picker.lit";
const PLUGIN_ID = "fixture.lit-picker";

let shipped: Record<string, string> = {};
let guestEntry = "";
let installed = "";

beforeAll(() => {
  shipped = buildCoreGuestAssets();
  guestEntry = buildFixtureGuestEntry(`${FIXTURE}/src/lit.ts`);
}, 60_000);

function manifest(): { contributes: { elementPickerProviders: never[] } } {
  const file = path.resolve(__dirname, "../../../..", FIXTURE, "plugin.json");
  return JSON.parse(fs.readFileSync(file, "utf8")) as ReturnType<typeof manifest>;
}

/** An installed copy of the fixture: its manifest and the entry as built. */
function install(entry: string | null = guestEntry): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "daintree-lit-picker-"));
  fs.cpSync(
    path.resolve(__dirname, "../../../..", FIXTURE, "plugin.json"),
    path.join(dir, "plugin.json")
  );
  if (entry !== null) {
    fs.mkdirSync(path.join(dir, "dist/picker"), { recursive: true });
    fs.writeFileSync(path.join(dir, "dist/picker/lit.js"), entry);
  }
  return dir;
}

function register(dir: string): void {
  registerElementPickerProviders(
    PLUGIN_ID,
    PLUGIN_ID,
    manifest().contributes.elementPickerProviders,
    dir
  );
}

function litDetection(): () => void {
  const scopeRecord = globalThis as unknown as Record<string, unknown>;
  scopeRecord.litElementVersions = ["4.2.0"];
  return () => {
    delete scopeRecord.litElementVersions;
  };
}

function registry(): { has(id: string): boolean } | undefined {
  return scope[EXTRACTOR_REGISTRY_GLOBAL] as { has(id: string): boolean } | undefined;
}

const cleanups: Array<() => void> = [];

/** Reading a plugin's entry is real file I/O, which fake timers and microtask rounds don't wait for. */
async function settle(): Promise<void> {
  for (let round = 0; round < 40; round += 1) {
    await settleMicrotasks();
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

beforeEach(() => {
  __resetCdpLeasesForTests();
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  document.body.innerHTML = "";
  (globalThis as { __litPickerWorkerStarted?: boolean }).__litPickerWorkerStarted = undefined;
});

afterEach(() => {
  vi.useRealTimers();
  unregisterElementPickerProviders(PLUGIN_ID);
  for (const cleanup of cleanups.splice(0)) cleanup();
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

function pluginInstalls(h: ReturnType<typeof makeHarness>) {
  return h.wc.debugger
    .evaluates()
    .filter((entry) => entry.kind === "extractor" && entry.framework === PROVIDER_ID);
}

describe("plugin framework extractors", () => {
  it("reads nothing and installs nothing on a page whose markers match no provider", async () => {
    register(install());
    document.body.innerHTML = "<main><h1>Plain</h1></main>";
    const h = makeHarness(shipped);
    await h.bind();
    await settle();
    await vi.advanceTimersByTimeAsync(LATE_PROBE_DELAY_MS);
    await settle();

    expect(pluginInstalls(h)).toHaveLength(0);
    expect(registry()).toBeUndefined();
    expect(h.kinds("extractor-installed")).toHaveLength(0);
  });

  it("hands a vanilla install's probe no providers", async () => {
    document.body.innerHTML = "<main></main>";
    const h = makeHarness(shipped);
    await h.bind();
    await settle();
    const probes = h.wc.debugger.commands.filter(
      (command) =>
        command.method === "Runtime.evaluate" &&
        String(command.params.expression).includes("const api = { result: null,")
    );
    expect(probes.length).toBeGreaterThan(0);
    for (const probe of probes) {
      expect(String(probe.params.expression)).toContain("providers: []");
    }
  });

  it("installs the plugin's extractor once its detector matches, without starting its worker", async () => {
    register(install());
    cleanups.push(litDetection());
    const page = mountLitPage();
    cleanups.push(page.cleanup);
    const h = makeHarness(shipped);
    await h.bind();
    await settle();
    expect(pluginInstalls(h)).toHaveLength(1);
    expect(h.kinds("extractor-installed")).toEqual([
      expect.objectContaining({ framework: PROVIDER_ID, documentEpoch: 0 }),
    ]);
    expect(registry()?.has(PROVIDER_ID)).toBe(true);
    expect((globalThis as { __litPickerWorkerStarted?: boolean }).__litPickerWorkerStarted).toBe(
      undefined
    );

    // Again at the late probe: still one install.
    await vi.advanceTimersByTimeAsync(LATE_PROBE_DELAY_MS);
    await settle();
    expect(pluginInstalls(h)).toHaveLength(1);
  });

  it("answers a selection with the plugin's evidence", async () => {
    register(install());
    const page = mountLitPage();
    cleanups.push(page.cleanup);
    const h = makeHarness(shipped);
    await h.bind();
    await settle();

    (page.target as HTMLElement).click();
    await settle();
    const event = h.pickerEvents("selectionChanged").at(-1)?.event as
      { observations: Array<{ frameworkEvidence: unknown[] }> } | undefined;
    expect(event?.observations[0]?.frameworkEvidence).toEqual([
      expect.objectContaining({ kind: "generic", framework: PROVIDER_ID }),
    ]);
  });

  it("lets a core extractor and a plugin extractor share a mixed page", async () => {
    register(install());
    document.body.innerHTML =
      '<div id="app" data-v-app=""><fixture-lit-card></fixture-lit-card></div>';
    const h = makeHarness(shipped);
    await h.bind();
    await settle();

    expect(registry()?.has("vue")).toBe(true);
    expect(registry()?.has(PROVIDER_ID)).toBe(true);
    expect(
      h
        .kinds("extractor-installed")
        .map((payload) => payload.framework)
        .sort()
    ).toEqual(["vue", PROVIDER_ID].sort());
  });

  it("leaves DOM picking working when the entry is missing", async () => {
    register(install(null));
    const page = mountLitPage();
    cleanups.push(page.cleanup);
    const h = makeHarness(shipped);
    await h.bind();
    await settle();

    expect(h.kinds("extractor-installed")).toHaveLength(0);
    const issues = h.kinds("host-issue");
    expect(issues).toEqual([
      expect.objectContaining({
        issue: expect.objectContaining({ code: "extractor-failed", framework: PROVIDER_ID }),
      }),
    ]);
    (page.target as HTMLElement).click();
    await settle();
    expect(h.pickerEvents("selectionChanged")).toHaveLength(1);
  });

  it("reports an entry that throws while installing and keeps the other extractors", async () => {
    register(install('var __daintreeExtractor = { default() { throw new Error("boom"); } };'));
    document.body.innerHTML =
      '<div id="app" data-v-app=""><fixture-lit-card></fixture-lit-card></div>';
    const h = makeHarness(shipped);
    await h.bind();
    await settle();

    expect(registry()?.has("vue")).toBe(true);
    expect(registry()?.has(PROVIDER_ID)).toBe(false);
    expect(h.kinds("host-issue")).toEqual([
      expect.objectContaining({
        issue: expect.objectContaining({ code: "extractor-failed", framework: PROVIDER_ID }),
      }),
    ]);
  });

  it("refuses an entry that escapes its plugin directory through a symlink", async () => {
    const dir = install(null);
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "daintree-outside-"));
    fs.writeFileSync(path.join(outside, "lit.js"), guestEntry);
    fs.mkdirSync(path.join(dir, "dist"), { recursive: true });
    fs.symlinkSync(outside, path.join(dir, "dist/picker"));
    register(dir);
    const page = mountLitPage();
    cleanups.push(page.cleanup);
    const h = makeHarness(shipped);
    await h.bind();
    await settle();

    expect(registry()?.has(PROVIDER_ID) ?? false).toBe(false);
    expect(h.kinds("extractor-installed")).toHaveLength(0);
  });

  it("disposes the extractor when the plugin is disabled, leaving the rest", async () => {
    register(install());
    document.body.innerHTML =
      '<div id="app" data-v-app=""><fixture-lit-card></fixture-lit-card></div>';
    const h = makeHarness(shipped);
    await h.bind();
    await settle();
    expect(registry()?.has(PROVIDER_ID)).toBe(true);

    unregisterElementPickerProviders(PLUGIN_ID);
    await settle();

    expect(registry()?.has(PROVIDER_ID)).toBe(false);
    expect(registry()?.has("vue")).toBe(true);
  });

  it("installs again in the document a navigation brings, and not before its detector matches", async () => {
    register(install());
    cleanups.push(litDetection());
    const page = mountLitPage();
    cleanups.push(page.cleanup);
    const h = makeHarness(shipped);
    await h.bind();
    await settle();
    expect(pluginInstalls(h)).toHaveLength(1);

    // The new document has no marker: nothing of the old install carries over.
    document.body.innerHTML = "<main>Plain</main>";
    page.cleanup();
    delete (globalThis as Record<string, unknown>).litElementVersions;
    h.navigate();
    await settle();
    await vi.advanceTimersByTimeAsync(LATE_PROBE_DELAY_MS);
    await settle();
    expect(pluginInstalls(h)).toHaveLength(1);
    expect(h.kinds("extractor-installed").filter((p) => p.documentEpoch > 0)).toHaveLength(0);

    // A later document that matches installs, once.
    cleanups.push(litDetection());
    h.navigate();
    await settle();
    expect(pluginInstalls(h)).toHaveLength(2);
    expect(h.kinds("extractor-installed").at(-1)).toMatchObject({ framework: PROVIDER_ID });
  });
});
