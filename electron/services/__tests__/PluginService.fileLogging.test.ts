import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const pluginServiceLogger = vi.hoisted(() => ({
  name: "main:PluginService",
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

// Only PluginService's own logger is swapped; every other module keeps the real
// one, so a stray line from elsewhere cannot satisfy or break an assertion.
vi.mock("../../utils/logger.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../utils/logger.js")>();
  return {
    ...actual,
    createLogger: (name: string) =>
      name === "main:PluginService" ? pluginServiceLogger : actual.createLogger(name),
  };
});
vi.mock("electron", () => ({
  app: {
    getVersion: vi.fn(() => "0.0.0"),
    getPath: vi.fn(() => "/tmp/daintree-plugin-file-logging"),
    getAppPath: vi.fn(() => "/tmp/daintree-plugin-file-logging"),
  },
}));
vi.mock("../../ipc/utils.js", () => ({
  broadcastToRenderer: vi.fn(),
  broadcastToProjectRenderers: vi.fn(),
}));

import { PluginService } from "../PluginService.js";
import type { LoadedPlugin } from "../plugin/PluginServiceTypes.js";
import { DEFAULT_PLUGIN_FILE_LOG_LIMITS } from "../plugin/pluginFileLog.js";
import {
  makeProjectPluginInstanceKey,
  type PluginLoadError,
  type PluginWorkerState,
} from "../../../shared/types/plugin.js";

const PROJECT_ID = "a".repeat(64);

function fakePlugin(name: string): LoadedPlugin {
  return {
    manifest: {
      name,
      version: "1.0.0",
      displayName: name,
      capabilities: [],
      contributes: {
        commands: [],
        panels: [],
        views: [],
        toolbarButtons: [],
        processTools: [],
        fileDecorationProviders: [],
      },
    } as unknown as LoadedPlugin["manifest"],
    dir: `/tmp/${name}`,
    isBuiltin: false,
    loadedAt: 1,
    viewGeneration: 0,
  };
}

interface Internals {
  recordPluginLoadError(
    pluginId: string,
    plugin: LoadedPlugin,
    loadError: PluginLoadError | null
  ): boolean;
  setWorkerStatus(
    pluginId: string,
    state: PluginWorkerState,
    reason: string | null,
    detail: string | null,
    opts?: { newGeneration?: boolean }
  ): void;
}

function internals(service: PluginService): Internals {
  return service as unknown as Internals;
}

function projectPlugin(service: PluginService, manifestId = "acme.demo") {
  const plugin = fakePlugin(manifestId);
  const key = makeProjectPluginInstanceKey(PROJECT_ID, manifestId);
  service._registerFakePluginForTests(plugin, key);
  return { plugin, key };
}

const projectIdentity = (key: string, manifestId = "acme.demo") => ({
  pluginId: manifestId,
  projectId: PROJECT_ID,
  instanceId: key,
});

let service: PluginService;

beforeEach(() => {
  for (const fn of [
    pluginServiceLogger.debug,
    pluginServiceLogger.info,
    pluginServiceLogger.warn,
    pluginServiceLogger.error,
  ]) {
    fn.mockReset();
  }
  vi.spyOn(console, "info").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  service = new PluginService("/tmp/daintree-plugin-file-logging-root", "0.0.0");
});

afterEach(() => {
  service.dispose();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function loadFailures() {
  return pluginServiceLogger.error.mock.calls.filter(([m]) => m === "Plugin failed to load");
}

function warnCalls(message: string) {
  return pluginServiceLogger.warn.mock.calls.filter(([m]) => m === message);
}

describe("PluginService file logging — host.logger reports (#12804)", () => {
  it("writes a project plugin's errors and warnings with its id and project", () => {
    const { key } = projectPlugin(service);
    const host = service._createHostForTests(key);

    host.logger.error("session restore failed");
    host.logger.warn("slow start");

    expect(pluginServiceLogger.error).toHaveBeenCalledWith("Plugin reported an error", undefined, {
      ...projectIdentity(key),
      message: "session restore failed",
    });
    expect(pluginServiceLogger.warn).toHaveBeenCalledWith("Plugin reported a warning", {
      ...projectIdentity(key),
      message: "slow start",
    });
  });

  it("keeps info out of the file but in the diagnostics ring", () => {
    const { key } = projectPlugin(service);
    service._createHostForTests(key).logger.info("hello");

    expect(pluginServiceLogger.info).not.toHaveBeenCalled();
    const entry = service.getDiagnosticsSnapshot().plugins.find((p) => p.pluginId === key);
    expect(entry?.logLines.map((l) => l.message)).toEqual(["hello"]);
  });

  it("tags an installed plugin with its id and no project", () => {
    service._registerFakePluginForTests(fakePlugin("acme.installed"));
    service._createHostForTests("acme.installed").logger.error("boom");

    expect(pluginServiceLogger.error).toHaveBeenCalledWith("Plugin reported an error", undefined, {
      pluginId: "acme.installed",
      message: "boom",
    });
  });

  it("leaves arbitrary fields out of the durable line and scrubs the message", () => {
    const { key } = projectPlugin(service);
    const token = `ghp_${"0123456789abcdefghijklmnopqrstuvwxyz"}`;
    service
      ._createHostForTests(key)
      .logger.error(`auth ${token}`, { terminalBuffer: "SECRET-TERMINAL-CONTENT" });

    const written = JSON.stringify(pluginServiceLogger.error.mock.calls);
    expect(written).not.toContain("SECRET-TERMINAL-CONTENT");
    expect(written).not.toContain(token);
    expect(written).toContain("[REDACTED]");
  });

  it("bounds a flood and reports what it dropped when the plugin unloads", () => {
    const { key } = projectPlugin(service);
    const host = service._createHostForTests(key);
    for (let i = 0; i < 50; i++) host.logger.error(`e${i}`);

    const budget = DEFAULT_PLUGIN_FILE_LOG_LIMITS.perPlugin.error;
    const admitted = pluginServiceLogger.error.mock.calls.filter(
      ([m]) => m === "Plugin reported an error"
    );
    expect(admitted.map(([, , ctx]) => (ctx as { message: string }).message)).toEqual(
      Array.from({ length: budget }, (_, i) => `e${i}`)
    );
    // The ring still holds every line.
    expect(
      service.getDiagnosticsSnapshot().plugins.find((p) => p.pluginId === key)?.logLines
    ).toHaveLength(50);

    service.unloadPlugin(key);
    const summaries = warnCalls("Plugin log lines suppressed by rate limit");
    expect(summaries).toHaveLength(1);
    expect(summaries[0][1]).toEqual({
      ...projectIdentity(key),
      suppressed: { error: 50 - budget },
    });
  });

  it("writes nothing for a stale host after unload", () => {
    const { key } = projectPlugin(service);
    const host = service._createHostForTests(key);
    service.unloadPlugin(key);
    pluginServiceLogger.error.mockReset();

    host.logger.error("after-unload");
    expect(pluginServiceLogger.error).not.toHaveBeenCalled();
  });

  it("never lets a throwing file logger reach plugin code", () => {
    const { key } = projectPlugin(service);
    pluginServiceLogger.error.mockImplementation(() => {
      throw new Error("disk full");
    });
    expect(() => service._createHostForTests(key).logger.error("boom")).not.toThrow();
  });

  it("never lets a message whose toString throws reach plugin code", () => {
    const { key } = projectPlugin(service);
    const hostile = {
      toString() {
        throw new Error("nope");
      },
    };
    expect(() =>
      service._createHostForTests(key).logger.error(hostile as unknown as string)
    ).not.toThrow();
    expect(pluginServiceLogger.error).toHaveBeenCalledWith(
      "Plugin reported an error",
      undefined,
      expect.objectContaining(projectIdentity(key))
    );
  });
});

describe("PluginService file logging — lifecycle (#12804)", () => {
  it("writes a project plugin's load error once per load, and again after a reload", () => {
    const { plugin, key } = projectPlugin(service);
    const loadError = { message: "activate() threw", stack: "at activate", at: 1 };

    internals(service).recordPluginLoadError(key, plugin, loadError);
    internals(service).recordPluginLoadError(key, plugin, { ...loadError, at: 2 });

    expect(loadFailures()).toHaveLength(1);
    // Not `error`: logger.error overwrites that key with its own error argument.
    expect(loadFailures()[0][2]).toEqual({
      ...projectIdentity(key),
      loadErrorMessage: "activate() threw",
      loadErrorStack: "at activate",
    });

    // A clear re-arms: the same failure on the next attempt is new evidence.
    internals(service).recordPluginLoadError(key, plugin, null);
    internals(service).recordPluginLoadError(key, plugin, loadError);
    expect(loadFailures()).toHaveLength(2);
  });

  it("writes a load error that lost out to a burst on its next attempt", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const { plugin, key } = projectPlugin(service);
    const host = service._createHostForTests(key);
    for (let i = 0; i <= DEFAULT_PLUGIN_FILE_LOG_LIMITS.perPlugin.error; i++) {
      host.logger.error(`e${i}`);
    }
    const loadError = { message: "activate() threw", at: 1 };

    internals(service).recordPluginLoadError(key, plugin, loadError);
    expect(loadFailures()).toHaveLength(0);

    vi.setSystemTime(Date.now() + DEFAULT_PLUGIN_FILE_LOG_LIMITS.windowMs);
    internals(service).recordPluginLoadError(key, plugin, { ...loadError, at: 2 });
    expect(loadFailures()).toHaveLength(1);
  });

  it("ignores a load error from a stale instance", () => {
    const { key } = projectPlugin(service);
    internals(service).recordPluginLoadError(key, fakePlugin("acme.demo"), {
      message: "late",
      at: 1,
    });
    expect(pluginServiceLogger.error).not.toHaveBeenCalled();
  });

  it("records worker transitions, warning on a crash and a failure", () => {
    const { key } = projectPlugin(service);
    const api = internals(service);
    api.setWorkerStatus(key, "starting", null, null, { newGeneration: true });
    api.setWorkerStatus(key, "ready", null, null);
    api.setWorkerStatus(key, "ready", null, null);
    api.setWorkerStatus(key, "starting", "crashed", "Worker exited (code 1)", {
      newGeneration: true,
    });
    api.setWorkerStatus(key, "failed", "crash-loop", "Worker crashed repeatedly");

    const infoStates = pluginServiceLogger.info.mock.calls
      .filter(([m]) => m === "Plugin worker state changed")
      .map(([, ctx]) => (ctx as { state: string }).state);
    // The repeated `ready` is not a transition and writes nothing.
    expect(infoStates).toEqual(["starting", "ready"]);

    const warned = warnCalls("Plugin worker state changed").map(([, ctx]) => ctx);
    expect(warned).toEqual([
      expect.objectContaining({
        ...projectIdentity(key),
        state: "starting",
        previousState: "ready",
        reason: "crashed",
        detail: "Worker exited (code 1)",
      }),
      expect.objectContaining({ state: "failed", reason: "crash-loop" }),
    ]);
  });

  it("records a project plugin's unload", () => {
    const { key } = projectPlugin(service);
    service.unloadPlugin(key);
    expect(pluginServiceLogger.info).toHaveBeenCalledWith(
      "Project plugin unloaded",
      projectIdentity(key)
    );
  });
});
