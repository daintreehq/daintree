import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
