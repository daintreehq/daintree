// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

vi.mock("electron", () => ({
  app: {
    getPath: vi.fn((key: string) => `/mock/electron/${key}`),
    getVersion: vi.fn(() => "0.15.0"),
  },
  ipcMain: { handle: vi.fn(), removeHandler: vi.fn() },
  // unloadPlugin broadcasts plugin-agent changes to all renderers; without a
  // BrowserWindow stub that path throws asynchronously after the test ends.
  BrowserWindow: { getAllWindows: vi.fn(() => []) },
  webContents: { getAllWebContents: vi.fn(() => []) },
}));

vi.mock("../ProjectStore.js", () => ({
  projectStore: {
    getAllProjects: vi.fn(() => []),
    getCurrentProjectId: vi.fn(() => null),
  },
}));

const broadcastToRenderer = vi.hoisted(() => vi.fn());
vi.mock("../../ipc/utils.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../ipc/utils.js")>()),
  broadcastToRenderer,
}));

import { PluginService } from "../PluginService.js";
import type {
  PluginHostApi,
  PluginManifest,
  PluginTaskSnapshot,
} from "../../../shared/types/plugin.js";

let svc: PluginService;
let baseDir: string;

function registerPlugin(): PluginHostApi {
  const seam = svc as unknown as {
    _registerFakePluginForTests(p: {
      manifest: PluginManifest;
      dir: string;
      loadedAt: number;
      isBuiltin: boolean;
    }): void;
    _createHostForTests(id: string): PluginHostApi;
  };
  seam._registerFakePluginForTests({
    manifest: {
      name: "acme.importer",
      displayName: "Acme Importer",
      version: "1.0.0",
      capabilities: [],
      contributes: { fileDecorationProviders: [], forgeProviders: [] },
    } as unknown as PluginManifest,
    dir: baseDir,
    loadedAt: 0,
    isBuiltin: false,
  });
  return seam._createHostForTests("acme.importer");
}

/** The task list the views were last sent for the plugin. */
function lastPushedTasks(): PluginTaskSnapshot[] | undefined {
  const pushes = broadcastToRenderer.mock.calls
    .map((call) => call[1] as { name?: string; payload?: unknown })
    .filter((event) => event?.name === "plugin:tasks-changed")
    .map((event) => event.payload as { pluginId: string; tasks: PluginTaskSnapshot[] })
    .filter((payload) => payload.pluginId === "acme.importer");
  return pushes.at(-1)?.tasks;
}

const RETRY = { actionId: "acme.importer.run" };

beforeEach(() => {
  broadcastToRenderer.mockClear();
  baseDir = mkdtempSync(join(tmpdir(), "plugin-tasks-"));
  const pluginsRoot = join(baseDir, "plugins");
  mkdirSync(pluginsRoot, { recursive: true });
  svc = new PluginService(pluginsRoot);
});

afterEach(() => {
  svc.dispose();
  rmSync(baseDir, { recursive: true, force: true });
});

describe("PluginService plugin tasks (#13819)", () => {
  it("pushes a started task to every view, named for the plugin", async () => {
    const host = registerPlugin();
    const task = await host.tasks.start({ title: "Importing records", retry: RETRY });

    expect(lastPushedTasks()).toMatchObject([
      { id: task.id, pluginName: "Acme Importer", title: "Importing records", state: "working" },
    ]);
  });

  it("marks a running task interrupted when the plugin unloads, until the user dismisses it", async () => {
    const host = registerPlugin();
    const task = await host.tasks.start({ title: "Importing records", retry: RETRY });

    svc.unloadPlugin("acme.importer");

    expect(task.signal.aborted).toBe(true);
    expect(lastPushedTasks()).toMatchObject([
      { id: task.id, pluginName: "Acme Importer", state: "interrupted" },
    ]);
    expect(svc.cancelPluginTask("acme.importer", task.id)).toBe(false);
    expect(svc.dismissPluginTask("acme.importer", task.id)).toBe(true);
    expect(lastPushedTasks()).toEqual([]);
  });

  it("aborts a cancellable task's signal on the user's Cancel", async () => {
    const host = registerPlugin();
    const task = await host.tasks.start({ title: "Sync", cancellable: true, retry: RETRY });

    expect(svc.cancelPluginTask("acme.importer", task.id)).toBe(true);
    expect(task.signal.aborted).toBe(true);
    expect(lastPushedTasks()).toMatchObject([{ id: task.id, state: "cancelling" }]);
    expect(svc.dismissPluginTask("acme.importer", task.id)).toBe(false);
  });
});

