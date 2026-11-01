import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { build } from "esbuild";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

vi.mock("electron", () => ({ app: { getAppPath: () => "/app", isPackaged: false } }));

import {
  CORE_PICKER_GUEST_ASSETS,
  findMissingCorePickerAssets,
  guestRuntimeBuildConfig,
} from "../build-main.mjs";
// The app's own copy of the list. This script cannot import it (it runs under
// plain `node`), so the two are restated halves of one rule and this suite is
// what keeps them equal.
import {
  CORE_GUEST_ASSET_DIR,
  CORE_GUEST_ASSET_FILES,
} from "../../electron/services/elementPicker/guestAssets.ts";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const GUEST_DIR = "electron/services/elementPicker/guest";
const EXTRACTORS_DIR = `${GUEST_DIR}/extractors`;
const FRAMEWORK_PREFIX = /^(react|vue|angular|solid|svelte|preact|astro)/;

/** Picker machinery every page gets: the overlay, the registry, the detectors, the channel. */
const NEUTRAL_GUEST_MODULES = new Set([
  ...[
    "bootstrap",
    "probe",
    "picker",
    "elementContext",
    "detectors",
    "providerDetection",
    "pluginRuntime",
    "registry",
  ].map((name) => `${GUEST_DIR}/${name}.ts`),
  "electron/services/elementPicker/guestChannel.ts",
]);

/**
 * The framework a guest module reads, by where it lives: an extractor file is
 * named for its framework, and Svelte's and Preact's readers have their own
 * directories. Neutral picker code names every framework in strings, so
 * ownership is never read from content. Anything else is `undefined`, which
 * the tests refuse: a new reader has to be placed before it can ship.
 */
function frameworkOwning(file) {
  if (NEUTRAL_GUEST_MODULES.has(file)) return null;
  if (file.startsWith(`${GUEST_DIR}/svelte/`)) return "svelte";
  if (file.startsWith(`${GUEST_DIR}/preact/`)) return "preact";
  if (file === `${GUEST_DIR}/astroExtractor.ts`) return "astro";
  // Only Astro's dev toolbar takes stamps off the live page, so only its reader matches served markup.
  if (file === `${GUEST_DIR}/servedDocument.ts`) return "astro";
  if (!file.startsWith(`${EXTRACTORS_DIR}/`)) return undefined;
  return FRAMEWORK_PREFIX.exec(path.basename(file))?.[1];
}

/**
 * What a page script reaches the network or the style engine with, matched as
 * a whole word wherever it appears, so an alias, a computed property or an
 * optional call is caught along with a plain call.
 */
