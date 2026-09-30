// Benchmark for plugin startup blocking on the blocklist fetch, and for the two
// plugin file-watch pollers. Not part of `npm test`; run with
//   npx vitest run --config vitest.integration.config.ts electron/services/plugin/__tests__/pluginStartupPolling.bench.integration.test.ts
// Results are appended as `[bench] …` lines to $PLUGIN_BENCH_OUT (default: a
// file in the OS temp dir). All times are fake-timer (virtual) milliseconds.
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fsModule from "fs";
import fsp from "fs/promises";
import os from "os";
import path from "path";

vi.mock("fs", async () => {
  // Pass-through, so `existsSync` can be spied on through the module namespace.
  const actual = await vi.importActual<typeof import("fs")>("fs");
  return { ...actual };
});
vi.mock("electron", () => ({
  app: {
    getPath: vi.fn((key: string) => `/mock/electron/${key}`),
    getVersion: vi.fn(() => "0.15.0"),
  },
  ipcMain: { on: vi.fn(), removeListener: vi.fn(), handle: vi.fn(), removeHandler: vi.fn() },
  BrowserWindow: { getAllWindows: vi.fn(() => []) },
  webContents: { getAllWebContents: vi.fn(() => []) },
}));
vi.mock("../../../window/windowRef.js", () => ({
  getWindowRegistry: vi.fn(() => null),
  getProjectViewManager: vi.fn(() => null),
  setWindowRegistry: vi.fn(),
  setMainWindow: vi.fn(),
  getMainWindow: vi.fn(() => null),
  setProjectViewManager: vi.fn(),
}));
vi.mock("../../../ipc/utils.js", () => ({ broadcastToRenderer: vi.fn() }));
vi.mock("../../../store.js", () => {
  const state = new Map<string, unknown>();
  return {
    store: { get: (k: string) => state.get(k), set: (k: string, v: unknown) => state.set(k, v) },
  };
});
vi.mock("../../ProjectStore.js", () => ({
  projectStore: {
    getCurrentProject: vi.fn(() => null),
    getProjectById: vi.fn(() => undefined),
    getAllProjects: vi.fn(() => []),
    getCurrentProjectId: vi.fn(() => null),
  },
}));
vi.mock("../../../ipc/errorHandlers.js", () => ({ notifyError: vi.fn() }));
vi.mock("../../TelemetryService.js", () => ({ trackEvent: vi.fn() }));
vi.mock("../../../utils/parcelWatcherBackend.js", () => ({
  subscribeParcelWatcher: vi.fn(async () => ({ unsubscribe: vi.fn(async () => {}) })),
}));

import { PluginService } from "../../PluginService.js";
import { PluginBlocklistService } from "../PluginBlocklistService.js";
import { ProjectPluginWatcher } from "../ProjectPluginWatcher.js";
import { discoverProjectPlugins } from "../projectPluginDiscovery.js";
import {
  __resetDeferredQueueForTests,
  finalizeDeferredRegistration,
  registerDeferredTask,
  signalFirstInteractive,
} from "../../../window/deferredInitQueue.js";
import {
  PLUGIN_BLOCKLIST_FETCH_TIMEOUT_MS,
  PLUGIN_BLOCKLIST_TTL_MS,
} from "../../../../shared/config/pluginBlocklist.js";
import type { PluginHostApi, PluginManifest } from "../../../../shared/types/plugin.js";

const REPS = Number(process.env.PLUGIN_BENCH_REPS ?? 5);
const OUT =
  process.env.PLUGIN_BENCH_OUT ?? path.join(os.tmpdir(), "daintree-plugin-startup-bench.log");
const realSetTimeout = globalThis.setTimeout;
const roots: string[] = [];

function report(line: string): void {
  fsModule.appendFileSync(OUT, line + "\n");
  process.stderr.write(line + "\n");
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)]!;
}

async function tempRoot(prefix: string): Promise<string> {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), prefix));
  roots.push(root);
  return root;
}

