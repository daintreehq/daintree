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

/**
 * The framework a guest module reads, by where it lives: an extractor file is
 * named for its framework, and Svelte's and Preact's readers have their own
 * directories. Neutral picker code — the registry, the detectors, the overlay —
 * names every framework in strings, so ownership is never read from content.
 */
function frameworkOwning(file) {
  if (file.startsWith(`${GUEST_DIR}/svelte/`)) return "svelte";
  if (file.startsWith(`${GUEST_DIR}/preact/`)) return "preact";
  if (file === `${GUEST_DIR}/astroExtractor.ts`) return "astro";
  if (!file.startsWith(`${EXTRACTORS_DIR}/`)) return null;
  return FRAMEWORK_PREFIX.exec(path.basename(file))?.[1] ?? null;
}

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

/** Everything one guest asset bundles, built exactly as `build-main.mjs` builds it. */
function guestInputs(entry) {
  let pending = guestBuilds.get(entry);
  if (pending === undefined) {
    pending = build({
      ...guestRuntimeBuildConfig({ entry, outfile: "out.js" }, { absWorkingDir: repoRoot }),
      write: false,
      metafile: true,
      logLevel: "silent",
    }).then((result) => Object.keys(result.metafile.inputs));
    guestBuilds.set(entry, pending);
  }
  return pending;
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
      expect(own, entry).not.toBeNull();
      const owners = new Set(
        (await guestInputs(entry)).map(frameworkOwning).filter((owner) => owner !== null)
      );
      expect([...owners], entry).toEqual([own]);
    }
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
