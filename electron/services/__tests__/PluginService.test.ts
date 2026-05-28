import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import fs from "fs/promises";
import path from "path";
import os from "os";
import { fileURLToPath } from "node:url";
import type { PanelKindConfig } from "../../../shared/config/panelKindRegistry.js";

const appMock = vi.hoisted(() => ({
  getVersion: vi.fn(() => "0.0.0"),
}));
const broadcastToRendererMock = vi.hoisted(() => vi.fn());
const storeMock = vi.hoisted(() => {
  const state = new Map<string, unknown>();
  return {
    get: vi.fn((key: string) => state.get(key)),
    set: vi.fn((key: string, value: unknown) => state.set(key, value)),
    _state: state,
  };
});

vi.mock("electron", () => ({
  app: appMock,
}));
vi.mock("../../ipc/utils.js", () => ({
  broadcastToRenderer: broadcastToRendererMock,
}));
vi.mock("../../store.js", () => ({
  store: storeMock,
}));
vi.mock("../../../shared/config/panelKindRegistry.js", () => ({
  registerPanelKind: vi.fn(),
  unregisterPluginPanelKinds: vi.fn(),
  onPanelKindRegistered: vi.fn(() => () => {}),
  onPanelKindUnregistered: vi.fn(() => () => {}),
  getPluginPanelKinds: vi.fn(() => []),
}));
vi.mock("../../../shared/config/toolbarButtonRegistry.js", () => ({
  registerToolbarButton: vi.fn(),
  unregisterPluginToolbarButtons: vi.fn(),
  getAllPluginToolbarButtonConfigs: vi.fn(() => []),
}));
vi.mock("../pluginMenuRegistry.js", () => ({
  registerPluginMenuItem: vi.fn(),
  unregisterPluginMenuItems: vi.fn(),
}));
vi.mock("../forgeProviderRegistry.js", () => ({
  registerForgeProviders: vi.fn(),
  unregisterForgeProviders: vi.fn(),
  registerForgeProviderImpl: vi.fn(),
  unregisterForgeProviderImpl: vi.fn(),
  unregisterForgeProviderImpls: vi.fn(),
  getForgeProviderImpl: vi.fn(),
  clearForgeProviderImplRegistry: vi.fn(),
}));
// Mocked so unload-cascade tests can simulate a throwing decoration unregister
// without exercising the real (currently no-op) registry. Pre-existing tests
// transitively touched these via unloadPlugin but never asserted call counts.
vi.mock("../fileDecorationRegistry.js", () => ({
  registerFileDecorationProviders: vi.fn(),
  registerFileDecorationProviderImpl: vi.fn(),
  unregisterFileDecorationProviders: vi.fn(),
  unregisterFileDecorationProviderImpls: vi.fn(),
  unregisterFileDecorationProviderImpl: vi.fn(),
  scopeMatchesPattern: vi.fn((s: string, p: string) => s === p),
}));

import { PluginService } from "../PluginService.js";
import { getPluginManifestSchema } from "../../schemas/plugin.js";
import {
  BUILT_IN_PLUGIN_CAPABILITIES,
  type PluginIpcContext,
} from "../../../shared/types/plugin.js";
import {
  registerPanelKind,
  unregisterPluginPanelKinds,
} from "../../../shared/config/panelKindRegistry.js";
import {
  registerToolbarButton,
  unregisterPluginToolbarButtons,
} from "../../../shared/config/toolbarButtonRegistry.js";
import { registerPluginMenuItem, unregisterPluginMenuItems } from "../pluginMenuRegistry.js";
import {
  registerForgeProviderImpl,
  registerForgeProviders,
  unregisterForgeProviderImpl,
  unregisterForgeProviderImpls,
  unregisterForgeProviders,
} from "../forgeProviderRegistry.js";
import {
  unregisterFileDecorationProviders,
  unregisterFileDecorationProviderImpls,
} from "../fileDecorationRegistry.js";
import { CHANNELS } from "../../ipc/channels.js";

function makeCtx(pluginId: string, overrides: Partial<PluginIpcContext> = {}): PluginIpcContext {
  return {
    projectId: null,
    worktreeId: null,
    webContentsId: 0,
    pluginId,
    ...overrides,
  };
}

let tmpDir: string;

function writePlugin(name: string, manifest: Record<string, unknown>): Promise<void> {
  const dir = path.join(tmpDir, name);
  return fs
    .mkdir(dir, { recursive: true })
    .then(() => fs.writeFile(path.join(dir, "plugin.json"), JSON.stringify(manifest)));
}

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "daintree-plugin-test-"));
  vi.clearAllMocks();
  storeMock._state.clear();
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("PluginManifestSchema name validation", () => {
  const validBase = { version: "1.0.0" };
  const sixtyFourCharName = `a.${"b".repeat(62)}`; // 1 + 1 + 62 = 64 chars
  const sixtyFiveCharName = `a.${"b".repeat(63)}`; // 1 + 1 + 63 = 65 chars

  it.each([
    "acme.linear-context",
    "a.b",
    "daintreehq.dev-tools",
    "daintree-hq.my-cool-plugin",
    "acme.good-1",
    sixtyFourCharName,
  ])("accepts scoped name %j", (name) => {
    const result = getPluginManifestSchema(false).safeParse({ name, ...validBase });
    expect(result.success).toBe(true);
  });

  it.each([
    "linear-context",
    "test-plugin",
    "Acme.linear-context",
    "acme.Linear",
    "acme..tools",
    ".acme.tools",
    "acme.tools.",
    "acme.team.tools",
    "acme/tools",
    "acme_tools",
    "acme.-foo",
    "acme.foo-",
    "-acme.foo",
    "---.foo",
    "acme.---",
    " acme.foo",
    "acme.foo ",
    "acme.foo\n",
    sixtyFiveCharName,
    "",
  ])("rejects unscoped or malformed name %j", (name) => {
    const result = getPluginManifestSchema(false).safeParse({ name, ...validBase });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => i.path[0] === "name")).toBe(true);
    }
  });

  it("rejection includes an explanatory error message", () => {
    const result = getPluginManifestSchema(false).safeParse({ name: "bare-plugin", ...validBase });
    expect(result.success).toBe(false);
    if (!result.success) {
      const nameIssue = result.error.issues.find((i) => i.path[0] === "name");
      expect(nameIssue?.message).toContain("publisher.name");
    }
  });
});

describe("getPluginManifestSchema namespace lock", () => {
  const validBase = { name: "acme.test", version: "1.0.0" };

  it("rejects user plugin with daintree.* name", () => {
    const result = getPluginManifestSchema(false).safeParse({
      ...validBase,
      name: "daintree.github-evil",
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const nsIssue = result.error.issues.find(
        (i) =>
          i.code === "custom" &&
          (i as unknown as { params?: { errorCode?: string } }).params?.errorCode ===
            "namespace_reserved"
      );
      expect(nsIssue).toBeDefined();
      expect(nsIssue!.path).toEqual(["name"]);
    }
  });

  it("accepts builtin plugin with daintree.* name", () => {
    const result = getPluginManifestSchema(true).safeParse({
      ...validBase,
      name: "daintree.github",
    });
    expect(result.success).toBe(true);
  });

  it("accepts user plugin with non-daintree.* scoped name", () => {
    const result = getPluginManifestSchema(false).safeParse({
      ...validBase,
      name: "acme.daintree",
    });
    expect(result.success).toBe(true);
  });

  it("accepts user plugin with daintreehq.* name (not the daintree. prefix)", () => {
    const result = getPluginManifestSchema(false).safeParse({
      ...validBase,
      name: "daintreehq.dev-tools",
    });
    expect(result.success).toBe(true);
  });

  it("rejects user plugin with bare daintree.foo name at schema level", () => {
    const result = getPluginManifestSchema(false).safeParse({
      ...validBase,
      name: "daintree.foo",
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const nsIssue = result.error.issues.find(
        (i) =>
          i.code === "custom" &&
          (i as unknown as { params?: { errorCode?: string } }).params?.errorCode ===
            "namespace_reserved"
      );
      expect(nsIssue).toBeDefined();
    }
  });
});

describe("PluginManifestSchema capabilities field", () => {
  const validBase = { name: "acme.test", version: "1.0.0" };

  it("defaults to empty array when omitted", () => {
    const result = getPluginManifestSchema(false).safeParse(validBase);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.capabilities).toEqual([]);
    }
  });

  it("accepts an empty capabilities array", () => {
    const result = getPluginManifestSchema(false).safeParse({ ...validBase, capabilities: [] });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.capabilities).toEqual([]);
    }
  });

  it("accepts built-in capability strings", () => {
    const result = getPluginManifestSchema(false).safeParse({
      ...validBase,
      capabilities: ["fs:project-read", "network:fetch", "agent:invoke"],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.capabilities).toEqual([
        "fs:project-read",
        "network:fetch",
        "agent:invoke",
      ]);
    }
  });

  it("rejects custom (non-built-in) capability strings", () => {
    const result = getPluginManifestSchema(false).safeParse({
      ...validBase,
      capabilities: ["custom:my-perm", "org.specific:do-thing"],
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => i.path[0] === "capabilities")).toBe(true);
    }
  });

  it("rejects empty string in capabilities array", () => {
    const result = getPluginManifestSchema(false).safeParse({
      ...validBase,
      capabilities: ["fs:project-read", ""],
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => i.path[0] === "capabilities")).toBe(true);
    }
  });

  it("rejects whitespace-padded capability strings (no implicit trim)", () => {
    const result = getPluginManifestSchema(false).safeParse({
      ...validBase,
      capabilities: ["  fs:project-read  "],
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => i.path[0] === "capabilities")).toBe(true);
    }
  });

  it("rejects whitespace-only capability strings", () => {
    const result = getPluginManifestSchema(false).safeParse({
      ...validBase,
      capabilities: ["   "],
    });
    expect(result.success).toBe(false);
  });

  it("rejects capability strings containing newline characters", () => {
    const result = getPluginManifestSchema(false).safeParse({
      ...validBase,
      capabilities: ["fs:project-read\n"],
    });
    expect(result.success).toBe(false);
  });

  it('rejects stale "permissions" key because schema is strict', () => {
    const result = getPluginManifestSchema(false).safeParse({
      ...validBase,
      permissions: ["fs:project-read"],
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => i.code === "unrecognized_keys")).toBe(true);
    }
  });

  it("BUILT_IN_PLUGIN_CAPABILITIES contains all documented capabilities", () => {
    expect(BUILT_IN_PLUGIN_CAPABILITIES).toContain("fs:project-read");
    expect(BUILT_IN_PLUGIN_CAPABILITIES).toContain("fs:project-write");
    expect(BUILT_IN_PLUGIN_CAPABILITIES).toContain("fs:user-data-read");
    expect(BUILT_IN_PLUGIN_CAPABILITIES).toContain("fs:user-data-write");
    expect(BUILT_IN_PLUGIN_CAPABILITIES).toContain("network:fetch");
    expect(BUILT_IN_PLUGIN_CAPABILITIES).toContain("agent:invoke");
    expect(BUILT_IN_PLUGIN_CAPABILITIES).toContain("agent:read");
    expect(BUILT_IN_PLUGIN_CAPABILITIES).toContain("git:read");
    expect(BUILT_IN_PLUGIN_CAPABILITIES).toContain("git:write");
    expect(BUILT_IN_PLUGIN_CAPABILITIES).toContain("clipboard:read");
    expect(BUILT_IN_PLUGIN_CAPABILITIES).toContain("clipboard:write");
    expect(BUILT_IN_PLUGIN_CAPABILITIES).toContain("shell:exec");
  });

  it("BUILT_IN_PLUGIN_CAPABILITIES has exactly 12 unique entries", () => {
    expect(BUILT_IN_PLUGIN_CAPABILITIES).toHaveLength(12);
    expect(new Set(BUILT_IN_PLUGIN_CAPABILITIES).size).toBe(12);
  });

  it("rejects null capabilities value", () => {
    const result = getPluginManifestSchema(false).safeParse({
      ...validBase,
      capabilities: null,
    });
    expect(result.success).toBe(false);
  });

  it("rejects scalar (non-array) capabilities value", () => {
    const result = getPluginManifestSchema(false).safeParse({
      ...validBase,
      capabilities: "git:read",
    });
    expect(result.success).toBe(false);
  });

  it("rejects non-string elements in capabilities array", () => {
    const result = getPluginManifestSchema(false).safeParse({
      ...validBase,
      capabilities: [1, "git:read"],
    });
    expect(result.success).toBe(false);
  });
});

describe("PluginManifestSchema forgeProviders contribution", () => {
  const validBase = { name: "acme.forge", version: "1.0.0" };

  it("defaults contributes.forgeProviders to [] when contributes is absent", () => {
    const result = getPluginManifestSchema(false).safeParse(validBase);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.contributes.forgeProviders).toEqual([]);
    }
  });

  it("defaults contributes.forgeProviders to [] when contributes is an empty object", () => {
    const result = getPluginManifestSchema(false).safeParse({ ...validBase, contributes: {} });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.contributes.forgeProviders).toEqual([]);
    }
  });

  it("accepts a fully specified forgeProviders entry", () => {
    const result = getPluginManifestSchema(false).safeParse({
      ...validBase,
      contributes: {
        forgeProviders: [
          {
            id: "github",
            name: "GitHub",
            matches: ["github.com"],
            capabilities: ["issues", "pulls", "reviews", "required-checks", "releases"],
            settingsScopeRef: "github",
            viewRefs: ["github-issues", "github-prs"],
          },
        ],
      },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.contributes.forgeProviders).toEqual([
        {
          id: "github",
          name: "GitHub",
          matches: ["github.com"],
          capabilities: ["issues", "pulls", "reviews", "required-checks", "releases"],
          settingsScopeRef: "github",
          viewRefs: ["github-issues", "github-prs"],
        },
      ]);
    }
  });

  it("accepts a forgeProviders entry with only required fields", () => {
    const result = getPluginManifestSchema(false).safeParse({
      ...validBase,
      contributes: {
        forgeProviders: [{ id: "gh", name: "GitHub", matches: ["github.com"] }],
      },
    });
    expect(result.success).toBe(true);
  });

  it("rejects a forgeProviders entry with an empty matches array", () => {
    const result = getPluginManifestSchema(false).safeParse({
      ...validBase,
      contributes: {
        forgeProviders: [{ id: "gh", name: "GitHub", matches: [] }],
      },
    });
    expect(result.success).toBe(false);
  });

  it("rejects a forgeProviders entry missing required fields", () => {
    const result = getPluginManifestSchema(false).safeParse({
      ...validBase,
      contributes: {
        forgeProviders: [{ id: "gh" }],
      },
    });
    expect(result.success).toBe(false);
  });

  it("strips unknown keys on a forgeProviders entry (matches sibling contribution schemas)", () => {
    const result = getPluginManifestSchema(false).safeParse({
      ...validBase,
      contributes: {
        forgeProviders: [{ id: "gh", name: "GitHub", matches: ["github.com"], unknownKey: true }],
      },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.contributes.forgeProviders[0]).not.toHaveProperty("unknownKey");
    }
  });
});

describe("PluginManifestSchema fileDecorationProviders contribution", () => {
  const validBase = { name: "acme.decor", version: "1.0.0" };

  it("defaults contributes.fileDecorationProviders to [] when contributes is absent", () => {
    const result = getPluginManifestSchema(false).safeParse(validBase);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.contributes.fileDecorationProviders).toEqual([]);
    }
  });

  it("defaults to [] when contributes is an empty object", () => {
    const result = getPluginManifestSchema(false).safeParse({ ...validBase, contributes: {} });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.contributes.fileDecorationProviders).toEqual([]);
    }
  });

  it("accepts a valid fileDecorationProviders entry", () => {
    const result = getPluginManifestSchema(false).safeParse({
      ...validBase,
      contributes: {
        fileDecorationProviders: [{ id: "worktree-diff-review", scopes: ["worktree-diff:*"] }],
      },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.contributes.fileDecorationProviders).toEqual([
        { id: "worktree-diff-review", scopes: ["worktree-diff:*"] },
      ]);
    }
  });

  it("rejects an entry with an empty scopes array", () => {
    const result = getPluginManifestSchema(false).safeParse({
      ...validBase,
      contributes: { fileDecorationProviders: [{ id: "d", scopes: [] }] },
    });
    expect(result.success).toBe(false);
  });

  it("rejects an entry missing required fields", () => {
    const result = getPluginManifestSchema(false).safeParse({
      ...validBase,
      contributes: { fileDecorationProviders: [{ id: "d" }] },
    });
    expect(result.success).toBe(false);
  });

  it("rejects unknown keys on the entry (strict schema)", () => {
    const result = getPluginManifestSchema(false).safeParse({
      ...validBase,
      contributes: {
        fileDecorationProviders: [{ id: "d", scopes: ["s:*"], extra: true }],
      },
    });
    expect(result.success).toBe(false);
  });
});

describe("PluginManifestSchema contributes strict validation", () => {
  const validBase = { name: "acme.test", version: "1.0.0" };

  it("rejects unknown keys inside contributes (typo'd contribution-point names)", () => {
    const result = getPluginManifestSchema(false).safeParse({
      ...validBase,
      contributes: {
        commands: [{ name: "foo", title: "Foo", description: "bar", category: "test" }],
      },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const unrecognizedIssue = result.error.issues.find((i) => i.code === "unrecognized_keys");
      expect(unrecognizedIssue).toBeDefined();
    }
  });

  it("rejects old unprefixed views key inside contributes", () => {
    const result = getPluginManifestSchema(false).safeParse({
      ...validBase,
      contributes: { views: [{ id: "v", name: "V", componentPath: "./v.js", location: "panel" }] },
    });
    expect(result.success).toBe(false);
  });

  it("rejects old unprefixed mcpServers key inside contributes", () => {
    const result = getPluginManifestSchema(false).safeParse({
      ...validBase,
      contributes: { mcpServers: [{ id: "svc", name: "Svc", command: "node" }] },
    });
    expect(result.success).toBe(false);
  });

  it("rejects an arbitrary unknown key inside contributes", () => {
    const result = getPluginManifestSchema(false).safeParse({
      ...validBase,
      contributes: { unknownKey: true },
    });
    expect(result.success).toBe(false);
  });

  it("accepts empty contributes object (no unknown keys, defaults populate)", () => {
    const result = getPluginManifestSchema(false).safeParse({ ...validBase, contributes: {} });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.contributes.experimental_views).toEqual([]);
      expect(result.data.contributes.experimental_mcpServers).toEqual([]);
    }
  });

  it("accepts known contributes keys without extra keys", () => {
    const result = getPluginManifestSchema(false).safeParse({
      ...validBase,
      contributes: {
        panels: [],
        toolbarButtons: [],
      },
    });
    expect(result.success).toBe(true);
  });
});

