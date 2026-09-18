import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  guestAdapterAssetPath,
  isSafeGuestEntryPath,
  listBuiltinGuestAdapters,
} from "../guestAdapterAssets.js";

let workDir: string;

beforeEach(() => {
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), "guest-adapter-assets-"));
});

afterEach(() => {
  fs.rmSync(workDir, { recursive: true, force: true });
  vi.resetModules();
  vi.doUnmock("electron");
});

function writeManifest(dirName: string, manifest: unknown): string {
  const dir = path.join(workDir, dirName);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "plugin.json"),
    typeof manifest === "string" ? manifest : JSON.stringify(manifest)
  );
  return dir;
}

function manifest(name: string, guestAdapters: unknown) {
  return { name, contributes: { guestAdapters } };
}

describe("guestAdapterAssetPath", () => {
  it("derives one file per adapter from the id's suffix", () => {
    expect(
      guestAdapterAssetPath("daintree.sveltekit-builder", "daintree.sveltekit-builder.guest")
    ).toBe("guest/guest.js");
    expect(guestAdapterAssetPath("acme.tools", "acme.tools.svelte-source")).toBe(
      "guest/svelte-source.js"
    );
  });

  it("refuses a multi-segment suffix rather than flattening it to a collision", () => {
    // Mapping dots to dashes would give `a.b` and `a-b` the same asset, so the
    // build would emit one bundle over the other and one adapter would serve the
    // wrong body. The manifest schema refuses these outright; this is the second
    // gate for a manifest read off disk.
    expect(guestAdapterAssetPath("acme.tools", "acme.tools.a.b")).toBeNull();
    expect(guestAdapterAssetPath("acme.tools", "acme.tools.a-b")).toBe("guest/a-b.js");
  });

  it("refuses an id that is not the plugin name plus exactly one segment", () => {
    expect(guestAdapterAssetPath("acme.tools", "other.plugin.guest")).toBeNull();
    // No segment left to name a file with.
    expect(guestAdapterAssetPath("acme.tools", "acme.tools")).toBeNull();
    expect(guestAdapterAssetPath("acme.tools", "acme.tools.")).toBeNull();
    // A plugin whose name is a prefix of this one's must not claim its assets.
    expect(guestAdapterAssetPath("acme.tool", "acme.tools.guest")).toBeNull();
    // Traversal through the derived filename.
    expect(guestAdapterAssetPath("acme.tools", "acme.tools.../../evil")).toBeNull();
    expect(guestAdapterAssetPath("acme.tools", "acme.tools.a/b")).toBeNull();
  });
});

describe("isSafeGuestEntryPath", () => {
  it("accepts a plugin-relative source path", () => {
    expect(isSafeGuestEntryPath("renderer/guest/entry.ts")).toBe(true);
    expect(isSafeGuestEntryPath("guest.tsx")).toBe(true);
  });

  it("refuses traversal, absolute, Windows and non-source paths", () => {
    expect(isSafeGuestEntryPath("../sibling/renderer/guest/entry.ts")).toBe(false);
    expect(isSafeGuestEntryPath("renderer/../../evil.ts")).toBe(false);
    expect(isSafeGuestEntryPath("/etc/passwd.ts")).toBe(false);
    expect(isSafeGuestEntryPath("renderer\\guest\\entry.ts")).toBe(false);
    expect(isSafeGuestEntryPath("renderer/guest/entry.ts\0.png")).toBe(false);
    expect(isSafeGuestEntryPath("renderer/guest/entry.json")).toBe(false);
    expect(isSafeGuestEntryPath("renderer//entry.ts")).toBe(false);
    // The bundler's own output directory: a source file there would be copied
    // over the compiled asset the host reads back.
    expect(isSafeGuestEntryPath("guest/entry.ts")).toBe(false);
    expect(isSafeGuestEntryPath("guest/nested/entry.ts")).toBe(false);
    // `path.isAbsolute` calls these relative on POSIX; Windows does not.
    expect(isSafeGuestEntryPath("C:/renderer/entry.ts")).toBe(false);
    expect(isSafeGuestEntryPath("renderer/a:b.ts")).toBe(false);
    // Only as the FIRST segment — a nested `guest/` is the plugin's own business.
    expect(isSafeGuestEntryPath("renderer/guest/entry.ts")).toBe(true);
  });
});