/** Let real I/O finish without advancing the fake clock. */
function settleRealIo(): Promise<void> {
  return new Promise((resolve) => realSetTimeout(resolve, 5));
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

afterAll(async () => {
  await Promise.all(roots.map((r) => fsp.rm(r, { recursive: true, force: true })));
});

describe("blocklist fetch on startup (stale disk cache, 8 s fetch)", () => {
  beforeEach(() => __resetDeferredQueueForTests());

  it("time until initialize() resolves and the next deferred task starts", async () => {
    const init: number[] = [];
    const next: number[] = [];
    const enforced: number[] = [];
    for (let rep = 0; rep < REPS; rep++) {
      __resetDeferredQueueForTests();
      const root = await tempRoot("dt-bench-blocklist-");
      const pluginsRoot = path.join(root, "plugins");
      for (const name of ["acme.one", "acme.two", "acme.bad"]) {
        const dir = path.join(pluginsRoot, name);
        await fsp.mkdir(dir, { recursive: true });
        await fsp.writeFile(
          path.join(dir, "plugin.json"),
          JSON.stringify({ name, version: "1.0.0" })
        );
      }
      const cachePath = path.join(root, "plugin-blocklist.json");
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
      const t0 = Date.now();
      // Last fetched just past the TTL — the first launch of the day.
      await fsp.writeFile(
        cachePath,
        JSON.stringify({ fetchedAt: t0 - PLUGIN_BLOCKLIST_TTL_MS - 60_000, raw: { entries: [] } })
      );
      const fetchImpl = vi.fn(
        () =>
          new Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>((resolve) =>
            setTimeout(
              () =>
                resolve({
                  ok: true,
                  status: 200,
                  json: async () => ({
                    entries: [{ name: "acme.bad", ranges: ["*"], reason: "malware" }],
                  }),
                }),
              PLUGIN_BLOCKLIST_FETCH_TIMEOUT_MS
            )
          )
      );
      const service = new PluginService(pluginsRoot, undefined, {
        blocklistService: new PluginBlocklistService({ fetchImpl, cachePath }),
      });

      let initAt: number | undefined;
      let nextAt: number | undefined;
      let enforcedAt: number | undefined;
      registerDeferredTask({
        name: "plugin-service",
        run: async () => {
          await service.initialize();
          initAt = Date.now() - t0;
        },
      });
      registerDeferredTask({
        name: "mcp-server",
        run: () => {
          nextAt = Date.now() - t0;
        },
      });
      finalizeDeferredRegistration(60_000);
      signalFirstInteractive(null);

      for (let step = 0; step < 400; step++) {
        await settleRealIo();
        if (
          enforcedAt === undefined &&
          service.listPlugins().some((p) => p.manifest.name === "acme.bad" && p.blocklisted)
        ) {
          enforcedAt = Date.now() - t0;
        }
        if (initAt !== undefined && nextAt !== undefined && enforcedAt !== undefined) break;
        await vi.advanceTimersByTimeAsync(50);
      }
      vi.useRealTimers();
      expect(initAt).toBeDefined();
      expect(nextAt).toBeDefined();
      expect(enforcedAt).toBeDefined();
      expect(service.hasPlugin("acme.bad")).toBe(false);
      expect(service.hasPlugin("acme.one")).toBe(true);
      init.push(initAt!);
      next.push(nextAt!);
      enforced.push(enforcedAt!);
      service.dispose();
    }
    report(
      `[bench] blocklist initialize() resolved (ms): ${init.join(",")} median=${median(init)}`
    );
    report(
      `[bench] blocklist next deferred task start (ms): ${next.join(",")} median=${median(next)}`
    );
    report(
      `[bench] blocklist fresh list enforced (ms): ${enforced.join(",")} median=${median(enforced)}`
    );
  });
});

describe("ProjectPluginWatcher sentinel poll (no .daintree/plugins)", () => {
  it("existsSync calls over 60 s for one open project", async () => {
    const counts: number[] = [];
    for (let rep = 0; rep < REPS; rep++) {
      const root = await tempRoot("dt-bench-sentinel-");
      vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
      const watcher = new ProjectPluginWatcher({
        discover: discoverProjectPlugins,
        loadedManifestIds: () => [],
        reload: async () => {},
        viewGenerationsAllocated: () => 0,
        resolveGitDir: async () => null,
      });
      await watcher.ensure("project", root);
      const spy = vi.spyOn(fsModule, "existsSync");
      await vi.advanceTimersByTimeAsync(60_000);
      counts.push(spy.mock.calls.length);
      spy.mockRestore();
      watcher.dispose();
      vi.useRealTimers();
    }
    report(`[bench] sentinel existsSync / 60 s: ${counts.join(",")} median=${median(counts)}`);
  });
});

describe("host.fs.watch allowMissing presence poll (all targets present)", () => {
  it("fs.stat calls over 60 s for 10 subscriptions", async () => {
    const counts: number[] = [];
    for (let rep = 0; rep < REPS; rep++) {
      const base = await tempRoot("dt-bench-presence-");
      const pluginsRoot = path.join(base, "plugins");
      const allowed = path.join(base, "allowed");
      await fsp.mkdir(pluginsRoot, { recursive: true });
      const targets: string[] = [];
      for (let i = 0; i < 10; i++) {
        const dir = path.join(allowed, `dir-${i}`);
        await fsp.mkdir(dir, { recursive: true });
        targets.push(dir);
      }
      const svc = new PluginService(pluginsRoot);
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
          name: "acme.fsgit",
          version: "1.0.0",
          capabilities: ["fs:project-read"],
          scopes: { fs: { allowedPaths: [allowed] } },
          contributes: { fileDecorationProviders: [], forgeProviders: [] },
        } as unknown as PluginManifest,
        dir: base,
        loadedAt: 0,
        isBuiltin: false,
      });
      const host = seam._createHostForTests("acme.fsgit");

      // Let the creation events for the fixture dirs drain before watching.
      await new Promise((resolve) => realSetTimeout(resolve, 200));
      vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
      const disposers: Array<() => void> = [];
      for (const target of targets) {
        disposers.push(await host.fs.watch([target], () => undefined, { allowMissing: true }));
      }
      const spy = vi.spyOn(fsp, "stat");
      // One tick at a time, letting each tick's real stats finish, so the
      // in-flight guard never skips a tick and undercounts.
      for (let tick = 0; tick < 60; tick++) {
        await vi.advanceTimersByTimeAsync(1000);
        await settleRealIo();
      }
      counts.push(spy.mock.calls.length);
      spy.mockRestore();
      for (const dispose of disposers) dispose();
      vi.useRealTimers();
      svc.dispose();
    }
    report(
      `[bench] allowMissing fs.stat / 60 s (10 subs): ${counts.join(",")} median=${median(counts)}`
    );
  });
});