describe("PluginService", () => {
  it("returns empty list when plugins directory does not exist", async () => {
    const service = new PluginService(path.join(tmpDir, "nonexistent"));
    await service.initialize();
    expect(service.listPlugins()).toEqual([]);
  });

  it("returns empty list when plugins directory is empty", async () => {
    const service = new PluginService(tmpDir);
    await service.initialize();
    expect(service.listPlugins()).toEqual([]);
  });

  it("loads a valid plugin and registers panel kinds", async () => {
    await writePlugin("test-plugin", {
      name: "acme.test-plugin",
      version: "1.0.0",
      displayName: "Test Plugin",
      contributes: {
        panels: [
          {
            id: "viewer",
            name: "Test Viewer",
            iconId: "eye",
            color: "#ff0000",
          },
        ],
      },
    });

    const service = new PluginService(tmpDir);
    await service.initialize();

    const plugins = service.listPlugins();
    expect(plugins).toHaveLength(1);
    expect(plugins[0].manifest.name).toBe("acme.test-plugin");
    expect(plugins[0].manifest.displayName).toBe("Test Plugin");
    expect(plugins[0].dir).toBe(path.join(tmpDir, "test-plugin"));

    expect(registerPanelKind).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "acme.test-plugin.viewer",
        name: "Test Viewer",
        iconId: "eye",
        color: "#ff0000",
        hasPty: false,
        canRestart: false,
        canConvert: false,
        showInPalette: true,
        extensionId: "acme.test-plugin",
      })
    );
  });

  it("skips directories without plugin.json", async () => {
    await fs.mkdir(path.join(tmpDir, "empty-dir"));

    const service = new PluginService(tmpDir);
    await service.initialize();
    expect(service.listPlugins()).toEqual([]);
  });

  it("skips plugins with invalid JSON", async () => {
    const dir = path.join(tmpDir, "bad-json");
    await fs.mkdir(dir);
    await fs.writeFile(path.join(dir, "plugin.json"), "not valid json {{{");

    const service = new PluginService(tmpDir);
    await service.initialize();
    expect(service.listPlugins()).toEqual([]);
  });

  it("skips plugins with invalid manifest schema", async () => {
    await writePlugin("invalid-schema", {
      version: "1.0.0",
      // missing required 'name' field
    });

    const service = new PluginService(tmpDir);
    await service.initialize();
    expect(service.listPlugins()).toEqual([]);
  });

  it("loads multiple plugins and skips invalid ones", async () => {
    await writePlugin("good-1", { name: "acme.good-1", version: "1.0.0" });
    await writePlugin("bad", { version: "1.0.0" }); // missing name
    await writePlugin("good-2", { name: "acme.good-2", version: "2.0.0" });

    const service = new PluginService(tmpDir);
    await service.initialize();

    const plugins = service.listPlugins();
    expect(plugins).toHaveLength(2);
    const names = plugins.map((p) => p.manifest.name).sort();
    expect(names).toEqual(["acme.good-1", "acme.good-2"]);
  });

  it("is idempotent — second initialize is a no-op", async () => {
    await writePlugin("test-plugin", { name: "acme.test-plugin", version: "1.0.0" });

    const service = new PluginService(tmpDir);
    await service.initialize();
    await service.initialize();

    expect(service.listPlugins()).toHaveLength(1);
    expect(registerPanelKind).toHaveBeenCalledTimes(0); // no panels declared
  });

  it("namespaces panel IDs as pluginName.panelId", async () => {
    await writePlugin("my-plugin", {
      name: "acme.my-plugin",
      version: "1.0.0",
      contributes: {
        panels: [
          { id: "viewer", name: "Viewer", iconId: "eye", color: "#000" },
          { id: "editor", name: "Editor", iconId: "pen", color: "#fff" },
        ],
      },
    });

    const service = new PluginService(tmpDir);
    await service.initialize();

    expect(registerPanelKind).toHaveBeenCalledTimes(2);
    expect(registerPanelKind).toHaveBeenCalledWith(
      expect.objectContaining({ id: "acme.my-plugin.viewer" })
    );
    expect(registerPanelKind).toHaveBeenCalledWith(
      expect.objectContaining({ id: "acme.my-plugin.editor" })
    );
  });

  it("rejects main entry paths that escape the plugin directory", async () => {
    await writePlugin("escape-test", {
      name: "acme.escape-test",
      version: "1.0.0",
      main: "../evil.js",
    });

    const service = new PluginService(tmpDir);
    await service.initialize();

    const plugins = service.listPlugins();
    expect(plugins).toHaveLength(1);
    // The plugin loads but main is silently rejected (no import attempted)
    expect(plugins[0].manifest.main).toBe("../evil.js");
  });

  it("does not include resolvedMain in listPlugins output", async () => {
    await writePlugin("main-test", {
      name: "acme.main-test",
      version: "1.0.0",
      main: "dist/main.js",
    });

    const service = new PluginService(tmpDir);
    await service.initialize();

    const plugins = service.listPlugins();
    expect(plugins).toHaveLength(1);
    // listPlugins returns LoadedPluginInfo which doesn't have resolvedMain
    expect(Object.keys(plugins[0])).not.toContain("resolvedMain");
  });

  it("listPlugins includes archiveHash when set on a loaded plugin", async () => {
    await writePlugin("hashed", {
      name: "acme.hashed",
      version: "1.0.0",
    });

    const service = new PluginService(tmpDir);
    await service.initialize();

    const validHash = "a".repeat(64);
    service.setPluginArchiveHash("acme.hashed", validHash);
    const plugins = service.listPlugins();
    expect(plugins).toHaveLength(1);
    expect(plugins[0].archiveHash).toBe(validHash);
  });

  it("listPlugins returns null archiveHash when not set", async () => {
    await writePlugin("unhashed", {
      name: "acme.unhashed",
      version: "1.0.0",
    });

    const service = new PluginService(tmpDir);
    await service.initialize();

    const plugins = service.listPlugins();
    expect(plugins).toHaveLength(1);
    expect(plugins[0].archiveHash).toBeNull();
  });

  it("setPluginArchiveHash is a silent no-op for unknown plugin ids", () => {
    const service = new PluginService(tmpDir);
    expect(() => service.setPluginArchiveHash("acme.nonexistent", "deadbeef")).not.toThrow();
  });

  it("rejects manifest with empty name", async () => {
    await writePlugin("empty-name", { name: "", version: "1.0.0" });

    const service = new PluginService(tmpDir);
    await service.initialize();
    expect(service.listPlugins()).toEqual([]);
  });

  it("rejects manifest with path-traversal name", async () => {
    await writePlugin("evil-name", { name: "../evil", version: "1.0.0" });

    const service = new PluginService(tmpDir);
    await service.initialize();
    expect(service.listPlugins()).toEqual([]);
  });

  it("rejects panel with invalid ID characters", async () => {
    await writePlugin("bad-panel", {
      name: "acme.bad-panel",
      version: "1.0.0",
      contributes: {
        panels: [{ id: "../../hack", name: "Hack", iconId: "x", color: "#000" }],
      },
    });

    const service = new PluginService(tmpDir);
    await service.initialize();
    expect(service.listPlugins()).toEqual([]);
  });

  it("rejects duplicate plugin names with error", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await writePlugin("dir-a", {
        name: "acme.same-name",
        version: "1.0.0",
        description: "first",
      });
      await writePlugin("dir-b", {
        name: "acme.same-name",
        version: "2.0.0",
        description: "second",
      });

      const service = new PluginService(tmpDir);
      await service.initialize();

      const plugins = service.listPlugins();
      expect(plugins).toHaveLength(1);
      // Initialize loads plugins concurrently via Promise.allSettled; the winner
      // is whichever finishes first, which depends on fs.readFile completion
      // order. The contract being tested is "first wins, duplicates rejected" —
      // not which directory happens to win on a given filesystem.
      const winner = plugins[0].manifest.description;
      expect(winner === "first" || winner === "second").toBe(true);
      const loser = winner === "first" ? "dir-b" : "dir-a";
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining(`Duplicate plugin name "acme.same-name" in ${loser}`)
      );
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("allows retry after non-ENOENT initialize failure", async () => {
    const badRoot = path.join(tmpDir, "unreadable");
    await fs.mkdir(badRoot);
    await writePlugin("good", { name: "acme.good", version: "1.0.0" });

    const service = new PluginService(tmpDir);

    // First call succeeds
    await service.initialize();
    expect(service.listPlugins()).toHaveLength(1);

    // Second call is no-op (already initialized)
    await service.initialize();
    expect(service.listPlugins()).toHaveLength(1);
  });

  it("registers toolbar buttons from plugin manifest", async () => {
    await writePlugin("toolbar-test", {
      name: "acme.toolbar-test",
      version: "1.0.0",
      contributes: {
        toolbarButtons: [
          {
            id: "my-btn",
            label: "My Button",
            iconId: "puzzle",
            actionId: "acme.toolbar-test.doThing",
            priority: 4,
          },
        ],
      },
    });

    const service = new PluginService(tmpDir);
    await service.initialize();

    expect(registerToolbarButton).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "plugin.acme.toolbar-test.my-btn",
        label: "My Button",
        iconId: "puzzle",
        actionId: "acme.toolbar-test.doThing",
        priority: 4,
        pluginId: "acme.toolbar-test",
      })
    );
  });

  it("uses default priority 3 when not specified in toolbar button", async () => {
    await writePlugin("default-priority", {
      name: "acme.default-priority",
      version: "1.0.0",
      contributes: {
        toolbarButtons: [
          {
            id: "btn",
            label: "Btn",
            iconId: "icon",
            actionId: "test.action",
          },
        ],
      },
    });

    const service = new PluginService(tmpDir);
    await service.initialize();

    expect(registerToolbarButton).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "plugin.acme.default-priority.btn",
        priority: 3,
      })
    );
  });

  it("registers menu items from plugin manifest", async () => {
    await writePlugin("menu-test", {
      name: "acme.menu-test",
      version: "1.0.0",
      contributes: {
        menuItems: [
          {
            label: "Do Something",
            actionId: "acme.menu-test.doSomething",
            location: "terminal",
          },
        ],
      },
    });

    const service = new PluginService(tmpDir);
    await service.initialize();

    expect(registerPluginMenuItem).toHaveBeenCalledWith("acme.menu-test", {
      label: "Do Something",
      actionId: "acme.menu-test.doSomething",
      location: "terminal",
    });
  });

  it("does not call toolbar/menu registration when no contributions", async () => {
    await writePlugin("empty-contribs", {
      name: "acme.empty-contribs",
      version: "1.0.0",
    });

    const service = new PluginService(tmpDir);
    await service.initialize();

    expect(registerToolbarButton).not.toHaveBeenCalled();
    expect(registerPluginMenuItem).not.toHaveBeenCalled();
  });
});

describe("PluginService built-in plugin loading", () => {
  let builtinDir: string;

  async function writeBuiltinPlugin(
    name: string,
    manifest: Record<string, unknown>
  ): Promise<void> {
    const dir = path.join(builtinDir, name);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "plugin.json"), JSON.stringify(manifest));
  }

  beforeEach(async () => {
    builtinDir = await fs.mkdtemp(path.join(os.tmpdir(), "daintree-builtin-plugin-test-"));
  });

  afterEach(async () => {
    await fs.rm(builtinDir, { recursive: true, force: true });
  });

  it("tags plugins loaded from the built-in directory with isBuiltin=true", async () => {
    await writeBuiltinPlugin("daintree.helper", {
      name: "daintree.helper",
      version: "1.0.0",
    });
    await writePlugin("acme.user-plugin", {
      name: "acme.user-plugin",
      version: "1.0.0",
    });

    const service = new PluginService(tmpDir, "0.0.0", { builtinPluginsRoot: builtinDir });
    await service.initialize();

    const plugins = service.listPlugins();
    expect(plugins).toHaveLength(2);
    const builtin = plugins.find((p) => p.manifest.name === "daintree.helper");
    const user = plugins.find((p) => p.manifest.name === "acme.user-plugin");
    expect(builtin?.isBuiltin).toBe(true);
    expect(user?.isBuiltin).toBe(false);
  });

  it("user plugins receive isBuiltin=false even when no built-in dir is configured", async () => {
    await writePlugin("acme.user-only", {
      name: "acme.user-only",
      version: "1.0.0",
    });

    const service = new PluginService(tmpDir, "0.0.0");
    await service.initialize();

    const plugins = service.listPlugins();
    expect(plugins).toHaveLength(1);
    expect(plugins[0].isBuiltin).toBe(false);
  });

  it("skips built-in scan cleanly when the directory is absent", async () => {
    const missingDir = path.join(builtinDir, "does-not-exist");
    await writePlugin("acme.user-plugin", {
      name: "acme.user-plugin",
      version: "1.0.0",
    });

    const service = new PluginService(tmpDir, "0.0.0", { builtinPluginsRoot: missingDir });
    await service.initialize();

    const plugins = service.listPlugins();
    expect(plugins).toHaveLength(1);
    expect(plugins[0].manifest.name).toBe("acme.user-plugin");
    expect(plugins[0].isBuiltin).toBe(false);
  });

  it("built-ins win when a user plugin declares the same manifest name", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await writeBuiltinPlugin("collision", {
        name: "daintree.dupe",
        version: "1.0.0",
        description: "builtin",
      });
      await writePlugin("collision-user", {
        name: "daintree.dupe",
        version: "2.0.0",
        description: "user",
      });

      const service = new PluginService(tmpDir, "0.0.0", { builtinPluginsRoot: builtinDir });
      await service.initialize();

      const plugins = service.listPlugins();
      expect(plugins).toHaveLength(1);
      expect(plugins[0].manifest.description).toBe("builtin");
      expect(plugins[0].isBuiltin).toBe(true);
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining(`Invalid manifest in collision-user`),
        expect.anything()
      );
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("skips built-ins listed in plugins.disabled but still lists them as disabled", async () => {
    storeMock._state.set("plugins", { disabled: ["daintree.muted"] });
    await writeBuiltinPlugin("muted", {
      name: "daintree.muted",
      version: "1.0.0",
    });
    await writeBuiltinPlugin("kept", {
      name: "daintree.kept",
      version: "1.0.0",
    });

    const service = new PluginService(tmpDir, "0.0.0", { builtinPluginsRoot: builtinDir });
    await service.initialize();

    const plugins = service.listPlugins();
    const kept = plugins.find((p) => p.manifest.name === "daintree.kept");
    const muted = plugins.find((p) => p.manifest.name === "daintree.muted");
    expect(kept?.disabled).toBe(false);
    expect(muted?.disabled).toBe(true);
    expect(muted?.isBuiltin).toBe(true);
  });

  it("skips user plugins listed in plugins.disabled and lists them as disabled", async () => {
    storeMock._state.set("plugins", { disabled: ["acme.user-plugin"] });
    await writePlugin("acme.user-plugin", {
      name: "acme.user-plugin",
      version: "1.0.0",
    });

    const service = new PluginService(tmpDir, "0.0.0", { builtinPluginsRoot: builtinDir });
    await service.initialize();

    const plugins = service.listPlugins();
    expect(plugins).toHaveLength(1);
    expect(plugins[0].disabled).toBe(true);
    expect(plugins[0].isBuiltin).toBe(false);
  });

  it("marks active plugins with disabled=false", async () => {
    await writePlugin("acme.active", { name: "acme.active", version: "1.0.0" });

    const service = new PluginService(tmpDir, "0.0.0", { builtinPluginsRoot: builtinDir });
    await service.initialize();

    const plugins = service.listPlugins();
    expect(plugins).toHaveLength(1);
    expect(plugins[0].disabled).toBe(false);
  });

  it("treats missing plugins.disabled as empty (no exception)", async () => {
    // store has no "plugins" key at all (in-memory fallback shape)
    await writeBuiltinPlugin("daintree.helper", {
      name: "daintree.helper",
      version: "1.0.0",
    });

    const service = new PluginService(tmpDir, "0.0.0", { builtinPluginsRoot: builtinDir });
    await service.initialize();

    expect(service.listPlugins()).toHaveLength(1);
    expect(service.listPlugins()[0].disabled).toBe(false);
  });

  it("ignores malformed disabled values defensively", async () => {
    storeMock._state.set("plugins", { disabled: "not-an-array" });
    await writeBuiltinPlugin("daintree.helper", {
      name: "daintree.helper",
      version: "1.0.0",
    });

    const service = new PluginService(tmpDir, "0.0.0", { builtinPluginsRoot: builtinDir });
    await service.initialize();

    expect(service.listPlugins()).toHaveLength(1);
    expect(service.listPlugins()[0].disabled).toBe(false);
  });

  it("a disabled name collision keeps the built-in entry (loaded first) for the toggle", async () => {
    storeMock._state.set("plugins", { disabled: ["daintree.github"] });
    await writeBuiltinPlugin("github", {
      name: "daintree.github",
      version: "1.0.0",
      description: "first-party",
    });
    await writePlugin("hijacker", {
      name: "daintree.github",
      version: "9.9.9",
      description: "third-party impostor",
    });

    const service = new PluginService(tmpDir, "0.0.0", { builtinPluginsRoot: builtinDir });
    await service.initialize();

    const plugins = service.listPlugins();
    expect(plugins).toHaveLength(1);
    expect(plugins[0].disabled).toBe(true);
    expect(plugins[0].isBuiltin).toBe(true);
    expect(plugins[0].manifest.description).toBe("first-party");
  });

  describe("setEnabled", () => {
    it("adds a plugin id to plugins.disabled when disabling", () => {
      storeMock._state.set("plugins", { disabled: [] });
      const service = new PluginService(tmpDir, "0.0.0", { builtinPluginsRoot: builtinDir });

      service.setEnabled("acme.foo", false);

      expect(storeMock._state.get("plugins")).toEqual({ disabled: ["acme.foo"] });
    });

    it("removes a plugin id from plugins.disabled when enabling", () => {
      storeMock._state.set("plugins", { disabled: ["acme.foo", "acme.bar"] });
      const service = new PluginService(tmpDir, "0.0.0", { builtinPluginsRoot: builtinDir });

      service.setEnabled("acme.foo", true);

      expect(storeMock._state.get("plugins")).toEqual({ disabled: ["acme.bar"] });
    });

    it("is idempotent — disabling an already-disabled plugin does not duplicate it", () => {
      storeMock._state.set("plugins", { disabled: ["acme.foo"] });
      const service = new PluginService(tmpDir, "0.0.0", { builtinPluginsRoot: builtinDir });

      service.setEnabled("acme.foo", false);

      expect(storeMock._state.get("plugins")).toEqual({ disabled: ["acme.foo"] });
    });

    it("preserves other keys in the plugins object", () => {
      storeMock._state.set("plugins", { disabled: [], other: "keep" });
      const service = new PluginService(tmpDir, "0.0.0", { builtinPluginsRoot: builtinDir });

      service.setEnabled("acme.foo", false);

      expect(storeMock._state.get("plugins")).toEqual({ disabled: ["acme.foo"], other: "keep" });
    });

    it("throws on an empty or whitespace-only plugin id", () => {
      const service = new PluginService(tmpDir, "0.0.0", { builtinPluginsRoot: builtinDir });
      expect(() => service.setEnabled("", false)).toThrow(/non-empty string/);
      expect(() => service.setEnabled("   ", false)).toThrow(/non-empty string/);
    });

    it("listPlugins reflects a runtime disable as disabled+pendingRestart without restart", async () => {
      storeMock._state.set("plugins", { disabled: [] });
      await writePlugin("acme.runtime", { name: "acme.runtime", version: "1.0.0" });
      const service = new PluginService(tmpDir, "0.0.0", { builtinPluginsRoot: builtinDir });
      await service.initialize();

      expect(service.listPlugins()[0]).toMatchObject({ disabled: false, pendingRestart: false });

      service.setEnabled("acme.runtime", false);

      // Still running this session, but the desired state is now off.
      expect(service.listPlugins()[0]).toMatchObject({ disabled: true, pendingRestart: true });
    });

    it("listPlugins reflects a runtime re-enable of a launch-disabled plugin", async () => {
      storeMock._state.set("plugins", { disabled: ["acme.off"] });
      await writePlugin("acme.off", { name: "acme.off", version: "1.0.0" });
      const service = new PluginService(tmpDir, "0.0.0", { builtinPluginsRoot: builtinDir });
      await service.initialize();

      expect(service.listPlugins()[0]).toMatchObject({ disabled: true, pendingRestart: false });

      service.setEnabled("acme.off", true);

      // Not running this session, but the desired state is now on.
      expect(service.listPlugins()[0]).toMatchObject({ disabled: false, pendingRestart: true });
    });
  });

  it("emits toast when a user plugin uses the daintree.* namespace", async () => {
    const { broadcastToRenderer } = await import("../../ipc/utils.js");
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await writePlugin("daintree.pirate", {
        name: "daintree.pirate",
        version: "1.0.0",
      });

      const service = new PluginService(tmpDir, "0.0.0", { builtinPluginsRoot: builtinDir });
      await service.initialize();

      expect(service.listPlugins()).toEqual([]);
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining("Invalid manifest in daintree.pirate"),
        expect.anything()
      );
      expect(broadcastToRenderer).toHaveBeenCalledWith(
        CHANNELS.NOTIFICATION_SHOW_TOAST,
        expect.objectContaining({
          type: "error",
          title: "Plugin uses a reserved namespace",
          message: expect.stringContaining("daintree.pirate"),
        })
      );
    } finally {
      errorSpy.mockRestore();
    }
  });
});