describe("listBuiltinGuestAdapters", () => {
  it("returns one declaration per manifest entry with its derived asset path", () => {
    writeManifest("alpha", manifest("acme.alpha", [{ id: "acme.alpha.guest", entry: "g/e.ts" }]));
    writeManifest(
      "beta",
      manifest("acme.beta", [{ id: "acme.beta.probe", entry: "renderer/p.ts" }])
    );

    expect(listBuiltinGuestAdapters(workDir)).toEqual([
      {
        pluginId: "acme.alpha",
        dirName: "alpha",
        adapterId: "acme.alpha.guest",
        entry: "g/e.ts",
        assetPath: "guest/guest.js",
      },
      {
        pluginId: "acme.beta",
        dirName: "beta",
        adapterId: "acme.beta.probe",
        entry: "renderer/p.ts",
        assetPath: "guest/probe.js",
      },
    ]);
  });

  it("skips a plugin that declares none, and a missing root", () => {
    writeManifest("plain", { name: "acme.plain", contributes: { commands: [] } });
    expect(listBuiltinGuestAdapters(workDir)).toEqual([]);
    expect(listBuiltinGuestAdapters(path.join(workDir, "nope"))).toEqual([]);
  });

  it("skips an unreadable or non-object manifest instead of throwing", () => {
    writeManifest("bad", "{ not json");
    // `JSON.parse` succeeds on both of these; dereferencing them would throw a
    // TypeError out of the function and take handler registration down with it.
    writeManifest("null-manifest", "null");
    writeManifest("scalar-manifest", "42");
    writeManifest("good", manifest("acme.good", [{ id: "acme.good.guest", entry: "g.ts" }]));
    expect(listBuiltinGuestAdapters(workDir).map((d) => d.pluginId)).toEqual(["acme.good"]);
  });

  it("drops an entry whose entry path or id would escape the plugin directory", () => {
    writeManifest(
      "hostile",
      manifest("acme.hostile", [
        { id: "acme.hostile.a", entry: "../other/renderer/guest/entry.ts" },
        { id: "other.plugin.b", entry: "renderer/b.ts" },
        { id: "acme.hostile.c", entry: 42 },
        { id: "acme.hostile.ok", entry: "renderer/ok.ts" },
      ])
    );
    expect(listBuiltinGuestAdapters(workDir).map((d) => d.adapterId)).toEqual(["acme.hostile.ok"]);
  });
});

describe("registerBuiltinGuestAdapters", () => {
  async function load(appPath: string, isPackaged = false) {
    vi.doMock("electron", () => ({ app: { getAppPath: () => appPath, isPackaged } }));
    vi.resetModules();
    const adapters = await import("../guestAdapters.js");
    adapters.__resetGuestAdaptersForTests();
    const mod = await import("../builtinGuestAdapters.js");
    return { ...mod, ...adapters };
  }

  /** Lays out the tree `app.getAppPath()` resolves to, and returns that app path. */
  function distTree(
    entries: { dirName: string; name: string; adapterId: string; body?: string }[]
  ) {
    const appPath = path.join(workDir, "app");
    const builtin = path.join(appPath, "dist-electron", "plugins", "builtin");
    for (const entry of entries) {
      const dir = path.join(builtin, entry.dirName);
      fs.mkdirSync(path.join(dir, "guest"), { recursive: true });
      fs.writeFileSync(
        path.join(dir, "plugin.json"),
        JSON.stringify(
          manifest(entry.name, [{ id: entry.adapterId, entry: "renderer/guest/entry.ts" }])
        )
      );
      const assetPath = guestAdapterAssetPath(entry.name, entry.adapterId);
      fs.writeFileSync(path.join(dir, assetPath!), entry.body ?? "/* body */");
    }
    return appPath;
  }

  it("registers an adapter for every built-in manifest that declares one", async () => {
    const appPath = distTree([
      { dirName: "alpha", name: "acme.alpha", adapterId: "acme.alpha.guest", body: "ALPHA" },
      { dirName: "beta", name: "acme.beta", adapterId: "acme.beta.probe", body: "BETA" },
    ]);
    const mod = await load(appPath);

    const dispose = mod.registerBuiltinGuestAdapters();

    expect(mod.resolveGuestAdapter("acme.alpha.guest")?.pluginId).toBe("acme.alpha");
    expect(await mod.loadGuestAdapterSource("acme.alpha.guest")).toBe("ALPHA");
    expect(await mod.loadGuestAdapterSource("acme.beta.probe")).toBe("BETA");

    // One disposer covers them all, so a handler teardown leaves none behind.
    dispose();
    expect(mod.resolveGuestAdapter("acme.alpha.guest")).toBeNull();
    expect(mod.resolveGuestAdapter("acme.beta.probe")).toBeNull();
  });

  it("caches a body only when packaged, so the dev watcher's rewrite is picked up", async () => {
    const appPath = distTree([
      { dirName: "alpha", name: "acme.alpha", adapterId: "acme.alpha.guest" },
    ]);
    const dev = await load(appPath, false);
    expect(
      dev.registerBuiltinGuestAdapters() && dev.resolveGuestAdapter("acme.alpha.guest")?.cache
    ).toBe(false);

    const packaged = await load(appPath, true);
    packaged.registerBuiltinGuestAdapters();
    expect(packaged.resolveGuestAdapter("acme.alpha.guest")?.cache).toBe(true);
  });

  it("registers nothing when the Electron app API is unavailable", async () => {
    vi.doMock("electron", () => ({ app: {} }));
    vi.resetModules();
    const mod = await import("../builtinGuestAdapters.js");
    expect(mod.resolveBuiltinPluginsDir()).toBeNull();
    expect(() => mod.registerBuiltinGuestAdapters()()).not.toThrow();
  });

  it("resolves the same built-in plugins directory PluginService scans", async () => {
    const mod = await load("/app");
    expect(mod.resolveBuiltinPluginsDir()).toBe(
      path.join("/app", "dist-electron", "plugins", "builtin")
    );
    // The two resolutions are separate on purpose (this module stays off the
    // zod-heavy manifest-schema graph), so pin that PluginService still joins
    // the same segments under `app.getAppPath()`.
    const pluginService = fs.readFileSync(
      path.resolve(import.meta.dirname, "../../PluginService.ts"),
      "utf8"
    );
    expect(pluginService).toContain(
      'path.join(app.getAppPath(), "dist-electron", "plugins", "builtin")'
    );
  });
});
