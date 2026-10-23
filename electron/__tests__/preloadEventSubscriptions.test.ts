import { EventEmitter } from "node:events";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Subscribe/unsubscribe through the real preload bridge. Every renderer event
 * subscription returns a disposer, and a disposer that leaves its listener
 * attached turns each remount into one more delivery of the same event — a
 * leak nothing else in the suite can see, because renderer tests mock
 * `window.electron` and main tests never load the preload.
 *
 * `preload.cts` is bundled with esbuild the way the build does and evaluated
 * against a fake `electron`, since Vite does not transform `.cts` sources.
 */

const PRELOAD_CTS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "preload.cts");
const exposed: Record<string, unknown> = {};

class FakeIpcRenderer extends EventEmitter {
  send = vi.fn();
  sendSync = vi.fn();
  invoke = vi.fn(() => Promise.resolve(undefined));
  postMessage = vi.fn();
}

const ipcRenderer = new FakeIpcRenderer();

const fakeElectron = {
  contextBridge: {
    exposeInMainWorld: (key: string, value: unknown) => {
      exposed[key] = value;
    },
  },
  ipcRenderer,
  webFrame: { getZoomFactor: () => 1, clearCache: vi.fn() },
  webUtils: { getPathForFile: () => "" },
};

interface TerminalBridge {
  onActivity: (cb: (payload: unknown) => void) => () => void;
  onExit: (cb: (id: string, code: number) => void) => () => void;
}

interface PluginBridge {
  onToolbarBadgesChanged: (cb: (payload: unknown) => void) => () => void;
  onToolbarStatesChanged: (cb: (payload: unknown) => void) => () => void;
  onWorktreeCardStatusesChanged: (cb: (payload: unknown) => void) => () => void;
  onWorktreeReviewChecksChanged: (cb: (payload: unknown) => void) => () => void;
}

interface AppBridge {
  isViewCached: () => boolean;
}

interface ProjectPresentationBridge {
  onChanged: (cb: (payload: unknown) => void) => () => void;
}

const originalWindow = (globalThis as { window?: unknown }).window;
let terminal: TerminalBridge;
let plugin: PluginBridge;
let projectPresentation: ProjectPresentationBridge;
let app: AppBridge;

beforeAll(async () => {
  const fakeWindow = {
    location: { href: "app://daintree/index.html" },
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  } as Record<string, unknown>;
  fakeWindow.top = fakeWindow;
  (globalThis as { window?: unknown }).window = fakeWindow;

  const bundle = await build({
    entryPoints: [PRELOAD_CTS],
    bundle: true,
    platform: "node",
    format: "cjs",
    external: ["electron"],
    write: false,
    logLevel: "silent",
  });
  const module = { exports: {} };
  const requireShim = (id: string): unknown => {
    if (id === "electron") return fakeElectron;
    throw new Error(`preload bundle required unexpected module: ${id}`);
  };
  new Function("require", "module", "exports", bundle.outputFiles[0]!.text)(
    requireShim,
    module,
    module.exports
  );
  const api = exposed.electron as
    | {
        terminal?: TerminalBridge;
        plugin?: PluginBridge;
        projectPresentation?: ProjectPresentationBridge;
        app?: AppBridge;
      }
    | undefined;
  expect(api?.terminal, "preload did not expose window.electron.terminal").toBeDefined();
  terminal = api!.terminal!;
  plugin = api!.plugin!;
  projectPresentation = api!.projectPresentation!;
  app = api!.app!;
});

afterAll(() => {
  (globalThis as { window?: unknown }).window = originalWindow;
});