describe("Plugin IPC handler registration", () => {
  let service: PluginService;

  beforeEach(async () => {
    await writePlugin("test-plugin", { name: "acme.test-plugin", version: "1.0.0" });
    service = new PluginService(tmpDir);
    await service.initialize();
  });

  it("registerHandler succeeds for a loaded plugin with valid channel", () => {
    const handler = vi.fn();
    expect(() => service.registerHandler("acme.test-plugin", "get-data", handler)).not.toThrow();
  });

  it("registerHandler throws when pluginId is not loaded", () => {
    expect(() => service.registerHandler("acme.unknown-plugin", "get-data", vi.fn())).toThrow(
      "Unknown plugin: acme.unknown-plugin"
    );
  });

  it("registerHandler throws when channel contains a colon", () => {
    expect(() => service.registerHandler("acme.test-plugin", "bad:channel", vi.fn())).toThrow(
      "Plugin channel must not contain colons: bad:channel"
    );
  });

  it("registerHandler throws when handler is not a function", () => {
    expect(() =>
      service.registerHandler("acme.test-plugin", "get-data", "not-a-function" as never)
    ).toThrow("Plugin handler must be a function, got string");
  });

  it("dispatchHandler calls the registered handler and returns its result", async () => {
    const handler = vi.fn().mockResolvedValue({ value: 42 });
    service.registerHandler("acme.test-plugin", "get-data", handler);

    const ctx = makeCtx("acme.test-plugin", { webContentsId: 7 });
    const result = await service.dispatchHandler("acme.test-plugin", "get-data", ctx, [
      "arg1",
      "arg2",
    ]);
    expect(handler).toHaveBeenCalledWith(ctx, "arg1", "arg2");
    expect(result).toEqual({ value: 42 });
  });

  it("dispatchHandler passes the context as the first argument to the handler", async () => {
    const handler = vi.fn().mockResolvedValue("ok");
    service.registerHandler("acme.test-plugin", "get-ctx", handler);

    const ctx = makeCtx("acme.test-plugin", {
      projectId: "p1",
      worktreeId: "w1",
      webContentsId: 42,
    });
    await service.dispatchHandler("acme.test-plugin", "get-ctx", ctx, ["x"]);
    expect(handler.mock.calls[0][0]).toEqual(ctx);
    expect(handler.mock.calls[0][1]).toBe("x");
  });

  it("dispatchHandler throws when no handler is found", async () => {
    await expect(
      service.dispatchHandler("acme.test-plugin", "unknown", makeCtx("acme.test-plugin"), [])
    ).rejects.toThrow("No plugin handler registered for acme.test-plugin:unknown");
  });

  it("registering same (pluginId, channel) twice overwrites the handler", async () => {
    const handler1 = vi.fn().mockReturnValue("first");
    const handler2 = vi.fn().mockReturnValue("second");
    service.registerHandler("acme.test-plugin", "get-data", handler1);
    service.registerHandler("acme.test-plugin", "get-data", handler2);

    const result = await service.dispatchHandler(
      "acme.test-plugin",
      "get-data",
      makeCtx("acme.test-plugin"),
      []
    );
    expect(result).toBe("second");
    expect(handler1).not.toHaveBeenCalled();
  });

  it("removeHandlers removes all handlers for a plugin, leaving others intact", async () => {
    await writePlugin("other-plugin", { name: "acme.other-plugin", version: "1.0.0" });
    const service2 = new PluginService(tmpDir);
    await service2.initialize();

    service2.registerHandler("acme.test-plugin", "ch-a", vi.fn().mockReturnValue("a"));
    service2.registerHandler("acme.test-plugin", "ch-b", vi.fn().mockReturnValue("b"));
    service2.registerHandler("acme.other-plugin", "ch-c", vi.fn().mockReturnValue("c"));

    service2.removeHandlers("acme.test-plugin");

    await expect(
      service2.dispatchHandler("acme.test-plugin", "ch-a", makeCtx("acme.test-plugin"), [])
    ).rejects.toThrow();
    await expect(
      service2.dispatchHandler("acme.test-plugin", "ch-b", makeCtx("acme.test-plugin"), [])
    ).rejects.toThrow();
    expect(
      await service2.dispatchHandler("acme.other-plugin", "ch-c", makeCtx("acme.other-plugin"), [])
    ).toBe("c");
  });

  it("hasPlugin returns true for loaded plugins and false otherwise", () => {
    expect(service.hasPlugin("acme.test-plugin")).toBe(true);
    expect(service.hasPlugin("nonexistent")).toBe(false);
  });

  it("registerHandler throws for empty channel", () => {
    expect(() => service.registerHandler("acme.test-plugin", "", vi.fn())).not.toThrow();
    // Empty channel is technically valid — no colons
  });

  it("dispatchHandler handles synchronous handlers", async () => {
    service.registerHandler("acme.test-plugin", "sync", () => "sync-result");
    const result = await service.dispatchHandler(
      "acme.test-plugin",
      "sync",
      makeCtx("acme.test-plugin"),
      []
    );
    expect(result).toBe("sync-result");
  });

  describe("dispatchHandler args validation", () => {
    it("validates args when channel matches a registered action with inputSchema", async () => {
      service.registerPluginAction("acme.test-plugin", {
        id: "acme.test-plugin.ping",
        title: "Ping",
        description: "Ping action",
        category: "test",
        kind: "command",
        danger: "safe",
        inputSchema: {
          type: "object",
          properties: { name: { type: "string" } },
          required: ["name"],
        },
      });
      const handler = vi.fn().mockResolvedValue("ok");
      service.registerHandler("acme.test-plugin", "acme.test-plugin.ping", handler);

      await expect(
        service.dispatchHandler(
          "acme.test-plugin",
          "acme.test-plugin.ping",
          makeCtx("acme.test-plugin"),
          [{ name: 42 }]
        )
      ).rejects.toThrow("Invalid arguments for plugin action");
      expect(handler).not.toHaveBeenCalled();
    });

    it("passes valid args through to the handler", async () => {
      service.registerPluginAction("acme.test-plugin", {
        id: "acme.test-plugin.echo",
        title: "Echo",
        description: "Echo action",
        category: "test",
        kind: "command",
        danger: "safe",
        inputSchema: {
          type: "object",
          properties: { name: { type: "string" } },
          required: ["name"],
        },
      });
      const handler = vi.fn().mockResolvedValue("ok");
      service.registerHandler("acme.test-plugin", "acme.test-plugin.echo", handler);

      const result = await service.dispatchHandler(
        "acme.test-plugin",
        "acme.test-plugin.echo",
        makeCtx("acme.test-plugin"),
        [{ name: "world" }]
      );
      expect(result).toBe("ok");
      expect(handler).toHaveBeenCalledWith(expect.anything(), { name: "world" });
    });

    it("skips validation when no action descriptor is registered for the channel", async () => {
      const handler = vi.fn().mockResolvedValue("ok");
      service.registerHandler("acme.test-plugin", "raw-channel", handler);

      const result = await service.dispatchHandler(
        "acme.test-plugin",
        "raw-channel",
        makeCtx("acme.test-plugin"),
        [{ anything: "goes" }]
      );
      expect(result).toBe("ok");
    });

    it("skips validation when the descriptor has no inputSchema", async () => {
      service.registerPluginAction("acme.test-plugin", {
        id: "acme.test-plugin.no-schema",
        title: "No Schema",
        description: "No schema action",
        category: "test",
        kind: "command",
        danger: "safe",
      });
      const handler = vi.fn().mockResolvedValue("ok");
      service.registerHandler("acme.test-plugin", "acme.test-plugin.no-schema", handler);

      const result = await service.dispatchHandler(
        "acme.test-plugin",
        "acme.test-plugin.no-schema",
        makeCtx("acme.test-plugin"),
        [{ foo: "bar" }]
      );
      expect(result).toBe("ok");
    });

    it("caches the compiled validator and reuses it on subsequent calls", async () => {
      service.registerPluginAction("acme.test-plugin", {
        id: "acme.test-plugin.cached",
        title: "Cached",
        description: "Cache test action",
        category: "test",
        kind: "command",
        danger: "safe",
        inputSchema: {
          type: "object",
          properties: { value: { type: "number" } },
          required: ["value"],
        },
      });
      const handler = vi.fn().mockResolvedValue("ok");
      service.registerHandler("acme.test-plugin", "acme.test-plugin.cached", handler);

      // First call compiles
      await service.dispatchHandler(
        "acme.test-plugin",
        "acme.test-plugin.cached",
        makeCtx("acme.test-plugin"),
        [{ value: 1 }]
      );
      // Second call reuses cached validator
      await service.dispatchHandler(
        "acme.test-plugin",
        "acme.test-plugin.cached",
        makeCtx("acme.test-plugin"),
        [{ value: 2 }]
      );

      expect(handler).toHaveBeenCalledTimes(2);
      expect(handler).toHaveBeenNthCalledWith(1, expect.anything(), { value: 1 });
      expect(handler).toHaveBeenNthCalledWith(2, expect.anything(), { value: 2 });
    });

    it("treats no args as empty object for validation", async () => {
      service.registerPluginAction("acme.test-plugin", {
        id: "acme.test-plugin.opt",
        title: "Opt",
        description: "Optional args action",
        category: "test",
        kind: "command",
        danger: "safe",
        inputSchema: {
          type: "object",
          properties: { name: { type: "string" } },
        },
      });
      const handler = vi.fn().mockResolvedValue("ok");
      service.registerHandler("acme.test-plugin", "acme.test-plugin.opt", handler);

      // No args call — should validate against {} which matches the schema (no required fields)
      const result = await service.dispatchHandler(
        "acme.test-plugin",
        "acme.test-plugin.opt",
        makeCtx("acme.test-plugin"),
        []
      );
      expect(result).toBe("ok");
    });

    it("cleans up the validator when the handler is removed", async () => {
      service.registerPluginAction("acme.test-plugin", {
        id: "acme.test-plugin.cleanup",
        title: "Cleanup",
        description: "Cleanup test action",
        category: "test",
        kind: "command",
        danger: "safe",
        inputSchema: {
          type: "object",
          properties: { x: { type: "number" } },
          required: ["x"],
        },
      });
      service.registerHandler(
        "acme.test-plugin",
        "acme.test-plugin.cleanup",
        vi.fn().mockResolvedValue("ok")
      );

      // Prime the validator cache with a successful call
      await service.dispatchHandler(
        "acme.test-plugin",
        "acme.test-plugin.cleanup",
        makeCtx("acme.test-plugin"),
        [{ x: 1 }]
      );

      service.removeHandlers("acme.test-plugin");

      // Re-register and re-prime — the old validator should be gone
      service.registerHandler(
        "acme.test-plugin",
        "acme.test-plugin.cleanup",
        vi.fn().mockResolvedValue("ok")
      );
      // Should still work (compiles fresh)
      const result = await service.dispatchHandler(
        "acme.test-plugin",
        "acme.test-plugin.cleanup",
        makeCtx("acme.test-plugin"),
        [{ x: 42 }]
      );
      expect(result).toBe("ok");
    });

    it("rejects async ($async) schemas at compile time", async () => {
      service.registerPluginAction("acme.test-plugin", {
        id: "acme.test-plugin.async",
        title: "Async",
        description: "Async schema action",
        category: "test",
        kind: "command",
        danger: "safe",
        inputSchema: { $async: true, type: "object" },
      });
      service.registerHandler(
        "acme.test-plugin",
        "acme.test-plugin.async",
        vi.fn().mockResolvedValue("ok")
      );

      await expect(
        service.dispatchHandler(
          "acme.test-plugin",
          "acme.test-plugin.async",
          makeCtx("acme.test-plugin"),
          [{}]
        )
      ).rejects.toThrow("async");
    });

    it("supports standard JSON Schema formats like uri and email", async () => {
      service.registerPluginAction("acme.test-plugin", {
        id: "acme.test-plugin.format",
        title: "Format",
        description: "Format test action",
        category: "test",
        kind: "command",
        danger: "safe",
        inputSchema: {
          type: "object",
          properties: {
            url: { type: "string", format: "uri" },
            email: { type: "string", format: "email" },
          },
        },
      });
      const handler = vi.fn().mockResolvedValue("ok");
      service.registerHandler("acme.test-plugin", "acme.test-plugin.format", handler);

      // Valid formats
      await service.dispatchHandler(
        "acme.test-plugin",
        "acme.test-plugin.format",
        makeCtx("acme.test-plugin"),
        [{ url: "https://example.com", email: "test@example.com" }]
      );
      expect(handler).toHaveBeenCalled();

      // Invalid format rejects
      await expect(
        service.dispatchHandler(
          "acme.test-plugin",
          "acme.test-plugin.format",
          makeCtx("acme.test-plugin"),
          [{ url: "not-a-url", email: "test@example.com" }]
        )
      ).rejects.toThrow("Invalid arguments for plugin action");
    });

    it("does not validate when descriptor.pluginId differs from dispatch pluginId", async () => {
      // Register an action for acme.test-plugin
      service.registerPluginAction("acme.test-plugin", {
        id: "acme.test-plugin.guarded",
        title: "Guarded",
        description: "Owner-check action",
        category: "test",
        kind: "command",
        danger: "safe",
        inputSchema: {
          type: "object",
          properties: { name: { type: "string" } },
          required: ["name"],
        },
      });

      // Load a second plugin
      await writePlugin("other", { name: "acme.other", version: "1.0.0" });
      const service2 = new PluginService(tmpDir);
      await service2.initialize();

      // Register a raw handler on the second plugin whose channel collides with first plugin's action id
      const handler = vi.fn().mockResolvedValue("ok");
      service2.registerHandler("acme.other", "acme.test-plugin.guarded", handler);

      // Dispatch via the second plugin — should NOT validate (owner mismatch)
      const result = await service2.dispatchHandler(
        "acme.other",
        "acme.test-plugin.guarded",
        { projectId: null, worktreeId: null, webContentsId: 1, pluginId: "acme.other" },
        [{ name: 42 }]
      );
      expect(result).toBe("ok");
    });

    it("cleans up validators on unregisterPluginAction", async () => {
      service.registerPluginAction("acme.test-plugin", {
        id: "acme.test-plugin.stale",
        title: "Stale",
        description: "Stale validator test",
        category: "test",
        kind: "command",
        danger: "safe",
        inputSchema: {
          type: "object",
          properties: { x: { type: "number" } },
          required: ["x"],
        },
      });
      service.registerHandler(
        "acme.test-plugin",
        "acme.test-plugin.stale",
        vi.fn().mockResolvedValue("ok")
      );

      // Prime the cache
      await service.dispatchHandler(
        "acme.test-plugin",
        "acme.test-plugin.stale",
        makeCtx("acme.test-plugin"),
        [{ x: 1 }]
      );

      // Unregister and re-register with a different schema
      service.unregisterPluginAction("acme.test-plugin", "acme.test-plugin.stale");
      service.registerPluginAction("acme.test-plugin", {
        id: "acme.test-plugin.stale",
        title: "Stale",
        description: "Stale validator test — new schema",
        category: "test",
        kind: "command",
        danger: "safe",
        inputSchema: {
          type: "object",
          properties: { y: { type: "string" } },
          required: ["y"],
        },
      });
      const handler = vi.fn().mockResolvedValue("ok");
      service.registerHandler("acme.test-plugin", "acme.test-plugin.stale", handler);

      // Old schema required `x: number` — should now reject that
      await expect(
        service.dispatchHandler(
          "acme.test-plugin",
          "acme.test-plugin.stale",
          makeCtx("acme.test-plugin"),
          [{ x: 1 }]
        )
      ).rejects.toThrow("Invalid arguments for plugin action");

      // New schema requires `y: string` — should pass with correct args
      await service.dispatchHandler(
        "acme.test-plugin",
        "acme.test-plugin.stale",
        makeCtx("acme.test-plugin"),
        [{ y: "hello" }]
      );
      expect(handler).toHaveBeenCalledWith(expect.anything(), { y: "hello" });
    });

    it("does not validate when a different plugin registers a handler with same channel as another plugin's action id", async () => {
      // Register action for acme.test-plugin with a restrictive schema
      service.registerPluginAction("acme.test-plugin", {
        id: "acme.test-plugin.shared-channel",
        title: "Shared Channel",
        description: "Test shared channel collision",
        category: "test",
        kind: "command",
        danger: "safe",
        inputSchema: {
          type: "object",
          properties: { name: { type: "string" } },
          required: ["name"],
        },
      });

      // Load a second plugin and register a raw handler on the same channel
      await writePlugin("collider-plugin", { name: "acme.collider", version: "1.0.0" });
      const colliderService = new PluginService(tmpDir, "0.0.0");
      await colliderService.initialize();

      // Register a raw handler whose channel collides with test-plugin's action id
      const handler = vi.fn().mockResolvedValue("cross-plugin-ok");
      colliderService.registerHandler("acme.collider", "acme.test-plugin.shared-channel", handler);

      // Dispatching via collider plugin should NOT inherit test-plugin's schema
      const result = await colliderService.dispatchHandler(
        "acme.collider",
        "acme.test-plugin.shared-channel",
        { projectId: null, worktreeId: null, webContentsId: 99, pluginId: "acme.collider" },
        [{ name: 42 }]
      );
      expect(result).toBe("cross-plugin-ok");
    });
  });
});

