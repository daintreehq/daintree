import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  getElementPickerProvider,
  registerElementPickerProviders,
  unregisterElementPickerProviders,
} from "../../elementPickerProviderRegistry.js";
import { loadPluginGuestAsset, MAX_PLUGIN_GUEST_ASSET_BYTES } from "../pluginGuestAssets.js";

const PLUGIN_ID = "acme.qwik";

const dirs: string[] = [];

function plugin(
  entry: string,
  files: Record<string, string | Buffer> = {},
  link?: [string, string]
) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "daintree-guest-assets-"));
  dirs.push(dir);
  for (const [name, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    fs.writeFileSync(path.join(dir, name), content);
  }
  if (link) fs.symlinkSync(link[1], path.join(dir, link[0]));
  registerElementPickerProviders(
    PLUGIN_ID,
    "acme.qwik",
    [
      {
        id: "qwik",
        name: "Qwik",
        detection: [{ kind: "global", name: "qwikevents", match: "exact" }],
        guestEntry: entry,
      },
    ],
    dir
  );
  return getElementPickerProvider("acme.qwik.qwik", null)!;
}

afterEach(() => {
  unregisterElementPickerProviders(PLUGIN_ID);
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("loadPluginGuestAsset", () => {
  it("reads the declared entry from the owning plugin", async () => {
    const provider = plugin("./guest/qwik.js", {
      "guest/qwik.js": "var __daintreeExtractor = {};",
    });
    await expect(loadPluginGuestAsset(provider)).resolves.toBe("var __daintreeExtractor = {};");
  });

  it("refuses a provider that is no longer registered", async () => {
    const provider = plugin("guest/qwik.js", { "guest/qwik.js": "x" });
    unregisterElementPickerProviders(PLUGIN_ID);
    await expect(loadPluginGuestAsset(provider)).rejects.toThrow(/no longer registered/);
  });

  it("refuses a provider registered without an installed directory", async () => {
    registerElementPickerProviders(PLUGIN_ID, "acme.qwik", [
      {
        id: "qwik",
        name: "Qwik",
        detection: [{ kind: "global", name: "qwikevents", match: "exact" }],
        guestEntry: "guest/qwik.js",
      },
    ]);
    const provider = getElementPickerProvider("acme.qwik.qwik", null)!;
    await expect(loadPluginGuestAsset(provider)).rejects.toThrow(/no installed plugin/);
  });

  it("refuses a missing file", async () => {
    await expect(loadPluginGuestAsset(plugin("guest/qwik.js"))).rejects.toThrow(/missing/);
  });

  it("refuses a symlink that leaves the plugin directory", async () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "daintree-outside-"));
    dirs.push(outside);
    fs.writeFileSync(path.join(outside, "qwik.js"), "stolen");
    const provider = plugin("guest/qwik.js", {}, ["guest", outside]);
    await expect(loadPluginGuestAsset(provider)).rejects.toThrow(/outside its plugin/);
  });

  it("refuses a directory, an empty file and one over the ceiling", async () => {
    await expect(loadPluginGuestAsset(plugin("guest", { "guest/nested.js": "x" }))).rejects.toThrow(
      /not a file/
    );
    await expect(loadPluginGuestAsset(plugin("a.js", { "a.js": "" }))).rejects.toThrow(/empty/);
    await expect(
      loadPluginGuestAsset(
        plugin("big.js", { "big.js": Buffer.alloc(MAX_PLUGIN_GUEST_ASSET_BYTES + 1, "a") })
      )
    ).rejects.toThrow(/exceeds its ceiling/);
  });
});
