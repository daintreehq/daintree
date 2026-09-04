import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const senderEvent = { sender: { id: 1 } };

let projectRoot: string;
let pluginsRoot: string;

const mockGetProjectById = vi.fn();
const mockGetPluginsRoot = vi.fn<() => string>();

vi.mock("../../../services/PluginService.js", () => ({
  pluginService: {
    getPluginsRoot: () => mockGetPluginsRoot(),
    waitForInit: vi.fn().mockResolvedValue(undefined),
    listPlugins: vi.fn().mockReturnValue([]),
    listProjectPlugins: vi.fn().mockReturnValue([]),
  },
}));

vi.mock("../../../services/ProjectStore.js", () => ({
  projectStore: {
    getProjectById: (...args: unknown[]) => mockGetProjectById(...args),
  },
}));

vi.mock("../../../window/webContentsRegistry.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getProjectForWebContents: () => "project-1",
  getWindowForWebContents: () => null,
  isCachedViewWebContents: () => false,
}));

const mockIpcMainHandle = vi.fn();
vi.mock("electron", () => ({
  ipcMain: {
    handle: (...args: unknown[]) => mockIpcMainHandle(...args),
    removeHandler: vi.fn(),
  },
  dialog: { showOpenDialog: vi.fn() },
  BrowserWindow: { getFocusedWindow: () => null },
  net: { fetch: vi.fn() },
}));

import { registerPluginHandlers } from "../plugin.js";
import { _resetIpcGuardForTesting, markIpcSecurityReady } from "../../ipcGuard.js";

const VALID_MANIFEST = {
  name: "acme.demo",
  version: "1.0.0",
  scope: "project",
  displayName: "Demo",
  main: "dist/index.mjs",
  engines: { daintree: ">=0.11.0" },
  capabilities: [],
  contributes: {
    panels: [{ id: "main", name: "Demo", iconId: "gauge", color: "var(--theme-category-orange)" }],
    views: [{ id: "main", componentPath: "dist/panel.js", location: "panel" }],
  },
};

function getValidateManifestHandler() {
  registerPluginHandlers();
  const call = mockIpcMainHandle.mock.calls.find(
    (c: unknown[]) => c[0] === "plugin:validate-manifest"
  );
  if (!call) throw new Error("plugin:validate-manifest was never registered");
  return call[1] as (event: unknown, targetPath: string) => Promise<unknown>;
}

async function writePluginDir(relativeDir: string, manifest: unknown): Promise<string> {
  const dir = path.join(projectRoot, relativeDir);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, "plugin.json"), JSON.stringify(manifest), "utf8");
  return dir;
}

beforeEach(async () => {
  vi.clearAllMocks();
  projectRoot = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "daintree-validate-ipc-"))
  );
  pluginsRoot = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "daintree-plugins-root-"))
  );
  mockGetPluginsRoot.mockReturnValue(pluginsRoot);
  mockGetProjectById.mockReturnValue({ id: "project-1", path: projectRoot });
  _resetIpcGuardForTesting();
  markIpcSecurityReady();
});

afterEach(async () => {
  await fs.rm(projectRoot, { recursive: true, force: true });
  await fs.rm(pluginsRoot, { recursive: true, force: true });
});