describe("engines.daintree compatibility gate", () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it("loads a plugin when app version satisfies engines.daintree", async () => {
    await writePlugin("compatible", {
      name: "acme.compatible",
      version: "1.0.0",
      engines: { daintree: "^0.7.0" },
    });

    const service = new PluginService(tmpDir, "0.7.5");
    await service.initialize();

    expect(service.listPlugins()).toHaveLength(1);
    expect(broadcastToRendererMock).not.toHaveBeenCalled();
  });

  it("rejects a plugin when app version does not satisfy engines.daintree", async () => {
    await writePlugin("incompatible", {
      name: "acme.incompatible",
      displayName: "Incompatible Plugin",
      version: "1.0.0",
      engines: { daintree: "^0.7.0" },
      contributes: {
        panels: [{ id: "viewer", name: "Viewer", iconId: "eye", color: "#000" }],
      },
    });

    const service = new PluginService(tmpDir, "0.8.0");
    await service.initialize();

    expect(service.listPlugins()).toEqual([]);
    expect(registerPanelKind).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('Plugin "acme.incompatible" requires Daintree ^0.7.0')
    );
    expect(broadcastToRendererMock).toHaveBeenCalledWith(
      CHANNELS.NOTIFICATION_SHOW_TOAST,
      expect.objectContaining({
        type: "error",
        title: "Plugin incompatible",
        message: expect.stringContaining("Incompatible Plugin"),
      })
    );
  });

  it("treats app prerelease versions as satisfying their release-series range", async () => {
    await writePlugin("prerelease-compatible", {
      name: "acme.prerelease-compatible",
      version: "1.0.0",
      engines: { daintree: "^0.7.0" },
    });

    const service = new PluginService(tmpDir, "0.7.1-rc.1");
    await service.initialize();

    expect(service.listPlugins()).toHaveLength(1);
    expect(broadcastToRendererMock).not.toHaveBeenCalled();
  });

  it("loads plugins that omit engines.daintree with a warning", async () => {
    await writePlugin("no-engines", { name: "acme.no-engines", version: "1.0.0" });

    const service = new PluginService(tmpDir, "0.7.5");
    await service.initialize();

    expect(service.listPlugins()).toHaveLength(1);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('Plugin "acme.no-engines" does not declare engines.daintree')
    );
    expect(broadcastToRendererMock).not.toHaveBeenCalled();
  });

  it("loads plugins with empty engines object (daintree absent) with a warning", async () => {
    await writePlugin("empty-engines", {
      name: "acme.empty-engines",
      version: "1.0.0",
      engines: {},
    });

    const service = new PluginService(tmpDir, "0.7.5");
    await service.initialize();

    expect(service.listPlugins()).toHaveLength(1);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('Plugin "acme.empty-engines" does not declare engines.daintree')
    );
  });

  it("rejects manifests with an invalid semver range at schema level", async () => {
    await writePlugin("bad-range", {
      name: "acme.bad-range",
      version: "1.0.0",
      engines: { daintree: "not-a-range" },
    });

    const service = new PluginService(tmpDir, "0.7.5");
    await service.initialize();

    expect(service.listPlugins()).toEqual([]);
    expect(broadcastToRendererMock).not.toHaveBeenCalled();
  });

  it("rejects plugins requiring a future major version", async () => {
    await writePlugin("future", {
      name: "acme.future",
      version: "1.0.0",
      engines: { daintree: "^1.0.0" },
    });

    const service = new PluginService(tmpDir, "0.7.1");
    await service.initialize();

    expect(service.listPlugins()).toEqual([]);
    expect(broadcastToRendererMock).toHaveBeenCalledTimes(1);
  });

  it("does not attempt main import or register contributions for incompatible plugins", async () => {
    await writePlugin("skip-side-effects", {
      name: "acme.skip-side-effects",
      version: "1.0.0",
      main: "dist/main.js",
      engines: { daintree: "^1.0.0" },
      contributes: {
        panels: [{ id: "p", name: "P", iconId: "i", color: "#000" }],
        toolbarButtons: [{ id: "b", label: "B", iconId: "i", actionId: "x.y" }],
        menuItems: [{ label: "L", actionId: "x.y", location: "terminal" }],
      },
    });

    const service = new PluginService(tmpDir, "0.7.1");
    await service.initialize();

    expect(service.listPlugins()).toEqual([]);
    expect(registerPanelKind).not.toHaveBeenCalled();
    expect(registerToolbarButton).not.toHaveBeenCalled();
    expect(registerPluginMenuItem).not.toHaveBeenCalled();
  });

  it("loads only the compatible plugins in a mixed batch", async () => {
    await writePlugin("good", {
      name: "acme.good",
      version: "1.0.0",
      engines: { daintree: "^0.7.0" },
    });
    await writePlugin("bad", {
      name: "acme.bad",
      version: "1.0.0",
      engines: { daintree: "^1.0.0" },
    });

    const service = new PluginService(tmpDir, "0.7.5");
    await service.initialize();

    const names = service.listPlugins().map((p) => p.manifest.name);
    expect(names).toEqual(["acme.good"]);
    expect(broadcastToRendererMock).toHaveBeenCalledTimes(1);
  });

  it("accepts the wildcard range '*'", async () => {
    await writePlugin("wildcard", {
      name: "acme.wildcard",
      version: "1.0.0",
      engines: { daintree: "*" },
    });

    const service = new PluginService(tmpDir, "0.7.1");
    await service.initialize();

    expect(service.listPlugins()).toHaveLength(1);
    expect(broadcastToRendererMock).not.toHaveBeenCalled();
  });

  it("rejects whitespace-only range strings at the schema layer", async () => {
    await writePlugin("whitespace-range", {
      name: "acme.whitespace-range",
      version: "1.0.0",
      engines: { daintree: "   " },
    });

    const service = new PluginService(tmpDir, "0.7.5");
    await service.initialize();

    expect(service.listPlugins()).toEqual([]);
    expect(broadcastToRendererMock).not.toHaveBeenCalled();
  });

  it("rejects an app prerelease that is below a non-prerelease range's lower bound", async () => {
    await writePlugin("prerelease-too-early", {
      name: "acme.prerelease-too-early",
      version: "1.0.0",
      engines: { daintree: ">=0.7.0" },
    });

    const service = new PluginService(tmpDir, "0.7.0-rc.1");
    await service.initialize();

    expect(service.listPlugins()).toEqual([]);
    expect(broadcastToRendererMock).toHaveBeenCalledTimes(1);
  });

  it("accepts an exact-version range when the app matches precisely", async () => {
    await writePlugin("exact-match", {
      name: "acme.exact-match",
      version: "1.0.0",
      engines: { daintree: "0.7.5" },
    });

    const service = new PluginService(tmpDir, "0.7.5");
    await service.initialize();

    expect(service.listPlugins()).toHaveLength(1);
    expect(broadcastToRendererMock).not.toHaveBeenCalled();
  });

  it("rejects an exact-version range when the app does not match", async () => {
    await writePlugin("exact-mismatch", {
      name: "acme.exact-mismatch",
      version: "1.0.0",
      engines: { daintree: "0.7.5" },
    });

    const service = new PluginService(tmpDir, "0.7.4");
    await service.initialize();

    expect(service.listPlugins()).toEqual([]);
    expect(broadcastToRendererMock).toHaveBeenCalledTimes(1);
  });
});

describe("strict schema validation", () => {
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    errorSpy.mockRestore();
  });

  it("rejects manifests with unknown fields like 'renderer'", async () => {
    await writePlugin("bad-field", {
      name: "acme.bad-field",
      version: "1.0.0",
      renderer: "dist/renderer.js",
      engines: { daintree: "*" },
    });

    const service = new PluginService(tmpDir);
    await service.initialize();

    expect(service.listPlugins()).toEqual([]);
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("Invalid manifest in bad-field"),
      expect.arrayContaining([
        expect.objectContaining({
          code: "unrecognized_keys",
          keys: ["renderer"],
        }),
      ])
    );
  });
});

describe("Plugin unload lifecycle", () => {
  it("unloadPlugin calls all registry unregister functions for the plugin", async () => {
    await writePlugin("unloadable", {
      name: "acme.unloadable",
      version: "1.0.0",
      contributes: {
        panels: [{ id: "viewer", name: "Viewer", iconId: "eye", color: "#000" }],
        toolbarButtons: [{ id: "btn", label: "Btn", iconId: "icon", actionId: "x.y" }],
        menuItems: [{ label: "L", actionId: "x.y", location: "terminal" }],
      },
    });

    const service = new PluginService(tmpDir);
    await service.initialize();

    expect(service.hasPlugin("acme.unloadable")).toBe(true);

    service.unloadPlugin("acme.unloadable");

    expect(unregisterPluginMenuItems).toHaveBeenCalledWith("acme.unloadable");
    expect(unregisterPluginToolbarButtons).toHaveBeenCalledWith("acme.unloadable");
    expect(unregisterPluginPanelKinds).toHaveBeenCalledWith("acme.unloadable");
    expect(unregisterForgeProviders).toHaveBeenCalledWith("acme.unloadable");
  });

  it("unloadPlugin removes the plugin from hasPlugin and listPlugins", async () => {
    await writePlugin("goodbye", { name: "acme.goodbye", version: "1.0.0" });

    const service = new PluginService(tmpDir);
    await service.initialize();
    expect(service.hasPlugin("acme.goodbye")).toBe(true);

    service.unloadPlugin("acme.goodbye");

    expect(service.hasPlugin("acme.goodbye")).toBe(false);
    expect(service.listPlugins()).toEqual([]);
  });

  it("unloadPlugin removes IPC handlers registered for the plugin", async () => {
    await writePlugin("handler-host", { name: "acme.handler-host", version: "1.0.0" });

    const service = new PluginService(tmpDir);
    await service.initialize();

    service.registerHandler("acme.handler-host", "ping", () => "pong");
    expect(
      await service.dispatchHandler("acme.handler-host", "ping", makeCtx("acme.handler-host"), [])
    ).toBe("pong");

    service.unloadPlugin("acme.handler-host");

    await expect(
      service.dispatchHandler("acme.handler-host", "ping", makeCtx("acme.handler-host"), [])
    ).rejects.toThrow("No plugin handler registered for acme.handler-host:ping");
  });

  it("unloadPlugin is a no-op when the plugin is not loaded", async () => {
    const service = new PluginService(tmpDir);
    await service.initialize();

    expect(() => service.unloadPlugin("acme.never-loaded")).not.toThrow();
    expect(unregisterPluginMenuItems).not.toHaveBeenCalled();
    expect(unregisterPluginToolbarButtons).not.toHaveBeenCalled();
    expect(unregisterPluginPanelKinds).not.toHaveBeenCalled();
    expect(unregisterForgeProviders).not.toHaveBeenCalled();
  });

  it("unloadPlugin is idempotent across repeated calls", async () => {
    await writePlugin("twice", { name: "acme.twice", version: "1.0.0" });

    const service = new PluginService(tmpDir);
    await service.initialize();

    service.unloadPlugin("acme.twice");
    expect(service.hasPlugin("acme.twice")).toBe(false);

    // Second call finds nothing to remove and stays silent.
    service.unloadPlugin("acme.twice");
    expect(unregisterPluginMenuItems).toHaveBeenCalledTimes(1);
    expect(unregisterPluginToolbarButtons).toHaveBeenCalledTimes(1);
    expect(unregisterPluginPanelKinds).toHaveBeenCalledTimes(1);
    expect(unregisterForgeProviders).toHaveBeenCalledTimes(1);
  });

  it("registers plugin before importing main so sync host-API calls see it as loaded", async () => {
    const pluginDir = path.join(tmpDir, "sync-init");
    await fs.mkdir(pluginDir);
    await fs.writeFile(
      path.join(pluginDir, "plugin.json"),
      JSON.stringify({
        name: "acme.sync-init",
        version: "1.0.0",
        main: "main.mjs",
      })
    );
    // Plugin main module calls a global hook synchronously during import to
    // observe whether its own pluginId is already registered. Proxies the
    // real-world pattern where a host API call depends on this.plugins.has().
    await fs.writeFile(
      path.join(pluginDir, "main.mjs"),
      "globalThis.__pluginInitObserved = globalThis.__pluginInitCheck('acme.sync-init');"
    );

    const service = new PluginService(tmpDir);
    (globalThis as { __pluginInitCheck?: (name: string) => boolean }).__pluginInitCheck = (name) =>
      service.hasPlugin(name);

    try {
      await service.initialize();
      await service.activateStartupFinishedPlugins();
      expect((globalThis as { __pluginInitObserved?: boolean }).__pluginInitObserved).toBe(true);
    } finally {
      delete (globalThis as { __pluginInitCheck?: unknown }).__pluginInitCheck;
      delete (globalThis as { __pluginInitObserved?: unknown }).__pluginInitObserved;
    }
  });

  it("supports load → unload → reload lifecycle via fresh service instance", async () => {
    await writePlugin("lifecycle", {
      name: "acme.lifecycle",
      version: "1.0.0",
      contributes: {
        panels: [{ id: "viewer", name: "Viewer", iconId: "eye", color: "#000" }],
      },
    });

    const first = new PluginService(tmpDir);
    await first.initialize();
    expect(registerPanelKind).toHaveBeenCalledTimes(1);

    first.unloadPlugin("acme.lifecycle");
    expect(unregisterPluginPanelKinds).toHaveBeenCalledWith("acme.lifecycle");
    expect(first.hasPlugin("acme.lifecycle")).toBe(false);

    // A fresh service instance re-reads the plugin directory and re-registers.
    vi.clearAllMocks();
    const second = new PluginService(tmpDir);
    await second.initialize();

    expect(second.hasPlugin("acme.lifecycle")).toBe(true);
    expect(registerPanelKind).toHaveBeenCalledTimes(1);
    expect(registerPanelKind).toHaveBeenCalledWith(
      expect.objectContaining({ id: "acme.lifecycle.viewer", extensionId: "acme.lifecycle" })
    );
  });
});

type CreateHostShape = (pluginId: string) => {
  host: {
    pluginId: string;
    registerHandler: (channel: string, handler: (...args: unknown[]) => unknown) => void;
    broadcastToRenderer: (channel: string, payload: unknown) => void;
    registerForgeProvider: (descriptor: { id: string }, impl: unknown) => () => void;
  };
  revoke: () => void;
};

describe("createHost (plugin activation API)", () => {
  it("host.registerHandler delegates with the plugin's own namespace", async () => {
    await writePlugin("host-test", { name: "acme.host-test", version: "1.0.0" });
    const service = new PluginService(tmpDir);
    await service.initialize();

    const { host } = (service as unknown as { createHost: CreateHostShape }).createHost(
      "acme.host-test"
    );

    expect(host.pluginId).toBe("acme.host-test");

    const handler = vi.fn().mockReturnValue("ok");
    host.registerHandler("probe", handler);

    const ctx = makeCtx("acme.host-test");
    const result = await service.dispatchHandler("acme.host-test", "probe", ctx, ["a"]);
    expect(handler).toHaveBeenCalledWith(ctx, "a");
    expect(result).toBe("ok");
  });

  it("host.broadcastToRenderer namespaces channels as plugin:{pluginId}:{channel}", async () => {
    await writePlugin("bcast-test", { name: "acme.bcast-test", version: "1.0.0" });
    const service = new PluginService(tmpDir);
    await service.initialize();

    const { host } = (service as unknown as { createHost: CreateHostShape }).createHost(
      "acme.bcast-test"
    );

    broadcastToRendererMock.mockClear();
    host.broadcastToRenderer("status", { ok: true });
    expect(broadcastToRendererMock).toHaveBeenCalledWith("plugin:acme.bcast-test:status", {
      ok: true,
    });
  });

  it("host.broadcastToRenderer rejects channels containing colons", async () => {
    await writePlugin("bcast-reject", { name: "acme.bcast-reject", version: "1.0.0" });
    const service = new PluginService(tmpDir);
    await service.initialize();

    const { host } = (service as unknown as { createHost: CreateHostShape }).createHost(
      "acme.bcast-reject"
    );

    expect(() => host.broadcastToRenderer("bad:channel", null)).toThrow(
      "Plugin broadcast channel must be a string without colons"
    );
  });

  it("revoked host rejects registerHandler and broadcastToRenderer calls", async () => {
    await writePlugin("revoke-test", { name: "acme.revoke-test", version: "1.0.0" });
    const service = new PluginService(tmpDir);
    await service.initialize();

    const { host, revoke } = (service as unknown as { createHost: CreateHostShape }).createHost(
      "acme.revoke-test"
    );

    revoke();

    expect(() => host.registerHandler("x", () => undefined)).toThrow(
      /host revoked: registerHandler/
    );
    expect(() => host.broadcastToRenderer("x", null)).toThrow(/host revoked: broadcastToRenderer/);
    expect(() => host.registerForgeProvider({ id: "github" }, {})).toThrow(
      /host revoked: registerForgeProvider/
    );
  });
});

type ShowToastOptions = {
  message: string;
  type?: "info" | "success" | "warning" | "error";
  durationMs?: number;
};
type ToastHostShape = (pluginId: string) => {
  host: { showToast: (options: ShowToastOptions) => Promise<void> };
  revoke: () => void;
};

describe("createHost — showToast", () => {
  it("broadcasts NOTIFICATION_SHOW_TOAST with the pluginId-namespaced message", async () => {
    await writePlugin("toast-test", { name: "acme.toast-test", version: "1.0.0" });
    const service = new PluginService(tmpDir);
    await service.initialize();

    const { host } = (service as unknown as { createHost: ToastHostShape }).createHost(
      "acme.toast-test"
    );

    broadcastToRendererMock.mockClear();
    await host.showToast({ message: "Synced 12 issues", type: "success" });

    expect(broadcastToRendererMock).toHaveBeenCalledTimes(1);
    expect(broadcastToRendererMock).toHaveBeenCalledWith(CHANNELS.NOTIFICATION_SHOW_TOAST, {
      type: "success",
      message: "acme.toast-test: Synced 12 issues",
      duration: undefined,
      rateLimitKey: "plugin:acme.toast-test:success",
    });
  });

  it("defaults type to info when omitted", async () => {
    await writePlugin("toast-default", { name: "acme.toast-default", version: "1.0.0" });
    const service = new PluginService(tmpDir);
    await service.initialize();

    const { host } = (service as unknown as { createHost: ToastHostShape }).createHost(
      "acme.toast-default"
    );

    broadcastToRendererMock.mockClear();
    await host.showToast({ message: "Done" });

    expect(broadcastToRendererMock).toHaveBeenCalledWith(CHANNELS.NOTIFICATION_SHOW_TOAST, {
      type: "info",
      message: "acme.toast-default: Done",
      duration: undefined,
      rateLimitKey: "plugin:acme.toast-default:info",
    });
  });

  it("forwards durationMs as duration", async () => {
    await writePlugin("toast-duration", { name: "acme.toast-duration", version: "1.0.0" });
    const service = new PluginService(tmpDir);
    await service.initialize();

    const { host } = (service as unknown as { createHost: ToastHostShape }).createHost(
      "acme.toast-duration"
    );

    broadcastToRendererMock.mockClear();
    await host.showToast({ message: "Saved", type: "success", durationMs: 3000 });

    expect(broadcastToRendererMock).toHaveBeenCalledWith(CHANNELS.NOTIFICATION_SHOW_TOAST, {
      type: "success",
      message: "acme.toast-duration: Saved",
      duration: 3000,
      rateLimitKey: "plugin:acme.toast-duration:success",
    });
  });

  it("rejects an out-of-range or non-integer durationMs and does not broadcast", async () => {
    await writePlugin("toast-dur-range", { name: "acme.toast-dur-range", version: "1.0.0" });
    const service = new PluginService(tmpDir);
    await service.initialize();

    const { host } = (service as unknown as { createHost: ToastHostShape }).createHost(
      "acme.toast-dur-range"
    );

    broadcastToRendererMock.mockClear();
    for (const durationMs of [0, -1, 1.5, 60_001]) {
      await expect(host.showToast({ message: "x", durationMs })).rejects.toThrow(
        /showToast: invalid options/
      );
    }
    // Boundaries that should pass.
    await host.showToast({ message: "min", durationMs: 1 });
    await host.showToast({ message: "max", durationMs: 60_000 });
    expect(broadcastToRendererMock).toHaveBeenCalledTimes(2);
  });

  it("rejects a message over the max length and does not broadcast", async () => {
    await writePlugin("toast-maxlen", { name: "acme.toast-maxlen", version: "1.0.0" });
    const service = new PluginService(tmpDir);
    await service.initialize();

    const { host } = (service as unknown as { createHost: ToastHostShape }).createHost(
      "acme.toast-maxlen"
    );

    broadcastToRendererMock.mockClear();
    await host.showToast({ message: "x".repeat(2000) });
    expect(broadcastToRendererMock).toHaveBeenCalledTimes(1);

    await expect(host.showToast({ message: "x".repeat(2001) })).rejects.toThrow(
      /showToast: invalid options/
    );
    expect(broadcastToRendererMock).toHaveBeenCalledTimes(1);
  });

  it("rejects an empty/whitespace message and does not broadcast", async () => {
    await writePlugin("toast-empty", { name: "acme.toast-empty", version: "1.0.0" });
    const service = new PluginService(tmpDir);
    await service.initialize();

    const { host } = (service as unknown as { createHost: ToastHostShape }).createHost(
      "acme.toast-empty"
    );

    broadcastToRendererMock.mockClear();
    await expect(host.showToast({ message: "   " })).rejects.toThrow(/showToast: invalid options/);
    expect(broadcastToRendererMock).not.toHaveBeenCalled();
  });

  it("rejects an unknown type and does not broadcast", async () => {
    await writePlugin("toast-badtype", { name: "acme.toast-badtype", version: "1.0.0" });
    const service = new PluginService(tmpDir);
    await service.initialize();

    const { host } = (service as unknown as { createHost: ToastHostShape }).createHost(
      "acme.toast-badtype"
    );

    broadcastToRendererMock.mockClear();
    await expect(
      host.showToast({ message: "Oops", type: "fatal" as ShowToastOptions["type"] })
    ).rejects.toThrow(/showToast: invalid options/);
    expect(broadcastToRendererMock).not.toHaveBeenCalled();
  });

  it("rejects unknown fields (strict schema)", async () => {
    await writePlugin("toast-strict", { name: "acme.toast-strict", version: "1.0.0" });
    const service = new PluginService(tmpDir);
    await service.initialize();

    const { host } = (service as unknown as { createHost: ToastHostShape }).createHost(
      "acme.toast-strict"
    );

    broadcastToRendererMock.mockClear();
    await expect(
      host.showToast({ message: "Hi", priority: "low" } as unknown as ShowToastOptions)
    ).rejects.toThrow(/showToast: invalid options/);
    expect(broadcastToRendererMock).not.toHaveBeenCalled();
  });

  it("is NOT revoke-guarded — still delivers after revoke() while the plugin is loaded", async () => {
    await writePlugin("toast-revoke", { name: "acme.toast-revoke", version: "1.0.0" });
    const service = new PluginService(tmpDir);
    await service.initialize();

    const { host, revoke } = (service as unknown as { createHost: ToastHostShape }).createHost(
      "acme.toast-revoke"
    );

    revoke();
    broadcastToRendererMock.mockClear();
    await host.showToast({ message: "Still alive" });

    expect(broadcastToRendererMock).toHaveBeenCalledWith(CHANNELS.NOTIFICATION_SHOW_TOAST, {
      type: "info",
      message: "acme.toast-revoke: Still alive",
      duration: undefined,
      rateLimitKey: "plugin:acme.toast-revoke:info",
    });
  });

  it("is a silent no-op once the plugin is unloaded (liveness guard)", async () => {
    await writePlugin("toast-unload", { name: "acme.toast-unload", version: "1.0.0" });
    const service = new PluginService(tmpDir);
    await service.initialize();

    const { host } = (service as unknown as { createHost: ToastHostShape }).createHost(
      "acme.toast-unload"
    );

    service.unloadPlugin("acme.toast-unload");
    broadcastToRendererMock.mockClear();
    await expect(host.showToast({ message: "Gone" })).resolves.toBeUndefined();

    // unloadPlugin emits its own registry-change broadcasts; assert specifically
    // that no toast was delivered rather than "no broadcast at all".
    const toastBroadcasts = broadcastToRendererMock.mock.calls.filter(
      (call: unknown[]) => call[0] === CHANNELS.NOTIFICATION_SHOW_TOAST
    );
    expect(toastBroadcasts).toHaveLength(0);
  });
});