describe("PluginService project plugin work (#14093)", () => {
  function registerInstance(instanceKey: string, name: string): PluginHostApi {
    const seam = svc as unknown as {
      _registerFakePluginForTests(
        p: { manifest: PluginManifest; dir: string; loadedAt: number; isBuiltin: boolean },
        instanceKey?: string
      ): void;
      _createHostForTests(id: string): PluginHostApi;
    };
    seam._registerFakePluginForTests(
      {
        manifest: {
          name,
          displayName: name,
          version: "1.0.0",
          capabilities: [],
          contributes: { fileDecorationProviders: [], forgeProviders: [] },
        } as unknown as PluginManifest,
        dir: baseDir,
        loadedAt: 0,
        isBuiltin: false,
      },
      instanceKey
    );
    return seam._createHostForTests(instanceKey);
  }

  it("collects every instance the project owns and nothing another project or an app-global plugin runs", async () => {
    const importer = registerInstance("project__p1__acme.importer", "acme.importer");
    const linter = registerInstance("project__p1__acme.linter", "acme.linter");
    const otherProject = registerInstance("project__p2__acme.importer", "acme.importer");
    const appGlobal = registerInstance("acme.global", "acme.global");

    const imported = await importer.tasks.start({ title: "Importing", retry: RETRY });
    const linted = await linter.tasks.start({
      title: "Linting",
      retry: { actionId: "acme.linter.run" },
    });
    await otherProject.tasks.start({ title: "Elsewhere", retry: RETRY });
    await appGlobal.tasks.start({ title: "Everywhere", retry: { actionId: "acme.global.run" } });

    const work = svc.getProjectPluginWork("p1");
    expect(work.map((entry) => entry.pluginId).sort()).toEqual([
      "project__p1__acme.importer",
      "project__p1__acme.linter",
    ]);
    expect(work.flatMap((entry) => entry.liveTasks.map((task) => task.id)).sort()).toEqual(
      [imported.id, linted.id].sort()
    );
    expect(svc.getProjectPluginWork("p3")).toEqual([]);
  });

  it("keeps a cancelling task as live work until the plugin finishes it", async () => {
    const host = registerInstance("project__p1__acme.importer", "acme.importer");
    const task = await host.tasks.start({ title: "Sync", cancellable: true, retry: RETRY });

    expect(svc.cancelPluginTask("project__p1__acme.importer", task.id)).toBe(true);
    expect(svc.getProjectPluginWork("p1")).toHaveLength(1);

    await task.finish({ outcome: "cancelled" });
    expect(svc.getProjectPluginWork("p1")).toEqual([]);
  });

  it("releases a project only once every instance's task has ended", async () => {
    const importer = registerInstance("project__p1__acme.importer", "acme.importer");
    const linter = registerInstance("project__p1__acme.linter", "acme.linter");
    const imported = await importer.tasks.start({ title: "Importing", retry: RETRY });
    await linter.tasks.start({ title: "Linting", retry: { actionId: "acme.linter.run" } });

    await imported.finish({ outcome: "succeeded" });
    expect(svc.getProjectPluginWork("p1").map((entry) => entry.pluginId)).toEqual([
      "project__p1__acme.linter",
    ]);

    // An unload interrupts the task; the record stays for the user but holds nothing.
    svc.unloadPlugin("project__p1__acme.linter");
    expect(svc.getProjectPluginWork("p1")).toEqual([]);
  });
});
