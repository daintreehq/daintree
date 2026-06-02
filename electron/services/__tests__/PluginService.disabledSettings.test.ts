// @vitest-environment node
import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

vi.mock("electron", () => ({
  app: {
    getPath: vi.fn((key: string) => `/mock/electron/${key}`),
    getVersion: vi.fn(() => "0.15.0"),
  },
  ipcMain: { handle: vi.fn(), removeHandler: vi.fn() },
}));

vi.mock("../ProjectStore.js", () => ({
  projectStore: {
    getAllProjects: vi.fn(() => []),
    getCurrentProjectId: vi.fn(() => null),
  },
}));

import { PluginService } from "../PluginService.js";
import type { PluginManifest, SettingDefinition } from "../../../shared/types/plugin.js";

let svc: PluginService;
let dir: string;

function manifestWith(settings: SettingDefinition[]): PluginManifest {
  return {
    name: "acme.demo",
    version: "1.0.0",
    contributes: { settings },
  } as unknown as PluginManifest;
}

/** Register a plugin as launch-disabled (lives only in disabledPlugins). */
function seedDisabled(manifest: PluginManifest) {
  (svc as unknown as { disabledPlugins: Map<string, unknown> }).disabledPlugins.set(manifest.name, {
    manifest,
    source: "sideload",
    installedAt: 0,
    originalUrl: null,
    archiveHash: null,
  });
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "plugin-svc-disabled-"));
  const pluginsRoot = join(dir, "plugins");
  mkdirSync(pluginsRoot, { recursive: true });
  svc = new PluginService(pluginsRoot);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("PluginService settings for launch-disabled plugins", () => {
  // The manager dialog renders a settings form for every plugin that
  // contributes settings, enabled or not. A plugin disabled at app launch
  // lives only in disabledPlugins (never in plugins), so the settings bridge
  // must resolve its declared fields from there — otherwise stored values
  // hydrate blank in the form.
  it("round-trips a user-scoped value for a launch-disabled plugin", async () => {
    seedDisabled(manifestWith([{ id: "apiKey", type: "string", scope: "user" }]));

    await svc.setSettingValueFromUi("acme.demo", "apiKey", "xyz", "user", null);
    const result = await svc.getSettingValuesForUi("acme.demo", "user", null);

    expect(result.values.apiKey).toBe("xyz");
  });
});