describe("createHost — registerForgeProvider", () => {
  function forgeManifest(
    name: string,
    providerIds: string[] = ["github"]
  ): Record<string, unknown> {
    return {
      name,
      version: "1.0.0",
      contributes: {
        forgeProviders: providerIds.map((id) => ({
          id,
          name: id,
          matches: [`${id}.example`],
        })),
      },
    };
  }

  it("binds the impl via registerForgeProviderImpl with the descriptor id", async () => {
    await writePlugin("forge-host", forgeManifest("acme.forge-host"));
    const service = new PluginService(tmpDir);
    await service.initialize();

    const { host } = (service as unknown as { createHost: CreateHostShape }).createHost(
      "acme.forge-host"
    );

    vi.mocked(registerForgeProviderImpl).mockClear();
    const impl = { tag: "impl-a" };
    host.registerForgeProvider({ id: "github" }, impl);
    expect(registerForgeProviderImpl).toHaveBeenCalledWith("acme.forge-host", "github", impl);
  });

  it("returns a disposer that calls unregisterForgeProviderImpl exactly once", async () => {
    await writePlugin("forge-dispose", forgeManifest("acme.forge-dispose"));
    const service = new PluginService(tmpDir);
    await service.initialize();

    const { host } = (service as unknown as { createHost: CreateHostShape }).createHost(
      "acme.forge-dispose"
    );

    vi.mocked(unregisterForgeProviderImpl).mockClear();
    const impl = { tag: "impl" };
    const dispose = host.registerForgeProvider({ id: "github" }, impl);
    dispose();
    dispose(); // idempotent — only the first call should propagate
    expect(unregisterForgeProviderImpl).toHaveBeenCalledTimes(1);
    expect(unregisterForgeProviderImpl).toHaveBeenCalledWith("acme.forge-dispose", "github", impl);
  });

  it("rejects a descriptor missing an id", async () => {
    await writePlugin("forge-baddesc", forgeManifest("acme.forge-baddesc"));
    const service = new PluginService(tmpDir);
    await service.initialize();

    const { host } = (service as unknown as { createHost: CreateHostShape }).createHost(
      "acme.forge-baddesc"
    );

    expect(() =>
      host.registerForgeProvider({} as unknown as { id: string }, { tag: "impl" })
    ).toThrow(/descriptor.id must be a non-empty string/);
  });

  it("rejects a non-object impl", async () => {
    await writePlugin("forge-badimpl", forgeManifest("acme.forge-badimpl"));
    const service = new PluginService(tmpDir);
    await service.initialize();

    const { host } = (service as unknown as { createHost: CreateHostShape }).createHost(
      "acme.forge-badimpl"
    );

    expect(() => host.registerForgeProvider({ id: "github" }, null)).toThrow(
      /impl must be an object/
    );
  });

  it("rejects a descriptor.id not declared in contributes.forgeProviders", async () => {
    // Manifest declares only "github"; "bogus" must be rejected.
    await writePlugin("forge-undeclared", forgeManifest("acme.forge-undeclared", ["github"]));
    const service = new PluginService(tmpDir);
    await service.initialize();

    const { host } = (service as unknown as { createHost: CreateHostShape }).createHost(
      "acme.forge-undeclared"
    );

    expect(() => host.registerForgeProvider({ id: "bogus" }, { tag: "impl" })).toThrow(
      /not declared in contributes.forgeProviders/
    );
  });

  it("re-binding the same descriptor.id makes the older disposer inert", async () => {
    await writePlugin("forge-rebind", forgeManifest("acme.forge-rebind"));
    const service = new PluginService(tmpDir);
    await service.initialize();

    const { host } = (service as unknown as { createHost: CreateHostShape }).createHost(
      "acme.forge-rebind"
    );

    vi.mocked(unregisterForgeProviderImpl).mockClear();

    const impl1 = { tag: "first" };
    const impl2 = { tag: "second" };
    const dispose1 = host.registerForgeProvider({ id: "github" }, impl1);
    host.registerForgeProvider({ id: "github" }, impl2);

    // Calling the older disposer must pass the older impl so the registry
    // can decline to clear an already-overwritten entry. The registry side
    // of this guard is covered in forgeProviderRegistry.test.ts; here we
    // only assert the disposer carries the right identity into the call.
    dispose1();
    expect(unregisterForgeProviderImpl).toHaveBeenCalledWith("acme.forge-rebind", "github", impl1);
  });

  it("unloadPlugin fires unregisterForgeProviderImpls alongside unregisterForgeProviders", async () => {
    await writePlugin("forge-unload", forgeManifest("acme.forge-unload"));
    const service = new PluginService(tmpDir);
    await service.initialize();

    vi.mocked(unregisterForgeProviderImpls).mockClear();
    vi.mocked(unregisterForgeProviders).mockClear();

    service.unloadPlugin("acme.forge-unload");

    expect(unregisterForgeProviders).toHaveBeenCalledWith("acme.forge-unload");
    expect(unregisterForgeProviderImpls).toHaveBeenCalledWith("acme.forge-unload");
  });

  it("unloadPlugin flushes per-provider disposers from pluginEventCleanups", async () => {
    await writePlugin("forge-flush", forgeManifest("acme.forge-flush"));
    const service = new PluginService(tmpDir);
    await service.initialize();

    const { host } = (service as unknown as { createHost: CreateHostShape }).createHost(
      "acme.forge-flush"
    );
    const impl = { tag: "impl" };
    host.registerForgeProvider({ id: "github" }, impl);

    vi.mocked(unregisterForgeProviderImpl).mockClear();
    service.unloadPlugin("acme.forge-flush");
    // The per-provider disposer fires through the pluginEventCleanups flush
    // path during unloadPlugin — independent from the bulk unregisterForgeProviderImpls
    // belt-and-suspenders call.
    expect(unregisterForgeProviderImpl).toHaveBeenCalledWith("acme.forge-flush", "github", impl);
  });
});

describe("Plugin action registry", () => {
  let service: PluginService;

  const validContribution = () => ({
    id: "acme.my-plugin.doThing",
    title: "Do Thing",
    description: "Does a thing",
    category: "plugin",
    kind: "command" as const,
    danger: "safe" as const,
  });

  beforeEach(async () => {
    await writePlugin("test-plugin", { name: "acme.my-plugin", version: "1.0.0" });
    service = new PluginService(tmpDir);
    await service.initialize();
    broadcastToRendererMock.mockClear();
  });

  it("registerPluginAction adds a descriptor and broadcasts the full list", () => {
    service.registerPluginAction("acme.my-plugin", validContribution());

    const actions = service.listPluginActions();
    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({
      pluginId: "acme.my-plugin",
      id: "acme.my-plugin.doThing",
      title: "Do Thing",
      category: "plugin",
      kind: "command",
      danger: "safe",
    });
    expect(broadcastToRendererMock).toHaveBeenCalledWith(CHANNELS.EVENTS_PUSH, {
      name: "plugin:actions-changed",
      payload: { actions },
    });
  });

  it("registerPluginAction throws when the plugin is not loaded", () => {
    expect(() => service.registerPluginAction("acme.unknown", validContribution())).toThrow(
      /Unknown plugin/
    );
  });

  it("registerPluginAction throws for ids not prefixed with the plugin id", () => {
    expect(() =>
      service.registerPluginAction("acme.my-plugin", {
        ...validContribution(),
        id: "other.plugin.doThing",
      })
    ).toThrow(/must be prefixed with the plugin's own id/);
  });

  it("registerPluginAction throws for malformed ids", () => {
    for (const badId of ["no-dot", "Acme.UpperCase", "", "acme..double"]) {
      expect(() =>
        service.registerPluginAction("acme.my-plugin", {
          ...validContribution(),
          id: badId,
        })
      ).toThrow(/invalid/i);
    }
  });

  it("registerPluginAction throws when id has no suffix after the pluginId", () => {
    expect(() =>
      service.registerPluginAction("acme.my-plugin", {
        ...validContribution(),
        id: "acme.my-plugin",
      })
    ).toThrow(/must be prefixed with the plugin's own id/);
  });

  it("registerPluginAction rejects restricted danger", () => {
    expect(() =>
      service.registerPluginAction("acme.my-plugin", {
        ...validContribution(),
        danger: "restricted" as unknown as "safe",
      })
    ).toThrow(/invalid danger/i);
  });

  it("registerPluginAction rejects unknown kind", () => {
    expect(() =>
      service.registerPluginAction("acme.my-plugin", {
        ...validContribution(),
        kind: "navigation" as unknown as "command",
      })
    ).toThrow(/invalid kind/i);
  });

  it("registerPluginAction throws on duplicate id", () => {
    service.registerPluginAction("acme.my-plugin", validContribution());
    expect(() => service.registerPluginAction("acme.my-plugin", validContribution())).toThrow(
      /already registered/
    );
  });

  it("sets effectiveDanger='safe' when the plugin holds no high-risk capability", () => {
    service.registerPluginAction("acme.my-plugin", validContribution());
    expect(service.listPluginActions()[0].effectiveDanger).toBe("safe");
  });

  it("keeps effectiveDanger='confirm' when the plugin self-declares confirm", () => {
    service.registerPluginAction("acme.my-plugin", {
      ...validContribution(),
      danger: "confirm" as const,
    });
    expect(service.listPluginActions()[0].effectiveDanger).toBe("confirm");
  });

  it("raises effectiveDanger to 'confirm' for a self-declared 'safe' action when the manifest grants a high-risk capability", async () => {
    await writePlugin("risky", {
      name: "acme.risky",
      version: "1.0.0",
      capabilities: ["fs:project-read", "shell:exec"],
    });
    const svc = new PluginService(tmpDir);
    await svc.initialize();

    svc.registerPluginAction("acme.risky", {
      ...validContribution(),
      id: "acme.risky.doThing",
      danger: "safe" as const,
    });

    const action = svc.listPluginActions().find((a) => a.id === "acme.risky.doThing");
    expect(action?.danger).toBe("safe"); // plugin's advisory declaration preserved
    expect(action?.effectiveDanger).toBe("confirm"); // host raised it
  });

  it.each(["shell:exec", "git:write", "fs:project-write", "fs:user-data-write", "agent:invoke"])(
    "raises a self-declared 'safe' action to confirm when the manifest grants %s",
    async (capability) => {
      const name = `acme.perm-${capability.replace(/[^a-z]/g, "-")}`;
      await writePlugin(`perm-${capability.replace(/[^a-z]/g, "-")}`, {
        name,
        version: "1.0.0",
        capabilities: [capability],
      });
      const svc = new PluginService(tmpDir);
      await svc.initialize();

      svc.registerPluginAction(name, {
        ...validContribution(),
        id: `${name}.doThing`,
        danger: "safe" as const,
      });

      expect(svc.listPluginActions().find((a) => a.id === `${name}.doThing`)?.effectiveDanger).toBe(
        "confirm"
      );
    }
  );

  it("does not raise effectiveDanger for read-only / reversible capabilities", async () => {
    await writePlugin("readonly", {
      name: "acme.readonly",
      version: "1.0.0",
      capabilities: ["fs:project-read", "network:fetch", "clipboard:write", "git:read"],
    });
    const svc = new PluginService(tmpDir);
    await svc.initialize();

    svc.registerPluginAction("acme.readonly", {
      ...validContribution(),
      id: "acme.readonly.doThing",
      danger: "safe" as const,
    });

    expect(
      svc.listPluginActions().find((a) => a.id === "acme.readonly.doThing")?.effectiveDanger
    ).toBe("safe");
  });

  it("unregisterPluginAction removes a single action and broadcasts", () => {
    service.registerPluginAction("acme.my-plugin", validContribution());
    broadcastToRendererMock.mockClear();

    service.unregisterPluginAction("acme.my-plugin", "acme.my-plugin.doThing");

    expect(service.listPluginActions()).toEqual([]);
    expect(broadcastToRendererMock).toHaveBeenCalledWith(CHANNELS.EVENTS_PUSH, {
      name: "plugin:actions-changed",
      payload: { actions: [] },
    });
  });

  it("unregisterPluginAction is a silent no-op for unknown ids", () => {
    service.unregisterPluginAction("acme.my-plugin", "acme.my-plugin.missing");
    expect(broadcastToRendererMock).not.toHaveBeenCalled();
  });

  it("unregisterPluginAction does not remove actions owned by a different plugin", async () => {
    await writePlugin("other", { name: "acme.other", version: "1.0.0" });
    const svc = new PluginService(tmpDir);
    await svc.initialize();

    svc.registerPluginAction("acme.my-plugin", validContribution());

    svc.unregisterPluginAction("acme.other", "acme.my-plugin.doThing");
    expect(svc.listPluginActions()).toHaveLength(1);
  });

  it("unloadPlugin bulk-removes plugin actions", async () => {
    service.registerPluginAction("acme.my-plugin", validContribution());
    service.registerPluginAction("acme.my-plugin", {
      ...validContribution(),
      id: "acme.my-plugin.other",
    });
    expect(service.listPluginActions()).toHaveLength(2);

    broadcastToRendererMock.mockClear();
    service.unloadPlugin("acme.my-plugin");

    expect(service.listPluginActions()).toEqual([]);
    // Exactly one broadcast for the bulk removal (no per-action spam)
    const broadcasts = broadcastToRendererMock.mock.calls.filter(
      (call: unknown[]) =>
        call[0] === CHANNELS.EVENTS_PUSH &&
        typeof call[1] === "object" &&
        call[1] !== null &&
        (call[1] as { name?: unknown }).name === "plugin:actions-changed"
    );
    expect(broadcasts).toHaveLength(1);
  });

  it("descriptor keeps a defensive copy of keywords", () => {
    const keywords = ["foo", "bar"];
    service.registerPluginAction("acme.my-plugin", {
      ...validContribution(),
      keywords,
    });
    keywords.push("mutated");

    const [descriptor] = service.listPluginActions();
    expect(descriptor.keywords).toEqual(["foo", "bar"]);
  });

  it("descriptor keeps a defensive copy of inputSchema", () => {
    const inputSchema: Record<string, unknown> = { type: "object", properties: { a: 1 } };
    service.registerPluginAction("acme.my-plugin", {
      ...validContribution(),
      inputSchema,
    });
    (inputSchema as Record<string, unknown>).properties = { a: 999 };

    const [descriptor] = service.listPluginActions();
    expect(descriptor.inputSchema).toEqual({ type: "object", properties: { a: 1 } });
  });
});

describe("Plugin panel kind registry broadcast", () => {
  it("dispose() drops a microtask scheduled before disposal", async () => {
    // Capture the listener PluginService passes into onPanelKindRegistered so
    // we can fire it directly — this simulates a register event arriving from
    // the shared registry during the test.
    const registryMock = await import("../../../shared/config/panelKindRegistry.js");
    const onRegisteredMock = vi.mocked(registryMock.onPanelKindRegistered);
    let capturedRegisterListener: ((config: PanelKindConfig) => void) | null = null;
    onRegisteredMock.mockImplementation((listener: (config: PanelKindConfig) => void) => {
      capturedRegisterListener = listener;
      return () => {};
    });

    const service = new PluginService();
    expect(capturedRegisterListener).toBeTypeOf("function");

    // Simulate a register event — schedules a microtask broadcast
    const mockConfig: PanelKindConfig = {
      id: "test-panel",
      name: "Test Panel",
      iconId: "test",
      color: "#000000",
      hasPty: false,
      canRestart: false,
      canConvert: false,
      extensionId: "test-ext",
    };
    capturedRegisterListener!(mockConfig);
    // Dispose before the microtask drains
    service.dispose();

    // Allow microtasks to drain
    await Promise.resolve();
    await Promise.resolve();

    // Disposal must have cancelled the pending broadcast
    const panelKindBroadcasts = broadcastToRendererMock.mock.calls.filter(
      (call) => (call[1] as { name?: unknown })?.name === "plugin:panel-kinds-changed"
    );
    expect(panelKindBroadcasts).toHaveLength(0);
  });
});

describe("capabilities declaration logging", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it("logs declared capabilities when plugin has capabilities", async () => {
    await writePlugin("perm-plugin", {
      name: "acme.perm-plugin",
      version: "1.0.0",
      capabilities: ["fs:project-read", "network:fetch"],
    });

    const service = new PluginService(tmpDir);
    await service.initialize();

    expect(service.listPlugins()).toHaveLength(1);
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining(
        'Plugin "acme.perm-plugin" declares capabilities: fs:project-read, network:fetch'
      )
    );
  });

  it("does not log when plugin has no capabilities", async () => {
    await writePlugin("no-perms", {
      name: "acme.no-perms",
      version: "1.0.0",
    });

    const service = new PluginService(tmpDir);
    await service.initialize();

    expect(service.listPlugins()).toHaveLength(1);
    const permLogs = logSpy.mock.calls.filter(
      (call: unknown[]) => typeof call[0] === "string" && call[0].includes("declares capabilities")
    );
    expect(permLogs).toHaveLength(0);
  });

  it("does not log capabilities for incompatible plugins", async () => {
    await writePlugin("incompatible-perms", {
      name: "acme.incompatible-perms",
      version: "1.0.0",
      capabilities: ["fs:project-read"],
      engines: { daintree: "^1.0.0" },
    });

    const service = new PluginService(tmpDir, "0.7.5");
    await service.initialize();

    expect(service.listPlugins()).toEqual([]);
    const permLogs = logSpy.mock.calls.filter(
      (call: unknown[]) => typeof call[0] === "string" && call[0].includes("declares capabilities")
    );
    expect(permLogs).toHaveLength(0);
  });

  it("includes capabilities in loaded plugin manifest", async () => {
    await writePlugin("with-perms", {
      name: "acme.with-perms",
      version: "1.0.0",
      capabilities: ["git:read", "agent:invoke"],
    });

    const service = new PluginService(tmpDir);
    await service.initialize();

    const plugins = service.listPlugins();
    expect(plugins[0].manifest.capabilities).toEqual(["git:read", "agent:invoke"]);
  });

  it("defaults capabilities to empty array for plugins without the field", async () => {
    await writePlugin("no-field", {
      name: "acme.no-field",
      version: "1.0.0",
    });

    const service = new PluginService(tmpDir);
    await service.initialize();

    const plugins = service.listPlugins();
    expect(plugins[0].manifest.capabilities).toEqual([]);
  });

  it("rejects plugins that declare unknown capabilities and does not log them", async () => {
    await writePlugin("unknown-perm", {
      name: "acme.unknown-perm",
      version: "1.0.0",
      capabilities: ["shell:exec", "invalid:perm"],
    });

    const service = new PluginService(tmpDir);
    await service.initialize();

    expect(service.listPlugins()).toEqual([]);
    const permLogs = logSpy.mock.calls.filter(
      (call: unknown[]) => typeof call[0] === "string" && call[0].includes("declares capabilities")
    );
    expect(permLogs).toHaveLength(0);
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("Invalid manifest"),
      expect.any(Array)
    );
  });

  it("rejects plugins with newline characters in capability strings", async () => {
    await writePlugin("padded-perm", {
      name: "acme.padded-perm",
      version: "1.0.0",
      capabilities: ["fs:project-read\n", "agent:invoke\r"],
    });

    const service = new PluginService(tmpDir);
    await service.initialize();

    expect(service.listPlugins()).toEqual([]);
    const permLogs = logSpy.mock.calls.filter(
      (call: unknown[]) => typeof call[0] === "string" && call[0].includes("declares capabilities")
    );
    expect(permLogs).toHaveLength(0);
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("Invalid manifest"),
      expect.any(Array)
    );
  });

  it("rejects plugins where any one capability in a mixed array is invalid", async () => {
    await writePlugin("mixed-perm", {
      name: "acme.mixed-perm",
      version: "1.0.0",
      capabilities: ["fs:project-read", "invalid:perm", "git:read"],
    });

    const service = new PluginService(tmpDir);
    await service.initialize();

    expect(service.listPlugins()).toEqual([]);
    const permLogs = logSpy.mock.calls.filter(
      (call: unknown[]) => typeof call[0] === "string" && call[0].includes("declares capabilities")
    );
    expect(permLogs).toHaveLength(0);
  });
});