describe("preload event subscriptions", () => {
  beforeEach(() => {
    ipcRenderer.removeAllListeners("terminal:activity");
  });

  it("delivers each terminal:activity push exactly once after repeated subscribe/unsubscribe cycles", () => {
    for (let i = 0; i < 5; i++) {
      const dispose = terminal.onActivity(vi.fn());
      dispose();
    }
    expect(ipcRenderer.listenerCount("terminal:activity")).toBe(0);

    const received: unknown[] = [];
    const dispose = terminal.onActivity((payload) => received.push(payload));
    ipcRenderer.emit("terminal:activity", {}, { terminalId: "t1" });

    expect(received).toEqual([{ terminalId: "t1" }]);
    dispose();
    ipcRenderer.emit("terminal:activity", {}, { terminalId: "t2" });
    expect(received).toEqual([{ terminalId: "t1" }]);
    expect(ipcRenderer.listenerCount("terminal:activity")).toBe(0);
  });

  it("stops delivering events-bus pushes to a disposed subscriber and keeps one channel listener", () => {
    const busListenersBefore = ipcRenderer.listenerCount("events:push");
    const exits: Array<[string, number]> = [];

    for (let i = 0; i < 5; i++) {
      terminal.onExit(() => exits.push(["stale", -1]))();
    }
    const dispose = terminal.onExit((id, code) => exits.push([id, code]));

    ipcRenderer.emit("events:push", {}, { name: "terminal:exit", payload: ["t1", 0] });
    expect(exits).toEqual([["t1", 0]]);

    dispose();
    ipcRenderer.emit("events:push", {}, { name: "terminal:exit", payload: ["t2", 1] });
    expect(exits).toEqual([["t1", 0]]);
    expect(ipcRenderer.listenerCount("events:push")).toBe(busListenersBefore);
  });

  it("passes a session-preserving teardown's exit context through, and nothing else (#13841)", () => {
    const exits: unknown[][] = [];
    const dispose = terminal.onExit((...args) => exits.push(args));

    ipcRenderer.emit(
      "events:push",
      {},
      { name: "terminal:exit", payload: ["t1", 0, { preserveSession: true }] }
    );
    ipcRenderer.emit(
      "events:push",
      {},
      { name: "terminal:exit", payload: ["t2", 0, { preserveSession: "yes", extra: 1 }] }
    );
    ipcRenderer.emit("events:push", {}, { name: "terminal:exit", payload: ["t3", 0, null] });
    dispose();

    expect(exits).toEqual([
      ["t1", 0, { preserveSession: true }],
      ["t2", 0],
      ["t3", 0],
    ]);
  });

  it("replays each plugin's latest toolbar-badge map to a late subscriber (#13503)", () => {
    // Wire the bus, then leave the toolbar-badge event with no subscriber, as a
    // restored view's did-finish-load replay finds it.
    terminal.onExit(() => {})();
    const push = (payload: unknown) =>
      ipcRenderer.emit("events:push", {}, { name: "plugin:toolbar-badges-changed", payload });
    push({ pluginId: "p1", badges: { needs: { kind: "label", text: "3" } } });
    push({ pluginId: "p2", badges: { queue: { kind: "dot" } } });
    push({ pluginId: "p1", badges: {} });

    const received: unknown[] = [];
    const dispose = plugin.onToolbarBadgesChanged((payload) => received.push(payload));
    // p1's clear supersedes its earlier set; p2's map survives it.
    expect(received).toEqual([
      { pluginId: "p2", badges: { queue: { kind: "dot" } } },
      { pluginId: "p1", badges: {} },
    ]);

    push({ pluginId: "p1", badges: { needs: { kind: "dot" } } });
    expect(received).toHaveLength(3);
    dispose();
  });

  it("replays each plugin's latest toolbar-state map to a late subscriber (#13785)", () => {
    terminal.onExit(() => {})();
    const push = (payload: unknown) =>
      ipcRenderer.emit("events:push", {}, { name: "plugin:toolbar-states-changed", payload });
    push({ pluginId: "p1", states: { sync: { pressed: true } } });
    push({ pluginId: "p2", states: { run: { busy: true } } });
    push({ pluginId: "p1", states: {} });

    const received: unknown[] = [];
    const dispose = plugin.onToolbarStatesChanged((payload) => received.push(payload));
    expect(received).toEqual([
      { pluginId: "p2", states: { run: { busy: true } } },
      { pluginId: "p1", states: {} },
    ]);

    push({ pluginId: "p1", states: { sync: { pressed: false } } });
    expect(received).toHaveLength(3);
    dispose();
  });

  it("replays each plugin's latest card statuses per project to a late subscriber (#13704)", () => {
    terminal.onExit(() => {})();
    const push = (payload: unknown) =>
      ipcRenderer.emit(
        "events:push",
        {},
        { name: "plugin:worktree-card-statuses-changed", payload }
      );
    push({ pluginId: "p1", projectId: "A", statuses: { "/a": { label: "up" } } });
    push({ pluginId: "p1", projectId: "B", statuses: { "/b": { label: "up" } } });
    push({ pluginId: "p2", projectId: "A", statuses: { "/a": { label: "x" } } });
    push({ pluginId: "p1", projectId: "A", statuses: {} });

    const received: unknown[] = [];
    const dispose = plugin.onWorktreeCardStatusesChanged((payload) => received.push(payload));
    // p1's clear in A supersedes its set there, and only there.
    expect(received).toEqual([
      { pluginId: "p1", projectId: "B", statuses: { "/b": { label: "up" } } },
      { pluginId: "p2", projectId: "A", statuses: { "/a": { label: "x" } } },
      { pluginId: "p1", projectId: "A", statuses: {} },
    ]);
    dispose();
  });

  it("replays each plugin's latest review checks per project to a late subscriber (#13806)", () => {
    terminal.onExit(() => {})();
    const push = (payload: unknown) =>
      ipcRenderer.emit(
        "events:push",
        {},
        { name: "plugin:worktree-review-checks-changed", payload }
      );
    const check = (label: string) => ({ label, severity: "warning" });
    push({ pluginId: "p1", projectId: "A", checks: { "/a": [check("one")] } });
    push({ pluginId: "p1", projectId: "B", checks: { "/b": [check("two")] } });
    push({ pluginId: "p2", projectId: "A", checks: { "/a": [check("three")] } });
    push({ pluginId: "p1", projectId: "A", checks: {} });

    const received: unknown[] = [];
    const dispose = plugin.onWorktreeReviewChecksChanged((payload) => received.push(payload));
    expect(received).toEqual([
      { pluginId: "p1", projectId: "B", checks: { "/b": [check("two")] } },
      { pluginId: "p2", projectId: "A", checks: { "/a": [check("three")] } },
      { pluginId: "p1", projectId: "A", checks: {} },
    ]);
    dispose();
  });

  it("delivers each project-presentation:changed push once and detaches on dispose", () => {
    const received: unknown[] = [];
    const dispose = projectPresentation.onChanged((payload) => received.push(payload));
    ipcRenderer.emit("project-presentation:changed", {}, { projectId: "p1" });
    expect(received).toEqual([{ projectId: "p1" }]);

    dispose();
    ipcRenderer.emit("project-presentation:changed", {}, { projectId: "p2" });
    expect(received).toEqual([{ projectId: "p1" }]);
    expect(ipcRenderer.listenerCount("project-presentation:changed")).toBe(0);
  });

  it("drops Blink's memory cache once a view has stayed cached for a moment", () => {
    vi.useFakeTimers();
    try {
      fakeElectron.webFrame.clearCache.mockClear();

      ipcRenderer.emit("app:view-cached", {});
      expect(app.isViewCached()).toBe(true);
      expect(fakeElectron.webFrame.clearCache).not.toHaveBeenCalled();

      vi.advanceTimersByTime(2_000);
      expect(fakeElectron.webFrame.clearCache).toHaveBeenCalledTimes(1);

      ipcRenderer.emit("app:view-warm-activated", {});
      vi.advanceTimersByTime(10_000);
      expect(fakeElectron.webFrame.clearCache).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("never clears the cache of a view that became active again first", () => {
    vi.useFakeTimers();
    try {
      fakeElectron.webFrame.clearCache.mockClear();

      // A freeze can hold the cached signal until the next activation, which
      // then delivers both back to back.
      ipcRenderer.emit("app:view-cached", {});
      ipcRenderer.emit("app:view-warm-activated", {});
      vi.advanceTimersByTime(10_000);
      expect(fakeElectron.webFrame.clearCache).not.toHaveBeenCalled();

      // A cache storm schedules one clear, not one per signal.
      ipcRenderer.emit("app:view-cached", {});
      vi.advanceTimersByTime(1_000);
      ipcRenderer.emit("app:view-cached", {});
      vi.advanceTimersByTime(2_000);
      expect(fakeElectron.webFrame.clearCache).toHaveBeenCalledTimes(1);
      ipcRenderer.emit("app:view-warm-activated", {});
    } finally {
      vi.useRealTimers();
    }
  });

  it("still latches the cached state when clearing the cache throws", () => {
    vi.useFakeTimers();
    try {
      fakeElectron.webFrame.clearCache.mockImplementationOnce(() => {
        throw new Error("renderer tearing down");
      });
      ipcRenderer.emit("app:view-cached", {});
      expect(() => vi.advanceTimersByTime(2_000)).not.toThrow();
      expect(app.isViewCached()).toBe(true);
      ipcRenderer.emit("app:view-warm-activated", {});
    } finally {
      vi.useRealTimers();
    }
  });
});
