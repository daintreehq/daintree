// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { LoadedPluginInfo, PluginManifest } from "../../../../../shared/types/plugin.js";
import { buildPluginInventory, detectNativeModulePlatforms } from "../inventory.js";

let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "parity-inventory-"));
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

function info(
  instanceId: string,
  patch: Partial<LoadedPluginInfo> = {},
  manifest: Partial<PluginManifest> & Record<string, unknown> = {}
): LoadedPluginInfo {
  return {
    instanceId,
    origin: "global",
    projectId: null,
    isBuiltin: false,
    dir,
    blocklisted: false,
    manifest: {
      name: instanceId,
      version: "1.0.0",
      contributes: { settings: [] },
      ...manifest,
    },
    ...patch,
  } as unknown as LoadedPluginInfo;
}

const ELF = Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0]);
const MACHO = Buffer.from([0xcf, 0xfa, 0xed, 0xfe, 7, 0, 0, 1]);

describe("detectNativeModulePlatforms", () => {
  it("is null for a plugin with no native modules", async () => {
    await fs.writeFile(path.join(dir, "index.js"), "export {}");
    expect(await detectNativeModulePlatforms(dir)).toBeNull();
  });

  it("reads each native module's OS from its binary header", async () => {
    await fs.mkdir(path.join(dir, "build", "Release"), { recursive: true });
    await fs.writeFile(path.join(dir, "build", "Release", "graph.node"), MACHO);
    expect(await detectNativeModulePlatforms(dir)).toEqual(["darwin"]);
    await fs.writeFile(path.join(dir, "graph-linux.node"), ELF);
    expect(await detectNativeModulePlatforms(dir)).toEqual(["darwin", "linux"]);
  });
});

describe("buildPluginInventory", () => {
  const options = { appVersion: "0.38.0", platform: "linux", detectPlatforms: async () => null };

  it("lists installed plugins, never built-ins or a project's own plugins", async () => {
    const inventory = await buildPluginInventory(
      {
        listPlugins: () => [
          info("acme.md", {}, { displayName: "Markdown Preview", engines: { daintree: ">=0.1" } }),
          info("daintree.github", { isBuiltin: true }),
          info("project:p1/acme.local", { origin: "project", projectId: "p1" }),
        ],
        getSettingValuesForUi: vi.fn(),
      },
      options
    );
    expect(inventory).toEqual({
      appVersion: "0.38.0",
      platform: "linux",
      plugins: [
        {
          pluginId: "acme.md",
          displayName: "Markdown Preview",
          version: "1.0.0",
          engine: ">=0.1",
          platforms: null,
          remoteUnsupported: false,
          blocklisted: false,
          missingSecrets: [],
        },
      ],
    });
  });

  it("prefers declared platforms over what the binaries say", async () => {
    const detect = vi.fn(async () => ["darwin" as const]);
    const inventory = await buildPluginInventory(
      {
        listPlugins: () => [info("acme.a", {}, { platforms: ["linux"] }), info("acme.b")],
        getSettingValuesForUi: vi.fn(),
      },
      { ...options, detectPlatforms: detect }
    );
    expect(inventory.plugins.map((p) => p.platforms)).toEqual([["linux"], ["darwin"]]);
    expect(detect).toHaveBeenCalledTimes(1);
  });

  it("names user-scoped secrets with no value, only when asked", async () => {
    const settings = [
      { id: "apiToken", type: "secret" },
      { id: "legacy", secret: true },
      { id: "projectToken", type: "secret", scope: "project" },
      { id: "label", type: "string" },
    ];
    const source = {
      listPlugins: () => [info("acme.linear", {}, { contributes: { settings } as never })],
      getSettingValuesForUi: vi.fn(async () => ({
        values: {},
        secretsSet: ["legacy"],
        secretsPlaintext: [],
        secretTier: "unavailable" as const,
      })),
    };
    const without = await buildPluginInventory(source, options);
    expect(without.plugins[0]!.missingSecrets).toEqual([]);
    expect(source.getSettingValuesForUi).not.toHaveBeenCalled();

    const withSecrets = await buildPluginInventory(source, { ...options, includeSecrets: true });
    expect(withSecrets.plugins[0]!.missingSecrets).toEqual(["apiToken"]);
    expect(source.getSettingValuesForUi).toHaveBeenCalledWith("acme.linear", "user", null);
  });
});