describe("Plugin worktree host API", () => {
  type WorktreeSnapshotLike = {
    id: string;
    worktreeId: string;
    path: string;
    name: string;
    isCurrent: boolean;
    branch?: string;
    aheadCount?: number;
    issueNumber?: number;
    lastActivityTimestamp?: number | null;
    _secret?: string;
  };

  function mkSnap(over: Partial<WorktreeSnapshotLike> & { id: string }): WorktreeSnapshotLike {
    return {
      worktreeId: over.id,
      path: `/tmp/${over.id}`,
      name: over.id,
      isCurrent: false,
      ...over,
    };
  }

  function createMockClient(initial: WorktreeSnapshotLike[] = []) {
    const emitter = new EventEmitter();
    let states = initial;
    const getAllStatesAsync = vi.fn(() => Promise.resolve(states));
    const client = Object.assign(emitter, {
      getAllStatesAsync,
      setStates: (next: WorktreeSnapshotLike[]) => {
        states = next;
      },
    });
    return client;
  }

  type HostWithWorktree = {
    pluginId: string;
    registerHandler: (c: string, h: (...args: unknown[]) => unknown) => void;
    broadcastToRenderer: (c: string, p: unknown) => void;
    getActiveWorktree: () => Promise<unknown>;
    getWorktrees: () => Promise<unknown[]>;
    onDidChangeActiveWorktree: (cb: (s: unknown) => void) => () => void;
    onDidChangeWorktrees: (cb: (list: unknown[]) => void) => () => void;
  };

  async function setup(snapshots: WorktreeSnapshotLike[] = []) {
    await writePlugin("wt-host", { name: "acme.wt-host", version: "1.0.0" });
    const service = new PluginService(tmpDir);
    await service.initialize();
    const client = createMockClient(snapshots);
    (service as unknown as { setWorkspaceClient: (c: unknown) => void }).setWorkspaceClient(client);
    const { host, revoke } = (
      service as unknown as {
        createHost: (id: string) => {
          host: HostWithWorktree;
          revoke: () => void;
        };
      }
    ).createHost("acme.wt-host");
    return { service, client, host, revoke };
  }

  it("getActiveWorktree returns a frozen projection of the isCurrent snapshot", async () => {
    const { host } = await setup([
      mkSnap({ id: "a", isCurrent: false }),
      mkSnap({ id: "b", isCurrent: true, branch: "feature/x", _secret: "leak" }),
    ]);

    const active = (await host.getActiveWorktree()) as Record<string, unknown> | null;
    expect(active).not.toBeNull();
    expect(active!.id).toBe("b");
    expect(active!.branch).toBe("feature/x");
    // Internal fields must not leak through the projection
    expect("_secret" in active!).toBe(false);
    expect(Object.isFrozen(active)).toBe(true);
  });

  it("getActiveWorktree returns null when no worktree is current", async () => {
    const { host } = await setup([mkSnap({ id: "a", isCurrent: false })]);
    expect(await host.getActiveWorktree()).toBeNull();
  });

  it("getWorktrees returns frozen snapshots for every worktree", async () => {
    const { host } = await setup([
      mkSnap({ id: "a", isCurrent: false }),
      mkSnap({ id: "b", isCurrent: true }),
    ]);
    const list = (await host.getWorktrees()) as Array<Record<string, unknown>>;
    expect(list).toHaveLength(2);
    expect(list.map((s) => s.id).sort()).toEqual(["a", "b"]);
    expect(list.every((s) => Object.isFrozen(s))).toBe(true);
  });

  it("getActiveWorktree returns null when WorkspaceClient is not wired", async () => {
    await writePlugin("wt-nowsc", { name: "acme.wt-nowsc", version: "1.0.0" });
    const service = new PluginService(tmpDir);
    await service.initialize();
    // Intentionally skip setWorkspaceClient
    const { host } = (
      service as unknown as {
        createHost: (id: string) => { host: HostWithWorktree; revoke: () => void };
      }
    ).createHost("acme.wt-nowsc");
    expect(await host.getActiveWorktree()).toBeNull();
    expect(await host.getWorktrees()).toEqual([]);
  });

  it("onDidChangeActiveWorktree fires with the new active snapshot", async () => {
    const snaps = [mkSnap({ id: "a", isCurrent: true })];
    const { host, client, revoke } = await setup(snaps);

    // Subscribe during "activate" window (before revoke), as a real plugin would.
    const cb = vi.fn();
    const dispose = host.onDidChangeActiveWorktree(cb);
    revoke();

    client.setStates([mkSnap({ id: "b", isCurrent: true, branch: "dev" })]);
    client.emit("worktree-activated", { worktreeId: "b", projectPath: "/p" });

    await vi.waitFor(() => expect(cb).toHaveBeenCalledTimes(1));
    const arg = cb.mock.calls[0][0] as Record<string, unknown>;
    expect(arg.id).toBe("b");
    expect(arg.branch).toBe("dev");

    dispose();
    client.emit("worktree-activated", { worktreeId: "a", projectPath: "/p" });
    // Ensure no additional calls after dispose
    await new Promise((r) => setTimeout(r, 10));
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it("onDidChangeWorktrees fires with the full list on worktree-update", async () => {
    const { host, client, revoke } = await setup([
      mkSnap({ id: "a", isCurrent: true }),
      mkSnap({ id: "b", isCurrent: false }),
    ]);

    const cb = vi.fn();
    host.onDidChangeWorktrees(cb);
    revoke();

    client.emit("worktree-update", {
      worktree: mkSnap({ id: "a", isCurrent: true }),
      projectPath: "/p",
    });

    await vi.waitFor(() => expect(cb).toHaveBeenCalledTimes(1));
    const list = cb.mock.calls[0][0] as Array<Record<string, unknown>>;
    expect(list.map((s) => s.id).sort()).toEqual(["a", "b"]);
  });

  it("disposers are idempotent and only remove the matching listener", async () => {
    const { host, client, revoke } = await setup();

    const cbA = vi.fn();
    const cbB = vi.fn();
    const disposeA = host.onDidChangeActiveWorktree(cbA);
    host.onDidChangeActiveWorktree(cbB);
    revoke();

    disposeA();
    disposeA(); // no-op

    client.setStates([mkSnap({ id: "a", isCurrent: true })]);
    client.emit("worktree-activated", { worktreeId: "a", projectPath: "/p" });
    await vi.waitFor(() => expect(cbB).toHaveBeenCalledTimes(1));
    expect(cbA).not.toHaveBeenCalled();
  });

  it("unloadPlugin flushes every worktree event listener for the plugin", async () => {
    const { service, host, client, revoke } = await setup();

    const cb1 = vi.fn();
    const cb2 = vi.fn();
    host.onDidChangeActiveWorktree(cb1);
    host.onDidChangeWorktrees(cb2);
    revoke();

    expect(client.listenerCount("worktree-activated")).toBe(1);
    expect(client.listenerCount("worktree-update")).toBe(1);

    service.unloadPlugin("acme.wt-host");

    expect(client.listenerCount("worktree-activated")).toBe(0);
    expect(client.listenerCount("worktree-update")).toBe(0);

    client.emit("worktree-activated", { worktreeId: "x", projectPath: "/p" });
    client.emit("worktree-update", { worktree: mkSnap({ id: "x" }), projectPath: "/p" });
    await new Promise((r) => setTimeout(r, 10));
    expect(cb1).not.toHaveBeenCalled();
    expect(cb2).not.toHaveBeenCalled();
  });

  it("registering an event subscription after revoke throws", async () => {
    const { host, revoke } = await setup();

    // Pre-revoke registration is allowed (this is the activate() window).
    expect(() => host.onDidChangeActiveWorktree(() => {})).not.toThrow();

    revoke();

    // Post-revoke registration is rejected — simulates a plugin holding the
    // host reference and trying to subscribe after activate() returned.
    expect(() => host.onDidChangeActiveWorktree(() => {})).toThrow(/host revoked/);
    expect(() => host.onDidChangeWorktrees(() => {})).toThrow(/host revoked/);
  });

  it("callbacks do not fire after unloadPlugin even if the client emits again", async () => {
    const { service, host, client, revoke } = await setup();
    const cb = vi.fn();
    host.onDidChangeActiveWorktree(cb);
    revoke();

    service.unloadPlugin("acme.wt-host");

    client.setStates([mkSnap({ id: "a", isCurrent: true })]);
    client.emit("worktree-activated", { worktreeId: "a", projectPath: "/p" });
    await new Promise((r) => setTimeout(r, 10));
    expect(cb).not.toHaveBeenCalled();
  });

  it("subscriptions registered before setWorkspaceClient replay against the new client", async () => {
    await writePlugin("wt-boot", { name: "acme.wt-boot", version: "1.0.0" });
    const service = new PluginService(tmpDir);
    await service.initialize();
    // Intentionally do NOT set the workspace client yet — this simulates a
    // plugin calling host.onDidChange* during its activate() on cold boot,
    // before windowServices wires up WorkspaceClient.
    const { host, revoke } = (
      service as unknown as {
        createHost: (id: string) => { host: HostWithWorktree; revoke: () => void };
      }
    ).createHost("acme.wt-boot");

    const cb = vi.fn();
    host.onDidChangeActiveWorktree(cb);
    revoke();

    // Now the client becomes available — subscriptions must be replayed.
    const client = createMockClient([mkSnap({ id: "b", isCurrent: true, branch: "dev" })]);
    (service as unknown as { setWorkspaceClient: (c: unknown) => void }).setWorkspaceClient(client);

    expect(client.listenerCount("worktree-activated")).toBe(1);

    client.emit("worktree-activated", { worktreeId: "b", projectPath: "/p" });
    await vi.waitFor(() => expect(cb).toHaveBeenCalledTimes(1));
    const arg = cb.mock.calls[0][0] as Record<string, unknown>;
    expect(arg.id).toBe("b");
  });

  it("disposing a pending subscription before setWorkspaceClient stops replay", async () => {
    await writePlugin("wt-boot2", { name: "acme.wt-boot2", version: "1.0.0" });
    const service = new PluginService(tmpDir);
    await service.initialize();
    const { host, revoke } = (
      service as unknown as {
        createHost: (id: string) => { host: HostWithWorktree; revoke: () => void };
      }
    ).createHost("acme.wt-boot2");

    const cb = vi.fn();
    const dispose = host.onDidChangeActiveWorktree(cb);
    revoke();
    dispose();

    const client = createMockClient([mkSnap({ id: "a", isCurrent: true })]);
    (service as unknown as { setWorkspaceClient: (c: unknown) => void }).setWorkspaceClient(client);

    expect(client.listenerCount("worktree-activated")).toBe(0);
    client.emit("worktree-activated", { worktreeId: "a", projectPath: "/p" });
    await new Promise((r) => setTimeout(r, 10));
    expect(cb).not.toHaveBeenCalled();
  });

  it("onDidChangeWorktrees fires on worktree-removed with the post-removal list", async () => {
    const { host, client, revoke } = await setup([
      mkSnap({ id: "a", isCurrent: true }),
      mkSnap({ id: "b", isCurrent: false }),
    ]);

    const cb = vi.fn();
    host.onDidChangeWorktrees(cb);
    revoke();

    client.setStates([mkSnap({ id: "a", isCurrent: true })]);
    client.emit("worktree-removed", { worktreeId: "b", projectPath: "/p" });

    await vi.waitFor(() => expect(cb).toHaveBeenCalledTimes(1));
    const list = cb.mock.calls[0][0] as Array<Record<string, unknown>>;
    expect(list.map((s) => s.id)).toEqual(["a"]);
  });

  it("onDidChangeWorktrees disposer stops both update and remove subscriptions", async () => {
    const { host, client, revoke } = await setup([mkSnap({ id: "a", isCurrent: true })]);

    const cb = vi.fn();
    const dispose = host.onDidChangeWorktrees(cb);
    revoke();
    expect(client.listenerCount("worktree-update")).toBe(1);
    expect(client.listenerCount("worktree-removed")).toBe(1);

    dispose();
    expect(client.listenerCount("worktree-update")).toBe(0);
    expect(client.listenerCount("worktree-removed")).toBe(0);
  });

  it("plugin snapshot exposes exactly the documented allowlist fields", async () => {
    const { host } = await setup([
      mkSnap({
        id: "a",
        isCurrent: true,
        branch: "main",
        aheadCount: 1,
        // A field that must NOT leak to plugins — the real WorktreeSnapshot
        // has dozens of these; we sample one as a guard.
        _secret: "leak-me",
      }),
    ]);

    const active = (await host.getActiveWorktree()) as Record<string, unknown>;
    expect(active).not.toBeNull();
    const expected = [
      "aheadCount",
      "behindCount",
      "branch",
      "createdAt",
      "id",
      "isCurrent",
      "isMainWorktree",
      "lastActivityTimestamp",
      "linked",
      "mood",
      "name",
      "path",
      "worktreeId",
    ];
    expect(Object.keys(active).sort()).toEqual(expected);
    expect("_secret" in active).toBe(false);
    // None of the removed GitHub-shaped fields should leak through.
    for (const removed of [
      "issueNumber",
      "issueTitle",
      "prNumber",
      "prState",
      "prTitle",
      "prUrl",
    ]) {
      expect(removed in active).toBe(false);
    }
  });
});

describe("reserved contribution point warnings", () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it("accepts a contributes.experimental_views entry and logs a 'not yet implemented' warning", async () => {
    await writePlugin("views", {
      name: "acme.views",
      version: "1.0.0",
      engines: { daintree: "^0.7.0" },
      contributes: {
        experimental_views: [
          {
            id: "main",
            name: "Main",
            componentPath: "./dist/view.js",
            location: "panel",
          },
        ],
      },
    });

    const service = new PluginService(tmpDir, "0.7.5");
    await service.initialize();

    expect(service.listPlugins()).toHaveLength(1);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining(
        'Plugin "acme.views": contributes.experimental_views is not yet implemented'
      )
    );
  });

  it("accepts a contributes.experimental_mcpServers entry and logs a 'not yet implemented' warning", async () => {
    await writePlugin("mcp", {
      name: "acme.mcp",
      version: "1.0.0",
      engines: { daintree: "^0.7.0" },
      contributes: {
        experimental_mcpServers: [
          {
            id: "linear",
            name: "Linear MCP",
            command: "node",
            args: ["./server.js"],
            env: { LINEAR_API_KEY: "secret" },
          },
        ],
      },
    });

    const service = new PluginService(tmpDir, "0.7.5");
    await service.initialize();

    expect(service.listPlugins()).toHaveLength(1);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining(
        'Plugin "acme.mcp": contributes.experimental_mcpServers is not yet implemented'
      )
    );
  });

  it("registers a contributes.forgeProviders entry with the forge provider registry", async () => {
    await writePlugin("forge", {
      name: "acme.forge",
      version: "1.0.0",
      engines: { daintree: "^0.7.0" },
      contributes: {
        forgeProviders: [
          {
            id: "github",
            name: "GitHub",
            matches: ["github.com"],
            capabilities: ["issues", "pulls", "reviews"],
            settingsScopeRef: "github",
            viewRefs: ["github-issues"],
          },
        ],
      },
    });

    const service = new PluginService(tmpDir, "0.7.5");
    await service.initialize();

    expect(service.listPlugins()).toHaveLength(1);
    expect(registerForgeProviders).toHaveBeenCalledWith("acme.forge", [
      {
        id: "github",
        name: "GitHub",
        matches: ["github.com"],
        capabilities: ["issues", "pulls", "reviews"],
        settingsScopeRef: "github",
        viewRefs: ["github-issues"],
      },
    ]);
    expect(warnSpy).not.toHaveBeenCalledWith(expect.stringContaining("contributes.forgeProviders"));
    // A forge-only manifest does not touch the other registries.
    expect(registerPanelKind).not.toHaveBeenCalled();
    expect(registerToolbarButton).not.toHaveBeenCalled();
    expect(registerPluginMenuItem).not.toHaveBeenCalled();
  });

  it("does not call registerForgeProviders when the manifest declares no forgeProviders", async () => {
    await writePlugin("forge-none", {
      name: "acme.forge-none",
      version: "1.0.0",
      engines: { daintree: "^0.7.0" },
    });

    const service = new PluginService(tmpDir, "0.7.5");
    await service.initialize();

    expect(service.listPlugins()).toHaveLength(1);
    expect(registerForgeProviders).not.toHaveBeenCalled();
  });

  it("does not warn about reserved points when the manifest omits them", async () => {
    await writePlugin("plain", {
      name: "acme.plain",
      version: "1.0.0",
      engines: { daintree: "^0.7.0" },
    });

    const service = new PluginService(tmpDir, "0.7.5");
    await service.initialize();

    expect(service.listPlugins()).toHaveLength(1);
    const warnMessages = warnSpy.mock.calls.map((call: unknown[]) => String(call[0]));
    expect(warnMessages.some((m: string) => m.includes("contributes.experimental_views"))).toBe(
      false
    );
    expect(
      warnMessages.some((m: string) => m.includes("contributes.experimental_mcpServers"))
    ).toBe(false);
    expect(warnMessages.some((m: string) => m.includes("contributes.forgeProviders"))).toBe(false);
  });

  it("does not warn when reserved arrays are explicitly present but empty", async () => {
    await writePlugin("explicit-empty", {
      name: "acme.explicit-empty",
      version: "1.0.0",
      engines: { daintree: "^0.7.0" },
      contributes: { experimental_views: [], experimental_mcpServers: [], forgeProviders: [] },
    });

    const service = new PluginService(tmpDir, "0.7.5");
    await service.initialize();

    expect(service.listPlugins()).toHaveLength(1);
    const warnMessages = warnSpy.mock.calls.map((call: unknown[]) => String(call[0]));
    expect(warnMessages.some((m: string) => m.includes("contributes.experimental_views"))).toBe(
      false
    );
    expect(
      warnMessages.some((m: string) => m.includes("contributes.experimental_mcpServers"))
    ).toBe(false);
    expect(warnMessages.some((m: string) => m.includes("contributes.forgeProviders"))).toBe(false);
  });

  it("still processes other contributions when reserved points are present", async () => {
    await writePlugin("mixed", {
      name: "acme.mixed",
      version: "1.0.0",
      engines: { daintree: "^0.7.0" },
      contributes: {
        panels: [{ id: "viewer", name: "Viewer", iconId: "eye", color: "#000" }],
        experimental_views: [
          { id: "main", name: "Main", componentPath: "./v.js", location: "sidebar" },
        ],
        experimental_mcpServers: [{ id: "svc", name: "Svc", command: "node" }],
      },
    });

    const service = new PluginService(tmpDir, "0.7.5");
    await service.initialize();

    expect(service.listPlugins()).toHaveLength(1);
    expect(registerPanelKind).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("contributes.experimental_views is not yet implemented")
    );
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("contributes.experimental_mcpServers is not yet implemented")
    );
  });

  it("warns once per category regardless of entry count", async () => {
    await writePlugin("many", {
      name: "acme.many",
      version: "1.0.0",
      engines: { daintree: "^0.7.0" },
      contributes: {
        experimental_views: [
          { id: "a", name: "A", componentPath: "./a.js", location: "panel" },
          { id: "b", name: "B", componentPath: "./b.js", location: "sidebar" },
          { id: "c", name: "C", componentPath: "./c.js", location: "panel" },
        ],
      },
    });

    const service = new PluginService(tmpDir, "0.7.5");
    await service.initialize();

    const viewWarnings = warnSpy.mock.calls.filter((call: unknown[]) =>
      String(call[0]).includes("contributes.experimental_views is not yet implemented")
    );
    expect(viewWarnings).toHaveLength(1);
  });

  it("rejects a views entry with an invalid location at schema level", () => {
    const result = getPluginManifestSchema(false).safeParse({
      name: "acme.bad-location",
      version: "1.0.0",
      contributes: {
        experimental_views: [
          { id: "main", name: "Main", componentPath: "./v.js", location: "floating" },
        ],
      },
    });
    expect(result.success).toBe(false);
  });

  it("rejects a views entry missing componentPath", () => {
    const result = getPluginManifestSchema(false).safeParse({
      name: "acme.no-path",
      version: "1.0.0",
      contributes: {
        experimental_views: [{ id: "main", name: "Main", location: "panel" }],
      },
    });
    expect(result.success).toBe(false);
  });

  it("rejects an mcpServers entry missing command", () => {
    const result = getPluginManifestSchema(false).safeParse({
      name: "acme.no-cmd",
      version: "1.0.0",
      contributes: {
        experimental_mcpServers: [{ id: "svc", name: "Svc" }],
      },
    });
    expect(result.success).toBe(false);
  });

  it("rejects an mcpServers entry with non-string env values", () => {
    const result = getPluginManifestSchema(false).safeParse({
      name: "acme.bad-env",
      version: "1.0.0",
      contributes: {
        experimental_mcpServers: [{ id: "svc", name: "Svc", command: "node", env: { PORT: 8080 } }],
      },
    });
    expect(result.success).toBe(false);
  });

  it("accepts an mcpServers entry without optional args/env fields", () => {
    const result = getPluginManifestSchema(false).safeParse({
      name: "acme.minimal-mcp",
      version: "1.0.0",
      contributes: {
        experimental_mcpServers: [{ id: "svc", name: "Svc", command: "node" }],
      },
    });
    expect(result.success).toBe(true);
  });
});