describe("plugin:validate-manifest", () => {
  it("accepts a well-formed project plugin and reports the origin as a fact", async () => {
    await writePluginDir(".daintree/plugins/acme.demo", VALID_MANIFEST);
    const handler = getValidateManifestHandler();

    const result = (await handler(senderEvent, ".daintree/plugins/acme.demo")) as {
      ok: boolean;
      origin: string;
      originSource: string;
      pluginId: string | null;
      errors: unknown[];
    };

    expect(result.ok).toBe(true);
    expect(result.origin).toBe("project");
    expect(result.originSource).toBe("location");
    expect(result.pluginId).toBe("acme.demo");
    expect(result.errors).toEqual([]);
  });

  it("accepts the manifest file itself, not only its directory", async () => {
    await writePluginDir(".daintree/plugins/acme.demo", VALID_MANIFEST);
    const handler = getValidateManifestHandler();

    const result = (await handler(senderEvent, ".daintree/plugins/acme.demo/plugin.json")) as {
      ok: boolean;
      manifestPath: string;
    };

    expect(result.ok).toBe(true);
    expect(result.manifestPath.endsWith("plugin.json")).toBe(true);
  });

  it("returns the field path for each schema rejection", async () => {
    await writePluginDir(".daintree/plugins/acme.demo", {
      ...VALID_MANIFEST,
      contributes: {
        ...VALID_MANIFEST.contributes,
        panels: [{ id: "main", name: "Demo", iconId: "gauge" }],
      },
    });
    const handler = getValidateManifestHandler();

    const result = (await handler(senderEvent, ".daintree/plugins/acme.demo")) as {
      ok: boolean;
      errors: Array<{ path: string; message: string }>;
    };

    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.path.includes("color"))).toBe(true);
  });

  it("holds a manifest outside any discovery root to the origin it claims", async () => {
    await writePluginDir("src/draft-plugin", VALID_MANIFEST);
    const handler = getValidateManifestHandler();

    const result = (await handler(senderEvent, "src/draft-plugin")) as {
      origin: string;
      originSource: string;
      ok: boolean;
    };

    expect(result.origin).toBe("project");
    expect(result.originSource).toBe("declared-scope");
    expect(result.ok).toBe(true);
  });

  it("refuses a path outside the project and the managed plugins directory", async () => {
    const handler = getValidateManifestHandler();
    await expect(handler(senderEvent, path.join(os.tmpdir(), "somewhere-else"))).rejects.toThrow(
      /outside this project/
    );
  });

  it("refuses a traversal that escapes the project root", async () => {
    const handler = getValidateManifestHandler();
    await expect(handler(senderEvent, "../../etc")).rejects.toThrow(/outside this project/);
  });

  it("refuses a symlink whose spelling is inside the project but resolves outside", async () => {
    const outside = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), "daintree-outside-"))
    );
    await fs.writeFile(path.join(outside, "plugin.json"), JSON.stringify(VALID_MANIFEST), "utf8");
    const linkDir = path.join(projectRoot, ".daintree", "plugins");
    await fs.mkdir(linkDir, { recursive: true });
    await fs.symlink(outside, path.join(linkDir, "acme.escape"), "dir");
    const handler = getValidateManifestHandler();

    await expect(handler(senderEvent, ".daintree/plugins/acme.escape")).rejects.toThrow(
      /outside this project/
    );
    await fs.rm(outside, { recursive: true, force: true });
  });

  it("throws rather than reporting a verdict when no manifest is there", async () => {
    const handler = getValidateManifestHandler();
    await expect(handler(senderEvent, ".daintree/plugins/missing")).rejects.toThrow(
      /no readable plugin\.json/
    );
  });

  it("reports unparseable JSON as a rejection, not a thrown error", async () => {
    const dir = path.join(projectRoot, ".daintree/plugins/acme.demo");
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "plugin.json"), "{ not json", "utf8");
    const handler = getValidateManifestHandler();

    const result = (await handler(senderEvent, ".daintree/plugins/acme.demo")) as {
      ok: boolean;
      errors: Array<{ path: string }>;
    };

    expect(result.ok).toBe(false);
    expect(result.errors[0].path).toBe("(root)");
  });

  it("carries advisory warnings alongside a passing verdict", async () => {
    await writePluginDir(".daintree/plugins/acme.demo", {
      ...VALID_MANIFEST,
      contributes: {
        ...VALID_MANIFEST.contributes,
        panels: [
          {
            id: "main",
            name: "Demo",
            iconId: "not-a-real-icon",
            color: "var(--theme-category-orange)",
          },
        ],
      },
    });
    const handler = getValidateManifestHandler();

    const result = (await handler(senderEvent, ".daintree/plugins/acme.demo")) as {
      ok: boolean;
      warnings: string[];
    };

    expect(result.ok).toBe(true);
    expect(result.warnings.some((w) => w.includes("not-a-real-icon"))).toBe(true);
  });

  it("rejects an empty path outright", async () => {
    const handler = getValidateManifestHandler();
    await expect(handler(senderEvent, "   ")).rejects.toThrow(/non-empty string/);
  });
});
