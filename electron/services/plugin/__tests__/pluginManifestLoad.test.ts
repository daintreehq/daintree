import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { readPluginManifestForLoad } from "../pluginManifestLoad.js";

describe("readPluginManifestForLoad", () => {
  let root: string;

  async function writeManifest(dirName: string, manifest: unknown): Promise<string> {
    const dir = path.join(root, dirName);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "plugin.json"), JSON.stringify(manifest));
    return dir;
  }

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "dt-manifest-load-"));
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(root, { recursive: true, force: true });
  });

  it("returns the parsed manifest", async () => {
    const dir = await writeManifest("acme.ok", { name: "acme.ok", version: "1.0.0" });
    const result = await readPluginManifestForLoad(dir, "acme.ok", {
      isBuiltin: false,
      origin: "user",
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.manifest.name).toBe("acme.ok");
  });

  it("refuses a missing or unparseable manifest with no refusal to surface", async () => {
    const missing = path.join(root, "absent");
    expect(
      await readPluginManifestForLoad(missing, "absent", { isBuiltin: false, origin: "user" })
    ).toEqual({ ok: false });

    const dir = path.join(root, "acme.bad");
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "plugin.json"), "{ not json");
    expect(
      await readPluginManifestForLoad(dir, "acme.bad", { isBuiltin: false, origin: "user" })
    ).toEqual({ ok: false });
  });

  it("hands back a reserved-namespace refusal for the caller to toast and record", async () => {
    const dir = await writeManifest("daintree.sneaky", {
      name: "daintree.sneaky",
      version: "1.0.0",
    });
    const result = await readPluginManifestForLoad(dir, "daintree.sneaky", {
      isBuiltin: false,
      origin: "user",
    });
    expect(result).toMatchObject({
      ok: false,
      refusal: { reason: "reserved-namespace", pluginName: "daintree.sneaky" },
    });
  });

  it("loads a project manifest only under the instance key it was discovered as", async () => {
    const dir = await writeManifest("acme.dash", {
      name: "acme.dash",
      version: "1.0.0",
      scope: "project",
    });
    const load = (instanceKey: string) =>
      readPluginManifestForLoad(dir, "acme.dash", {
        isBuiltin: false,
        origin: "project",
        instanceKey,
      });

    const matching = await load("project__p1__acme.dash");
    expect(matching.ok).toBe(true);
    expect(await load("project__p1__acme.other")).toEqual({ ok: false });
  });
});