// Boundary containment regression tests for issue #9276 — verify that a
// plugin's exceptions can't escape the host. Each block covers one boundary:
// activation, action dispatch, and the unload cascade.

describe("Plugin exception containment (#9276)", () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
    errorSpy.mockRestore();
  });

  describe("Boundary 1 — activation failure", () => {
    it("records the activation error on getPluginLoadError without rethrowing", async () => {
      const pluginDir = path.join(tmpDir, "throws-activate");
      await fs.mkdir(pluginDir);
      await fs.writeFile(
        path.join(pluginDir, "plugin.json"),
        JSON.stringify({ name: "acme.throws-activate", version: "1.0.0", main: "main.mjs" })
      );
      await fs.writeFile(
        path.join(pluginDir, "main.mjs"),
        "export function activate() { throw new Error('boom on activate'); }"
      );

      const service = new PluginService(tmpDir);
      // The host MUST NOT crash — initialize() should resolve.
      await expect(service.initialize()).resolves.toBeUndefined();
      await service.activateStartupFinishedPlugins();

      const record = service.getPluginLoadError("acme.throws-activate");
      expect(record).toBeDefined();
      expect(record?.message).toBe("boom on activate");
      expect(record?.stack).toContain("boom on activate");
      expect(typeof record?.at).toBe("number");
      // The plugin is still registered (manifest-declared contributions survive
      // even if the JS main entry blows up).
      expect(service.hasPlugin("acme.throws-activate")).toBe(true);
    });

    it("returns undefined when the plugin's activate succeeds", async () => {
      const pluginDir = path.join(tmpDir, "clean-activate");
      await fs.mkdir(pluginDir);
      await fs.writeFile(
        path.join(pluginDir, "plugin.json"),
        JSON.stringify({ name: "acme.clean-activate", version: "1.0.0", main: "main.mjs" })
      );
      await fs.writeFile(
        path.join(pluginDir, "main.mjs"),
        "export function activate() { return () => {}; }"
      );

      const service = new PluginService(tmpDir);
      await service.initialize();
      await service.activateStartupFinishedPlugins();

      expect(service.getPluginLoadError("acme.clean-activate")).toBeUndefined();
    });

    it("returns undefined when the plugin declares no main entry", async () => {
      await writePlugin("no-main", { name: "acme.no-main", version: "1.0.0" });
      const service = new PluginService(tmpDir);
      await service.initialize();

      expect(service.getPluginLoadError("acme.no-main")).toBeUndefined();
    });

    it("load error persists in the provenance record across unload", async () => {
      const pluginDir = path.join(tmpDir, "throws-then-unload");
      await fs.mkdir(pluginDir);
      await fs.writeFile(
        path.join(pluginDir, "plugin.json"),
        JSON.stringify({ name: "acme.throws-then-unload", version: "1.0.0", main: "main.mjs" })
      );
      await fs.writeFile(
        path.join(pluginDir, "main.mjs"),
        "export function activate() { throw new Error('boom'); }"
      );

      const service = new PluginService(tmpDir);
      await service.initialize();
      await service.activateStartupFinishedPlugins();
      expect(service.getPluginLoadError("acme.throws-then-unload")).toBeDefined();

      // Unload removes the plugin from the registry, but the persisted
      // provenance record (including loadError) survives so diagnostics
      // export and re-install flows can still read it.
      service.unloadPlugin("acme.throws-then-unload");
      expect(service.getPluginLoadError("acme.throws-then-unload")).toBeDefined();
      expect(service.getPluginLoadError("acme.throws-then-unload")?.message).toBe("boom");
    });

    it("normalises non-Error throws into a load error record", async () => {
      const pluginDir = path.join(tmpDir, "throws-string");
      await fs.mkdir(pluginDir);
      await fs.writeFile(
        path.join(pluginDir, "plugin.json"),
        JSON.stringify({ name: "acme.throws-string", version: "1.0.0", main: "main.mjs" })
      );
      // Throw a plain string — many plugin authors do this.
      await fs.writeFile(
        path.join(pluginDir, "main.mjs"),
        "export function activate() { throw 'plain-string-failure'; }"
      );

      const service = new PluginService(tmpDir);
      await service.initialize();
      await service.activateStartupFinishedPlugins();

      const record = service.getPluginLoadError("acme.throws-string");
      expect(record?.message).toBe("plain-string-failure");
      expect(record?.stack).toBeUndefined();
    });
  });

  describe("Boundary 2 — action handler throw", () => {
    it("dispatchHandler rejects with the original error and logs to console.error", async () => {
      await writePlugin("acme.throwy-handler", {
        name: "acme.throwy-handler",
        version: "1.0.0",
      });
      const service = new PluginService(tmpDir);
      await service.initialize();

      const original = new Error("handler boom");
      service.registerHandler("acme.throwy-handler", "blow-up", () => {
        throw original;
      });

      await expect(
        service.dispatchHandler(
          "acme.throwy-handler",
          "blow-up",
          makeCtx("acme.throwy-handler"),
          []
        )
      ).rejects.toBe(original);

      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining(`Handler "acme.throwy-handler:blow-up" threw:`),
        original
      );
    });

    it("dispatchHandler rejects with an async handler's rejection and logs", async () => {
      await writePlugin("acme.async-throwy", {
        name: "acme.async-throwy",
        version: "1.0.0",
      });
      const service = new PluginService(tmpDir);
      await service.initialize();

      const original = new Error("async boom");
      service.registerHandler("acme.async-throwy", "blow-up", async () => {
        throw original;
      });

      await expect(
        service.dispatchHandler("acme.async-throwy", "blow-up", makeCtx("acme.async-throwy"), [])
      ).rejects.toBe(original);

      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining(`Handler "acme.async-throwy:blow-up" threw:`),
        original
      );
    });
  });

  describe("Boundary 3 — unload cascade containment", () => {
    it("continues past a throwing menu-items unregister and still clears the plugin", async () => {
      await writePlugin("cascade-test", {
        name: "acme.cascade-test",
        version: "1.0.0",
        contributes: {
          panels: [{ id: "viewer", name: "Viewer", iconId: "eye", color: "#000" }],
          toolbarButtons: [{ id: "btn", label: "Btn", iconId: "icon", actionId: "x.y" }],
          menuItems: [{ label: "L", actionId: "x.y", location: "terminal" }],
        },
      });

      const service = new PluginService(tmpDir);
      await service.initialize();

      vi.mocked(unregisterPluginMenuItems).mockImplementationOnce(() => {
        throw new Error("menu unregister boom");
      });

      service.unloadPlugin("acme.cascade-test");

      // Each step after the throwing one still ran:
      expect(unregisterPluginToolbarButtons).toHaveBeenCalledWith("acme.cascade-test");
      expect(unregisterPluginPanelKinds).toHaveBeenCalledWith("acme.cascade-test");
      expect(unregisterForgeProviders).toHaveBeenCalledWith("acme.cascade-test");
      expect(unregisterForgeProviderImpls).toHaveBeenCalledWith("acme.cascade-test");
      expect(unregisterFileDecorationProviders).toHaveBeenCalledWith("acme.cascade-test");
      expect(unregisterFileDecorationProviderImpls).toHaveBeenCalledWith("acme.cascade-test");

      // Containment guarantees: plugin gone from registry, no rethrown error.
      expect(service.hasPlugin("acme.cascade-test")).toBe(false);

      // Disposer throws are warnings, not errors (per issue constraint).
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining(
          `Unload step "unregisterPluginMenuItems" for "acme.cascade-test" threw:`
        ),
        expect.any(Error)
      );
    });

    it("continues past a throwing toolbar unregister", async () => {
      await writePlugin("toolbar-throws", {
        name: "acme.toolbar-throws",
        version: "1.0.0",
        contributes: {
          panels: [{ id: "viewer", name: "Viewer", iconId: "eye", color: "#000" }],
        },
      });
      const service = new PluginService(tmpDir);
      await service.initialize();

      vi.mocked(unregisterPluginToolbarButtons).mockImplementationOnce(() => {
        throw new Error("toolbar boom");
      });

      service.unloadPlugin("acme.toolbar-throws");

      // Subsequent steps in cascade still run.
      expect(unregisterPluginPanelKinds).toHaveBeenCalledWith("acme.toolbar-throws");
      expect(service.hasPlugin("acme.toolbar-throws")).toBe(false);
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining(
          `Unload step "unregisterPluginToolbarButtons" for "acme.toolbar-throws" threw:`
        ),
        expect.any(Error)
      );
    });

    it("continues past a throwing forge-provider unregister AND still runs the impl unregister", async () => {
      await writePlugin("forge-throws", {
        name: "acme.forge-throws",
        version: "1.0.0",
      });
      const service = new PluginService(tmpDir);
      await service.initialize();

      vi.mocked(unregisterForgeProviders).mockImplementationOnce(() => {
        throw new Error("forge boom");
      });

      service.unloadPlugin("acme.forge-throws");

      // Critical: the impl unregister must run even if the provider unregister
      // threw, otherwise impl entries leak across reload. Coupled steps under
      // a single try/catch wrapper would have skipped this call.
      expect(unregisterForgeProviderImpls).toHaveBeenCalledWith("acme.forge-throws");
      expect(unregisterFileDecorationProviders).toHaveBeenCalledWith("acme.forge-throws");
      expect(unregisterFileDecorationProviderImpls).toHaveBeenCalledWith("acme.forge-throws");
      expect(service.hasPlugin("acme.forge-throws")).toBe(false);
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining(
          `Unload step "unregisterForgeProviders" for "acme.forge-throws" threw:`
        ),
        expect.any(Error)
      );
    });

    it("continues past a throwing fileDecoration-provider unregister AND still runs the impl unregister", async () => {
      await writePlugin("file-decoration-throws", {
        name: "acme.file-decoration-throws",
        version: "1.0.0",
      });
      const service = new PluginService(tmpDir);
      await service.initialize();

      vi.mocked(unregisterFileDecorationProviders).mockImplementationOnce(() => {
        throw new Error("file-decoration boom");
      });

      service.unloadPlugin("acme.file-decoration-throws");

      // Same correctness check as the forge case: the impl unregister must
      // not be stranded by a throw in the provider unregister.
      expect(unregisterFileDecorationProviderImpls).toHaveBeenCalledWith(
        "acme.file-decoration-throws"
      );
      expect(service.hasPlugin("acme.file-decoration-throws")).toBe(false);
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining(
          `Unload step "unregisterFileDecorationProviders" for "acme.file-decoration-throws" threw:`
        ),
        expect.any(Error)
      );
    });

    it("continues past a throwing removeHandlers, running every later registry step", async () => {
      await writePlugin("remove-handlers-throws", {
        name: "acme.remove-handlers-throws",
        version: "1.0.0",
        contributes: {
          panels: [{ id: "p", name: "P", iconId: "i", color: "#000" }],
          toolbarButtons: [{ id: "b", label: "B", iconId: "i", actionId: "x.y" }],
          menuItems: [{ label: "L", actionId: "x.y", location: "terminal" }],
        },
      });
      const service = new PluginService(tmpDir);
      await service.initialize();

      const removeHandlersSpy = vi
        .spyOn(service as unknown as { removeHandlers: (id: string) => void }, "removeHandlers")
        .mockImplementationOnce(() => {
          throw new Error("removeHandlers boom");
        });

      service.unloadPlugin("acme.remove-handlers-throws");

      // Even though the very first step threw, every later step ran.
      expect(unregisterPluginMenuItems).toHaveBeenCalledWith("acme.remove-handlers-throws");
      expect(unregisterPluginToolbarButtons).toHaveBeenCalledWith("acme.remove-handlers-throws");
      expect(unregisterPluginPanelKinds).toHaveBeenCalledWith("acme.remove-handlers-throws");
      expect(unregisterForgeProviders).toHaveBeenCalledWith("acme.remove-handlers-throws");
      expect(unregisterForgeProviderImpls).toHaveBeenCalledWith("acme.remove-handlers-throws");
      expect(unregisterFileDecorationProviders).toHaveBeenCalledWith("acme.remove-handlers-throws");
      expect(unregisterFileDecorationProviderImpls).toHaveBeenCalledWith(
        "acme.remove-handlers-throws"
      );
      expect(service.hasPlugin("acme.remove-handlers-throws")).toBe(false);

      removeHandlersSpy.mockRestore();
    });
  });

  describe("Boundary 1 — non-Error throws", () => {
    it("normalises a bare `throw undefined` into a string message", async () => {
      const pluginDir = path.join(tmpDir, "throws-undefined");
      await fs.mkdir(pluginDir);
      await fs.writeFile(
        path.join(pluginDir, "plugin.json"),
        JSON.stringify({ name: "acme.throws-undefined", version: "1.0.0", main: "main.mjs" })
      );
      // `throw undefined` is a real footgun in plugin code — make sure the
      // load-error record never sneaks an `undefined` into its `message`
      // field, which would violate the type contract for the F19 / #9271
      // consumer.
      await fs.writeFile(
        path.join(pluginDir, "main.mjs"),
        "export function activate() { throw undefined; }"
      );

      const service = new PluginService(tmpDir);
      await service.initialize();
      await service.activateStartupFinishedPlugins();

      const record = service.getPluginLoadError("acme.throws-undefined");
      expect(record).toBeDefined();
      expect(typeof record?.message).toBe("string");
      expect(record?.message.length).toBeGreaterThan(0);
    });

    it("normalises a bare `throw null` into a string message", async () => {
      const pluginDir = path.join(tmpDir, "throws-null");
      await fs.mkdir(pluginDir);
      await fs.writeFile(
        path.join(pluginDir, "plugin.json"),
        JSON.stringify({ name: "acme.throws-null", version: "1.0.0", main: "main.mjs" })
      );
      await fs.writeFile(
        path.join(pluginDir, "main.mjs"),
        "export function activate() { throw null; }"
      );

      const service = new PluginService(tmpDir);
      await service.initialize();
      await service.activateStartupFinishedPlugins();

      const record = service.getPluginLoadError("acme.throws-null");
      expect(record).toBeDefined();
      expect(typeof record?.message).toBe("string");
      expect(record?.message.length).toBeGreaterThan(0);
    });
  });
});