const NETWORK_OR_STYLE =
  /\b(fetch|XMLHttpRequest|WebSocket|EventSource|sendBeacon|importScripts|getComputedStyle)\b|\bimport\s*\(/g;

function extractorEntries() {
  return fs
    .readdirSync(path.join(repoRoot, EXTRACTORS_DIR))
    .filter((name) => name.endsWith(".ts"))
    .map((name) => `${EXTRACTORS_DIR}/${name}`)
    .filter((entry) =>
      fs.readFileSync(path.join(repoRoot, entry), "utf8").includes("installExtractor(api,")
    );
}

const guestBuilds = new Map();

/** One guest asset, built exactly as `build-main.mjs` builds it: what it bundles and what it emits. */
function guestBuild(entry) {
  let pending = guestBuilds.get(entry);
  if (pending === undefined) {
    pending = build({
      ...guestRuntimeBuildConfig({ entry, outfile: "out.js" }, { absWorkingDir: repoRoot }),
      write: false,
      metafile: true,
      logLevel: "silent",
    }).then((result) => ({
      inputs: Object.keys(result.metafile.inputs),
      text: result.outputFiles[0].text,
    }));
    guestBuilds.set(entry, pending);
  }
  return pending;
}

async function guestInputs(entry) {
  return (await guestBuild(entry)).inputs;
}

describe("CORE_PICKER_GUEST_ASSETS", () => {
  it("emits exactly the bundles the app reads back, at the paths it reads them from", () => {
    const built = Object.fromEntries(CORE_PICKER_GUEST_ASSETS.map((a) => [a.id, a.outfile]));
    const read = Object.fromEntries(
      Object.entries(CORE_GUEST_ASSET_FILES).map(([id, file]) => [
        id,
        `dist-electron/${CORE_GUEST_ASSET_DIR}/${file}`,
      ])
    );
    expect(built).toEqual(read);
  });

  it("ships every extractor there is, each bundled from the app's own code alone", async () => {
    // The bundler's graph is the evidence: an extractor reads a framework's
    // runtime from the page and imports nothing of it, and takes only types
    // from the shared contracts, so nothing it bundles comes from a package.
    // Entries are found by what they do, so one written and never listed fails
    // here rather than leaving its framework detected and never installed.
    const entries = extractorEntries();
    expect([...entries].sort()).toEqual(
      CORE_PICKER_GUEST_ASSETS.filter((asset) => asset.id.startsWith("extractor:"))
        .map((asset) => asset.entry)
        .sort()
    );
    for (const entry of entries) {
      const inputs = await guestInputs(entry);
      expect(inputs).toContain(entry);
      expect(inputs.filter((file) => file.includes("node_modules/"))).toEqual([]);
    }
  }, 60_000);

  it("keeps every framework's reader out of the bootstrap and the probe", async () => {
    // Both run on every page the picker opens on, whatever it is built with.
    for (const [id, neutral] of [
      ["bootstrap", `${GUEST_DIR}/picker.ts`],
      ["probe", `${GUEST_DIR}/detectors.ts`],
    ]) {
      const asset = CORE_PICKER_GUEST_ASSETS.find((candidate) => candidate.id === id);
      const inputs = await guestInputs(asset.entry);
      // Not a vacuous pass: the asset's own machinery is in the bundle.
      expect(inputs, id).toContain(neutral);
      expect(
        inputs.filter((file) => frameworkOwning(file) !== null),
        id
      ).toEqual([]);
    }
  }, 60_000);

  it("bundles each extractor with its own framework's reader and no other's", async () => {
    // What makes "a page gets the extractors for what it uses" true of the
    // bytes: each asset is one framework's, so loading it costs no other's.
    for (const entry of extractorEntries()) {
      const own = frameworkOwning(entry);
      expect(own, entry).toEqual(expect.any(String));
      const inputs = await guestInputs(entry);
      expect(
        inputs.filter((file) => frameworkOwning(file) === undefined),
        `${entry} bundles modules no rule places`
      ).toEqual([]);
      const owned = inputs.filter((file) => frameworkOwning(file) === own);
      // The reader itself, not only the few lines that install it.
      expect(owned.filter((file) => file !== entry).length, entry).toBeGreaterThan(0);
      expect(
        [...new Set(inputs.map(frameworkOwning).filter((owner) => owner !== null))],
        entry
      ).toEqual([own]);
    }
  }, 60_000);

  it("ships readers that never touch the network or the style engine", async () => {
    // Hover runs the readers on every element the pointer crosses, so this is
    // the hover budget for all of them at once; maps are the host's to fetch.
    // The bootstrap reads styles only into a selection's context, which
    // `guest/__tests__/picker.test.ts` holds off the hover path.
    const assets = [
      ...CORE_PICKER_GUEST_ASSETS.filter((asset) => asset.id !== "bootstrap").map((a) => a.entry),
      ...extractorEntries(),
    ];
    for (const entry of new Set(assets)) {
      expect(
        [...(await guestBuild(entry)).text.matchAll(NETWORK_OR_STYLE)].map((m) => m[0]),
        entry
      ).toEqual([]);
    }
    const bootstrap = await guestBuild(
      CORE_PICKER_GUEST_ASSETS.find((asset) => asset.id === "bootstrap").entry
    );
    const reached = [...bootstrap.text.matchAll(NETWORK_OR_STYLE)].map((m) => m[0]);
    // Not a vacuous pass: the pattern finds the bootstrap's selection-time reads.
    expect(reached).toContain("getComputedStyle");
    expect(reached.filter((found) => found !== "getComputedStyle")).toEqual([]);
    // Nor a narrow one: the spellings a minifier or an author might use.
    for (const spelling of [
      "const send = globalThis.fetch; send(url);",
      "fetch?.(url);",
      'window["fetch"](url);',
      "navigator.sendBeacon(url, body);",
      "import(url);",
    ]) {
      expect(spelling.match(NETWORK_OR_STYLE), spelling).not.toBeNull();
    }
    expect("prefetchLinks(); state.fetched = true;".match(NETWORK_OR_STYLE)).toBeNull();
  }, 60_000);

  it("builds each from a source that exists, as a guest IIFE", () => {
    for (const asset of CORE_PICKER_GUEST_ASSETS) {
      expect(fs.existsSync(path.join(repoRoot, asset.entry))).toBe(true);
      expect(guestRuntimeBuildConfig(asset)).toMatchObject({
        entryPoints: [asset.entry],
        outfile: asset.outfile,
        format: "iife",
        platform: "browser",
      });
    }
  });
});

describe("findMissingCorePickerAssets", () => {
  let dist;

  beforeEach(() => {
    dist = fs.mkdtempSync(path.join(os.tmpdir(), "core-picker-assets-"));
  });

  afterEach(() => {
    fs.rmSync(dist, { recursive: true, force: true });
  });

  it("reports each bundle the output lacks, and nothing once all are there", () => {
    expect(findMissingCorePickerAssets(dist)).toHaveLength(CORE_PICKER_GUEST_ASSETS.length);
    for (const asset of CORE_PICKER_GUEST_ASSETS) {
      const file = path.join(dist, asset.outfile.replace("dist-electron/", ""));
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, "//");
    }
    expect(findMissingCorePickerAssets(dist)).toEqual([]);
  });
});