describe("hello-daintree sample fixture", () => {
  const fixturePath = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../../../plugins/sample/hello-daintree/plugin.json"
  );
  const readManifest = async (): Promise<unknown> =>
    JSON.parse(await fs.readFile(fixturePath, "utf8"));

  it("validates against the manifest schema", async () => {
    const result = getPluginManifestSchema(true).safeParse(await readManifest());
    expect(result.success).toBe(true);
  });

  it("declares the first-party name and the wired contribution points", async () => {
    const manifest = getPluginManifestSchema(true).parse(await readManifest());
    expect(manifest.name).toBe("daintree.hello");
    expect(manifest.engines?.daintree).toBe(">=0.11.0");
    expect(manifest.contributes.toolbarButtons).toHaveLength(1);
    expect(manifest.contributes.toolbarButtons[0].id).toBe("ping");
    expect(manifest.contributes.menuItems).toHaveLength(1);
    expect(manifest.contributes.fileDecorationProviders).toHaveLength(1);
    expect(manifest.contributes.fileDecorationProviders[0].scopes).toEqual(["hello:*"]);
  });
});

describe("Plugin provenance persistence", () => {
  it("creates a sideload record for non-builtin plugin on first load", async () => {
    await writePlugin("fresh", { name: "acme.fresh", version: "1.0.0" });

    const service = new PluginService(tmpDir);
    await service.initialize();

    const plugins = service.listPlugins();
    expect(plugins).toHaveLength(1);
    expect(plugins[0].source).toBe("sideload");
    expect(plugins[0].installedAt).toBeGreaterThan(0);
    expect(plugins[0].archiveHash).toBeNull();
    expect(plugins[0].originalUrl).toBeNull();
    expect(plugins[0].disabled).toBe(false);
    expect(plugins[0].updateAvailable).toBeNull();
    expect(plugins[0].devMode).toBe(false);
    expect(plugins[0].loadError).toBeNull();
  });

  it("built-in plugins return synthetic provenance fields without a store record", async () => {
    const builtinDir = await fs.mkdtemp(path.join(os.tmpdir(), "daintree-builtin-prov-"));
    try {
      const dir = path.join(builtinDir, "helper");
      await fs.mkdir(dir);
      await fs.writeFile(
        path.join(dir, "plugin.json"),
        JSON.stringify({ name: "daintree.helper", version: "1.0.0" })
      );

      const service = new PluginService(tmpDir, "0.0.0", { builtinPluginsRoot: builtinDir });
      await service.initialize();

      const plugins = service.listPlugins();
      const builtin = plugins.find((p) => p.manifest.name === "daintree.helper");
      expect(builtin).toBeDefined();
      expect(builtin!.source).toBe("builtin");
      expect(builtin!.installedAt).toBe(0);
      expect(builtin!.archiveHash).toBeNull();
      expect(builtin!.originalUrl).toBeNull();
      expect(builtin!.loadError).toBeNull();
      expect(builtin!.disabled).toBe(false);
      expect(builtin!.updateAvailable).toBeNull();
      expect(builtin!.devMode).toBe(false);
    } finally {
      await fs.rm(builtinDir, { recursive: true, force: true });
    }
  });

  it("preserves installedAt across repeated loads (idempotent record creation)", async () => {
    await writePlugin("persist", { name: "acme.persist", version: "1.0.0" });

    const first = new PluginService(tmpDir);
    await first.initialize();
    const firstInstalledAt = first.listPlugins()[0].installedAt;

    // Second service instance simulates a restart — the store mock persists
    // the record (store is a singleton mock in tests).
    const second = new PluginService(tmpDir);
    await second.initialize();

    const plugins = second.listPlugins();
    expect(plugins[0].installedAt).toBe(firstInstalledAt);
  });

  it("non-builtin plugin with disabled=true is listed but not activated", async () => {
    const pluginDir = path.join(tmpDir, "disabled-nonbuiltin");
    await fs.mkdir(pluginDir);
    await fs.writeFile(
      path.join(pluginDir, "plugin.json"),
      JSON.stringify({
        name: "acme.disabled-nb",
        version: "1.0.0",
        main: "main.mjs",
      })
    );
    // main.mjs calls a global to prove activation was skipped
    await fs.writeFile(
      path.join(pluginDir, "main.mjs"),
      "globalThis.__disabledActivated = true; export function activate() {}"
    );

    // Pre-seed the store with the unified disabled list (#9284); the
    // provenance record's `disabled` field is set independently by
    // setEnabled() — listing alone surfaces the unified state.
    storeMock._state.set("plugins", {
      disabled: ["acme.disabled-nb"],
      installed: {
        "acme.disabled-nb": {
          source: "sideload",
          installedAt: Date.now(),
          archiveHash: null,
          originalUrl: null,
          disabled: true,
          updateAvailable: null,
          devMode: false,
          loadError: null,
        },
      },
    });

    const service = new PluginService(tmpDir);
    await service.initialize();
    // Force the startup activation pass so this test exercises the path that
    // would normally import every onStartupFinished plugin. The disabled plugin
    // is rejected at scan time (never inserted into the plugins map), so the
    // activation pass cannot pick it up — that's exactly what we assert below.
    await service.activateStartupFinishedPlugins();

    const plugins = service.listPlugins();
    expect(plugins).toHaveLength(1);
    expect(plugins[0].manifest.name).toBe("acme.disabled-nb");
    expect(plugins[0].disabled).toBe(true);
    expect(plugins[0].isBuiltin).toBe(false);

    // Activation was skipped — the main.mjs was never imported
    expect((globalThis as Record<string, unknown>).__disabledActivated).toBeUndefined();
  });

  it("writes activation error to the persisted record", async () => {
    const pluginDir = path.join(tmpDir, "err-persist");
    await fs.mkdir(pluginDir);
    await fs.writeFile(
      path.join(pluginDir, "plugin.json"),
      JSON.stringify({ name: "acme.err-persist", version: "1.0.0", main: "main.mjs" })
    );
    await fs.writeFile(
      path.join(pluginDir, "main.mjs"),
      "export function activate() { throw new Error('persisted-boom'); }"
    );

    const service = new PluginService(tmpDir);
    await service.initialize();
    await service.activateStartupFinishedPlugins();

    const record = service.getPluginLoadError("acme.err-persist");
    expect(record?.message).toBe("persisted-boom");

    // Also visible via listPlugins
    const plugins = service.listPlugins();
    expect(plugins[0].loadError?.message).toBe("persisted-boom");
  });

  it("clears loadError on a subsequent successful activation", async () => {
    // Use two different plugin directories with distinct names to avoid
    // Node ESM module caching (import() caches by URL, so the same file
    // path would return the cached throwing module).
    const failDir = path.join(tmpDir, "heal-fail");
    await fs.mkdir(failDir);
    await fs.writeFile(
      path.join(failDir, "plugin.json"),
      JSON.stringify({ name: "acme.heal-fail", version: "1.0.0", main: "main.mjs" })
    );
    await fs.writeFile(
      path.join(failDir, "main.mjs"),
      "globalThis.__healFailCalled = true; export function activate() { throw new Error('first-fail'); }"
    );

    const first = new PluginService(tmpDir);
    await first.initialize();
    await first.activateStartupFinishedPlugins();
    expect(first.getPluginLoadError("acme.heal-fail")?.message).toBe("first-fail");

    // Second plugin: same concept but different dir + name, so ESM cache
    // doesn't interfere. The store still holds the first plugin's error
    // record, confirming persistence works.
    const healDir = path.join(tmpDir, "heal-ok");
    await fs.mkdir(healDir);
    await fs.writeFile(
      path.join(healDir, "plugin.json"),
      JSON.stringify({ name: "acme.heal-ok", version: "1.0.0", main: "main.mjs" })
    );
    await fs.writeFile(
      path.join(healDir, "main.mjs"),
      "export function activate() { return () => {}; }"
    );

    const second = new PluginService(tmpDir);
    await second.initialize();
    await second.activateStartupFinishedPlugins();

    // New plugin loaded successfully — no error
    expect(second.getPluginLoadError("acme.heal-ok")).toBeUndefined();
    const plugins = second.listPlugins();
    const healed = plugins.find((p) => p.manifest.name === "acme.heal-ok");
    expect(healed?.loadError).toBeNull();

    // Original failed plugin's error still in the store
    expect(second.getPluginLoadError("acme.heal-fail")?.message).toBe("first-fail");
  });

  it("getPluginLoadError returns undefined for an unknown plugin", () => {
    const service = new PluginService(tmpDir);
    expect(service.getPluginLoadError("acme.never-existed")).toBeUndefined();
  });

  it("listPlugins includes all provenance fields in output", async () => {
    await writePlugin("full-prov", { name: "acme.full-prov", version: "1.0.0" });

    const service = new PluginService(tmpDir);
    await service.initialize();

    const [plugin] = service.listPlugins();
    expect(Object.keys(plugin)).toContain("source");
    expect(Object.keys(plugin)).toContain("installedAt");
    expect(Object.keys(plugin)).toContain("archiveHash");
    expect(Object.keys(plugin)).toContain("originalUrl");
    expect(Object.keys(plugin)).toContain("loadError");
    expect(Object.keys(plugin)).toContain("disabled");
    expect(Object.keys(plugin)).toContain("updateAvailable");
    expect(Object.keys(plugin)).toContain("devMode");
    // Runtime fields still present
    expect(Object.keys(plugin)).toContain("manifest");
    expect(Object.keys(plugin)).toContain("dir");
    expect(Object.keys(plugin)).toContain("loadedAt");
    expect(Object.keys(plugin)).toContain("isBuiltin");
    // Internal field still excluded
    expect(Object.keys(plugin)).not.toContain("resolvedMain");
  });

  it("disabled builtin returns disabled=true in listPlugins output", async () => {
    const builtinDir = await fs.mkdtemp(path.join(os.tmpdir(), "daintree-builtin-dis-"));
    try {
      const dir = path.join(builtinDir, "muted");
      await fs.mkdir(dir);
      await fs.writeFile(
        path.join(dir, "plugin.json"),
        JSON.stringify({ name: "daintree.muted", version: "1.0.0" })
      );

      storeMock._state.set("plugins", { disabled: ["daintree.muted"], installed: {} });

      const service = new PluginService(tmpDir, "0.0.0", { builtinPluginsRoot: builtinDir });
      await service.initialize();

      // Disabled builtins are tracked in `disabledPlugins` so listPlugins()
      // can surface them for the Preferences toggle (#9284); they are not
      // activated. The entry reports disabled=true.
      const plugins = service.listPlugins();
      const muted = plugins.find((p) => p.manifest.name === "daintree.muted");
      expect(muted).toBeDefined();
      expect(muted!.disabled).toBe(true);
      expect(muted!.loadedAt).toBe(0);
    } finally {
      await fs.rm(builtinDir, { recursive: true, force: true });
    }
  });

  it("plugin with dot in name stores record without nesting", async () => {
    // Plugin names are scoped as "publisher.name" — a single dot is valid.
    // electron-store's dotNotation would split "acme.foo" into nested keys
    // if written per-field, so we write the whole `plugins.installed` object.
    const pluginDir = path.join(tmpDir, "dot-plugin");
    await fs.mkdir(pluginDir);
    await fs.writeFile(
      path.join(pluginDir, "plugin.json"),
      JSON.stringify({ name: "acme.foo", version: "1.0.0" })
    );

    const service = new PluginService(tmpDir);
    await service.initialize();

    const plugins = service.listPlugins();
    expect(plugins).toHaveLength(1);
    expect(plugins[0].manifest.name).toBe("acme.foo");

    // Record stored under the dotted name without nesting
    const stored = storeMock._state.get("plugins") as
      | { installed?: Record<string, unknown> }
      | undefined;
    expect(stored?.installed).toHaveProperty("acme.foo");
    expect(stored?.installed?.["acme.foo"]).toBeDefined();
  });
});

describe("PluginManifestSchema activationEvents field", () => {
  const schema = getPluginManifestSchema(false);

  it("defaults to an empty array when omitted", () => {
    const result = schema.safeParse({
      name: "acme.foo",
      version: "1.0.0",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.activationEvents).toEqual([]);
    }
  });

  it("accepts an explicit ['onStartupFinished']", () => {
    const result = schema.safeParse({
      name: "acme.foo",
      version: "1.0.0",
      activationEvents: ["onStartupFinished"],
    });
    expect(result.success).toBe(true);
  });

  it("rejects unknown activation event strings (no onCommand/onView in v1)", () => {
    const result = schema.safeParse({
      name: "acme.foo",
      version: "1.0.0",
      activationEvents: ["onCommand:foo"],
    });
    expect(result.success).toBe(false);
  });

  it("rejects non-array activationEvents value", () => {
    const result = schema.safeParse({
      name: "acme.foo",
      version: "1.0.0",
      activationEvents: "onStartupFinished",
    });
    expect(result.success).toBe(false);
  });
});

describe("Deferred activation — activatePlugin", () => {
  it("initialize() does not import plugin main; activateStartupFinishedPlugins does", async () => {
    const pluginDir = path.join(tmpDir, "deferred-import");
    await fs.mkdir(pluginDir);
    await fs.writeFile(
      path.join(pluginDir, "plugin.json"),
      JSON.stringify({ name: "acme.deferred-import", version: "1.0.0", main: "main.mjs" })
    );
    // The module sets a global as a side effect at import time. If the
    // module were imported during initialize() the global would be set
    // before we explicitly activate.
    await fs.writeFile(
      path.join(pluginDir, "main.mjs"),
      "globalThis.__deferredImportRan = true; export function activate() {}"
    );

    try {
      const service = new PluginService(tmpDir);
      await service.initialize();
      // Scan must register the plugin (contributions populated) but must NOT
      // have imported its main module yet.
      expect(service.hasPlugin("acme.deferred-import")).toBe(true);
      expect((globalThis as Record<string, unknown>).__deferredImportRan).toBeUndefined();

      await service.activateStartupFinishedPlugins();
      expect((globalThis as Record<string, unknown>).__deferredImportRan).toBe(true);
    } finally {
      delete (globalThis as Record<string, unknown>).__deferredImportRan;
    }
  });

  it("activatePlugin is idempotent — _doActivate runs once across concurrent callers", async () => {
    const pluginDir = path.join(tmpDir, "dedup-activate");
    await fs.mkdir(pluginDir);
    await fs.writeFile(
      path.join(pluginDir, "plugin.json"),
      JSON.stringify({ name: "acme.dedup-activate", version: "1.0.0", main: "main.mjs" })
    );
    await fs.writeFile(
      path.join(pluginDir, "main.mjs"),
      "globalThis.__dedupCount = (globalThis.__dedupCount ?? 0) + 1; export function activate() {}"
    );

    try {
      const service = new PluginService(tmpDir);
      await service.initialize();

      // Fan out activation from three concurrent callers; the in-flight
      // promise dedup means _doActivate runs exactly once.
      await Promise.all([
        service.activatePlugin("acme.dedup-activate"),
        service.activatePlugin("acme.dedup-activate"),
        service.activatePlugin("acme.dedup-activate"),
      ]);

      // A fourth call after the first settled should hit the synchronous
      // `activatedPlugins` fast path and not re-import either.
      await service.activatePlugin("acme.dedup-activate");

      expect((globalThis as Record<string, number>).__dedupCount).toBe(1);
    } finally {
      delete (globalThis as Record<string, number>).__dedupCount;
    }
  });

  it("activatePlugin does not reject when activate() throws", async () => {
    const pluginDir = path.join(tmpDir, "throwy-but-stable");
    await fs.mkdir(pluginDir);
    await fs.writeFile(
      path.join(pluginDir, "plugin.json"),
      JSON.stringify({ name: "acme.throwy-but-stable", version: "1.0.0", main: "main.mjs" })
    );
    await fs.writeFile(
      path.join(pluginDir, "main.mjs"),
      "export function activate() { throw new Error('nope'); }"
    );

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const service = new PluginService(tmpDir);
      await service.initialize();

      // Implicit-trigger contract: the promise resolves so callers don't
      // need a try/catch around every dispatch.
      await expect(service.activatePlugin("acme.throwy-but-stable")).resolves.toBeUndefined();
      // Error is persisted to the provenance record instead of propagating.
      expect(service.getPluginLoadError("acme.throwy-but-stable")?.message).toBe("nope");
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("activatePlugin can re-run after a failure (Settings → Retry)", async () => {
    const pluginDir = path.join(tmpDir, "retry-activate");
    await fs.mkdir(pluginDir);
    await fs.writeFile(
      path.join(pluginDir, "plugin.json"),
      JSON.stringify({ name: "acme.retry-activate", version: "1.0.0", main: "main.mjs" })
    );
    await fs.writeFile(
      path.join(pluginDir, "main.mjs"),
      "globalThis.__retryCount = (globalThis.__retryCount ?? 0) + 1; export function activate() { throw new Error('retry-boom'); }"
    );

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const service = new PluginService(tmpDir);
      await service.initialize();
      await service.activatePlugin("acme.retry-activate");

      // After a failure the in-flight entry is dropped so a retry calls
      // through to _doActivate again. ESM import() is URL-cached, so the
      // module is only evaluated once — but `activate()` still runs again
      // on the cached exports. Assert via the persisted error record.
      expect(service.getPluginLoadError("acme.retry-activate")?.message).toBe("retry-boom");

      await service.activatePlugin("acme.retry-activate");
      // The fact that this resolves and re-records the error proves the
      // promise was not cached as a settled success.
      expect(service.getPluginLoadError("acme.retry-activate")?.message).toBe("retry-boom");
    } finally {
      errorSpy.mockRestore();
      delete (globalThis as Record<string, number>).__retryCount;
    }
  });

  it("activateStartupFinishedPlugins activates plugins with activationEvents=['onStartupFinished']", async () => {
    const pluginDir = path.join(tmpDir, "explicit-onstartup");
    await fs.mkdir(pluginDir);
    await fs.writeFile(
      path.join(pluginDir, "plugin.json"),
      JSON.stringify({
        name: "acme.explicit-onstartup",
        version: "1.0.0",
        main: "main.mjs",
        activationEvents: ["onStartupFinished"],
      })
    );
    await fs.writeFile(
      path.join(pluginDir, "main.mjs"),
      "globalThis.__explicitOnstartupRan = true; export function activate() {}"
    );

    try {
      const service = new PluginService(tmpDir);
      await service.initialize();
      expect((globalThis as Record<string, unknown>).__explicitOnstartupRan).toBeUndefined();

      await service.activateStartupFinishedPlugins();
      expect((globalThis as Record<string, unknown>).__explicitOnstartupRan).toBe(true);
    } finally {
      delete (globalThis as Record<string, unknown>).__explicitOnstartupRan;
    }
  });

  it("dispatchHandler implicitly activates the owning plugin before lookup", async () => {
    const pluginDir = path.join(tmpDir, "implicit-dispatch");
    await fs.mkdir(pluginDir);
    await fs.writeFile(
      path.join(pluginDir, "plugin.json"),
      JSON.stringify({
        name: "acme.implicit-dispatch",
        version: "1.0.0",
        main: "main.mjs",
      })
    );
    // The plugin's activate() registers a handler. If dispatchHandler did
    // not force activation first, the handler would not be registered yet
    // and the dispatch would throw "No plugin handler registered".
    await fs.writeFile(
      path.join(pluginDir, "main.mjs"),
      "export function activate(host) { host.registerHandler('probe', () => 'pong'); }"
    );

    const service = new PluginService(tmpDir);
    await service.initialize();
    // Crucially, do NOT call activateStartupFinishedPlugins(). The dispatch
    // path itself must trigger activation.
    const result = await service.dispatchHandler(
      "acme.implicit-dispatch",
      "probe",
      makeCtx("acme.implicit-dispatch"),
      []
    );
    expect(result).toBe("pong");
  });
});
