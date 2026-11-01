import { EventEmitter } from "node:events";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

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
  onFirstPrompt: (cb: (payload: unknown) => void) => () => void;
}

interface PluginBridge {
  onToolbarBadgesChanged: (cb: (payload: unknown) => void) => () => void;
  onToolbarStatesChanged: (cb: (payload: unknown) => void) => () => void;
  onWorktreeCardStatusesChanged: (cb: (payload: unknown) => void) => () => void;
  onWorktreeReviewChecksChanged: (cb: (payload: unknown) => void) => () => void;
}

interface AppBridge {
  isViewCached: () => boolean;
  onViewCached: (cb: () => void) => () => void;
  onViewCachedFlush: (cb: () => unknown) => () => void;
  onPanelGridConfigChanged: (cb: (payload: unknown) => void) => () => void;
}

interface ProjectPresentationBridge {
  onChanged: (cb: (payload: unknown) => void) => () => void;
}

interface TerminalConfigBridge {
  onChanged: (cb: (change: unknown) => void) => () => void;
}

const originalWindow = (globalThis as { window?: unknown }).window;
// The renderer globals the cached-edge idle GC reaches for (#15680). Idle
// callbacks run only when a test says so, standing in for an idle period or a
// thaw running whatever is still queued.
const idleGlobals = ["document", "requestIdleCallback", "cancelIdleCallback", "gc"] as const;
const originalIdleGlobals = idleGlobals.map(
  (key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const
);
const fakeDocument = new EventTarget();
const fakeGc = vi.fn();
const idleCallbacks = new Map<number, () => void>();
let nextIdleHandle = 1;
const runIdleCallbacks = () => {
  const due = [...idleCallbacks.values()];
  idleCallbacks.clear();
  for (const callback of due) callback();
};
let terminal: TerminalBridge;
let plugin: PluginBridge;
let projectPresentation: ProjectPresentationBridge;
let schedules: ProjectPresentationBridge;
let app: AppBridge;
let terminalConfig: TerminalConfigBridge;
let agentSettings: { onChanged: (cb: (settings: unknown) => void) => () => void };
let keybinding: { onOverridesChanged: (cb: (overrides: unknown) => void) => () => void };

beforeAll(async () => {
  const fakeWindow = {
    location: { href: "app://daintree/index.html" },
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  } as Record<string, unknown>;
  fakeWindow.top = fakeWindow;
  (globalThis as { window?: unknown }).window = fakeWindow;
  Object.assign(globalThis, {
    document: fakeDocument,
    requestIdleCallback: (callback: () => void) => {
      const handle = nextIdleHandle++;
      idleCallbacks.set(handle, callback);
      return handle;
    },
    cancelIdleCallback: (handle: number) => idleCallbacks.delete(handle),
    gc: fakeGc,
  });

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
        schedules?: ProjectPresentationBridge;
        terminalConfig?: TerminalConfigBridge;
        agentSettings?: typeof agentSettings;
        keybinding?: typeof keybinding;
        app?: AppBridge;
      }
    | undefined;
  expect(api?.terminal, "preload did not expose window.electron.terminal").toBeDefined();
  terminal = api!.terminal!;
  plugin = api!.plugin!;
  projectPresentation = api!.projectPresentation!;
  schedules = api!.schedules!;
  app = api!.app!;
  terminalConfig = api!.terminalConfig!;
  agentSettings = api!.agentSettings!;
  keybinding = api!.keybinding!;
});

afterAll(() => {
  (globalThis as { window?: unknown }).window = originalWindow;
  for (const [key, descriptor] of originalIdleGlobals) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else delete (globalThis as Record<string, unknown>)[key];
  }
});

describe("preload event subscriptions", () => {
  beforeEach(() => {
    ipcRenderer.removeAllListeners("terminal:activity");
  });

  it("names whose half each terminal-config change is, and detaches both channels on dispose", () => {
    const channels = ["terminal-config:device-changed", "terminal-config:host-changed"];
    const received: unknown[] = [];
    const dispose = terminalConfig.onChanged((change) => received.push(change));

    ipcRenderer.emit(channels[0], {}, { fontSize: 16 });
    ipcRenderer.emit(channels[1], {}, { resourceMonitoringEnabled: true });
    expect(received).toEqual([
      { owner: "device", config: { fontSize: 16 } },
      { owner: "host", config: { resourceMonitoringEnabled: true } },
    ]);

    dispose();
    dispose();
    ipcRenderer.emit(channels[0], {}, { fontSize: 18 });
    expect(received).toHaveLength(2);
    for (const channel of channels) expect(ipcRenderer.listenerCount(channel)).toBe(0);
  });

  it("hands on each saved agent settings, grid and shortcut change until disposed (#14700, #15579)", () => {
    const pushes: Array<[string, (cb: (payload: unknown) => void) => () => void]> = [
      ["agent-settings:changed", agentSettings.onChanged],
      ["app:panel-grid-config-changed", app.onPanelGridConfigChanged],
      ["keybinding:overrides-changed", keybinding.onOverridesChanged],
    ];
    for (const [channel, subscribe] of pushes) {
      const received: unknown[] = [];
      const dispose = subscribe((payload) => received.push(payload));
      ipcRenderer.emit(channel, {}, { saved: 1 });
      dispose();
      dispose();
      ipcRenderer.emit(channel, {}, { saved: 2 });
      expect(received).toEqual([{ saved: 1 }]);
      expect(ipcRenderer.listenerCount(channel)).toBe(0);
    }
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

  it("hands a run's first prompt to its subscriber until disposed (#15521)", () => {
    const received: unknown[] = [];
    const dispose = terminal.onFirstPrompt((payload) => received.push(payload));
    const payload = { id: "t1", firstPrompt: { text: "Fix the login bug", via: "send", at: 5 } };

    ipcRenderer.emit("events:push", {}, { name: "terminal:first-prompt", payload });
    dispose();
    ipcRenderer.emit("events:push", {}, { name: "terminal:first-prompt", payload });

    expect(received).toEqual([payload]);
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

  it("delivers each schedules:changed push once and detaches on dispose", () => {
    const received: unknown[] = [];
    const dispose = schedules.onChanged((payload) => received.push(payload));
    ipcRenderer.emit("schedules:changed", {}, { projectId: "p1", schedules: [], revision: 1 });
    expect(received).toEqual([{ projectId: "p1", schedules: [], revision: 1 }]);

    dispose();
    ipcRenderer.emit("schedules:changed", {}, { projectId: "p1", schedules: [], revision: 2 });
    expect(received).toHaveLength(1);
    expect(ipcRenderer.listenerCount("schedules:changed")).toBe(0);
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

  describe("cached-edge idle GC (#15680)", () => {
    const freeze = () => fakeDocument.dispatchEvent(new Event("freeze"));
    // Faking every timer would swap out the idle-callback stand-in too.
    const fakeTimeoutsOnly = () => vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });

    beforeEach(() => {
      fakeGc.mockClear();
      fakeElectron.webFrame.clearCache.mockClear();
      idleCallbacks.clear();
    });
    afterEach(() => {
      ipcRenderer.emit("app:view-warm-activated", {});
    });

    it("collects in the first idle period while the view is still cached", () => {
      ipcRenderer.emit("app:view-cached", {});
      expect(fakeGc).not.toHaveBeenCalled();

      runIdleCallbacks();
      expect(fakeGc).toHaveBeenCalledTimes(1);
    });

    it("drops a pending collection once the view is active again", () => {
      for (const channel of ["app:view-warm-activated", "app:view-revealed"]) {
        ipcRenderer.emit("app:view-cached", {});
        expect(idleCallbacks.size).toBe(1);
        ipcRenderer.emit(channel, {});
        expect(idleCallbacks.size).toBe(0);
      }
      runIdleCallbacks();
      expect(fakeGc).not.toHaveBeenCalled();
    });

    it("checks again when it runs, so one already dispatched as the view returns collects nothing", () => {
      ipcRenderer.emit("app:view-cached", {});
      const [dispatched] = [...idleCallbacks.values()];
      ipcRenderer.emit("app:view-warm-activated", {});

      dispatched!();
      expect(fakeGc).not.toHaveBeenCalled();
    });

    it("flushes, answers main and reaches the view's cached listeners even when scheduling the reclaim throws", async () => {
      ipcRenderer.send.mockClear();
      const flush = vi.fn();
      const offFlush = app.onViewCachedFlush(flush);
      const onCached = vi.fn();
      const offCached = app.onViewCached(onCached);
      const globals = globalThis as Record<string, unknown>;
      const schedule = globals.requestIdleCallback;
      globals.requestIdleCallback = () => {
        throw new Error("renderer tearing down");
      };
      try {
        ipcRenderer.emit("app:view-cached", {}, { flushId: "reclaim-threw" });
        expect(flush).toHaveBeenCalledTimes(1);
        expect(onCached).toHaveBeenCalledTimes(1);
        await vi.waitFor(() =>
          expect(ipcRenderer.send).toHaveBeenCalledWith("app:view-cached-flushed", "reclaim-threw")
        );
      } finally {
        globals.requestIdleCallback = schedule;
        offFlush();
        offCached();
      }
    });

    it("keeps one pending collection through a cache storm", () => {
      ipcRenderer.emit("app:view-cached", {});
      ipcRenderer.emit("app:view-cached", {});
      expect(idleCallbacks.size).toBe(1);

      runIdleCallbacks();
      expect(fakeGc).toHaveBeenCalledTimes(1);
    });

    it("drops the collection and the cache clear when a freeze lands, so the thaw that activation causes runs neither", () => {
      fakeTimeoutsOnly();
      try {
        ipcRenderer.emit("app:view-cached", {});
        expect(idleCallbacks.size).toBe(1);

        freeze();
        // A thaw runs whatever is still queued before warm-activated is handled.
        runIdleCallbacks();
        vi.advanceTimersByTime(10_000);
        expect(fakeGc).not.toHaveBeenCalled();
        expect(fakeElectron.webFrame.clearCache).not.toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
      }
    });

    it("schedules nothing for a cached signal handled after the freeze, until the view has been active again", async () => {
      fakeTimeoutsOnly();
      ipcRenderer.send.mockClear();
      const flush = vi.fn();
      const offFlush = app.onViewCachedFlush(flush);
      try {
        // IPC still runs in a frozen renderer, so the signal can trail the freeze.
        freeze();
        ipcRenderer.emit("app:view-cached", {}, { flushId: "after-freeze" });
        expect(app.isViewCached()).toBe(true);
        expect(flush).toHaveBeenCalledTimes(1);
        expect(idleCallbacks.size).toBe(0);
        // A thaw that isn't an activation (efficiency exit, a dispatch) keeps it suppressed.
        fakeDocument.dispatchEvent(new Event("resume"));
        ipcRenderer.emit("app:view-cached", {});
        expect(idleCallbacks.size).toBe(0);
        vi.advanceTimersByTime(10_000);
        expect(fakeElectron.webFrame.clearCache).not.toHaveBeenCalled();
        await vi.waitFor(() =>
          expect(ipcRenderer.send).toHaveBeenCalledWith("app:view-cached-flushed", "after-freeze")
        );

        ipcRenderer.emit("app:view-warm-activated", {});
        ipcRenderer.emit("app:view-cached", {});
        runIdleCallbacks();
        expect(fakeGc).toHaveBeenCalledTimes(1);
        vi.advanceTimersByTime(2_000);
        expect(fakeElectron.webFrame.clearCache).toHaveBeenCalledTimes(1);
      } finally {
        offFlush();
        vi.useRealTimers();
      }
    });
  });

  describe("cached-edge flush (#15633)", () => {
    const sentOn = (channel: string) =>
      ipcRenderer.send.mock.calls.filter(([sent]) => sent === channel).map(([, arg]) => arg);
    const flushed = () => sentOn("app:view-cached-flushed");

    beforeEach(() => ipcRenderer.send.mockClear());

    it("tells main when the first flush is registered and when the last one goes", () => {
      const offA = app.onViewCachedFlush(() => {});
      const offB = app.onViewCachedFlush(() => {});
      expect(sentOn("app:view-cached-flush-armed")).toEqual([true]);

      offA();
      offA();
      expect(sentOn("app:view-cached-flush-armed")).toEqual([true]);
      offB();
      expect(sentOn("app:view-cached-flush-armed")).toEqual([true, false]);
    });

    it("keeps the other registration when the same function is registered twice", async () => {
      const flush = vi.fn();
      const offFirst = app.onViewCachedFlush(flush);
      const offSecond = app.onViewCachedFlush(flush);
      offFirst();
      expect(sentOn("app:view-cached-flush-armed")).toEqual([true]);

      ipcRenderer.emit("app:view-cached", {}, { flushId: "dup" });
      expect(flush).toHaveBeenCalledTimes(1);
      await vi.waitFor(() => expect(flushed()).toEqual(["dup"]));

      offSecond();
      expect(sentOn("app:view-cached-flush-armed")).toEqual([true, false]);
      ipcRenderer.emit("app:view-warm-activated", {});
    });

    it("answers main's flush id only once every flush has settled", async () => {
      let finishSlow!: () => void;
      const slow = vi.fn(() => new Promise<void>((resolve) => (finishSlow = resolve)));
      const failing = vi.fn(() => Promise.reject(new Error("save failed")));
      const throwing = vi.fn(() => {
        throw new Error("boom");
      });
      const offs = [slow, failing, throwing].map((flush) => app.onViewCachedFlush(flush));
      try {
        ipcRenderer.emit("app:view-cached", {}, { flushId: "edge-1" });
        expect(slow).toHaveBeenCalledTimes(1);
        expect(failing).toHaveBeenCalledTimes(1);
        expect(throwing).toHaveBeenCalledTimes(1);

        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(flushed()).toEqual([]);

        finishSlow();
        await vi.waitFor(() => expect(flushed()).toEqual(["edge-1"]));
      } finally {
        for (const off of offs) off();
        ipcRenderer.emit("app:view-warm-activated", {});
      }
    });

    it("answers at once with nothing registered, and keeps a started flush after unsubscribing", async () => {
      ipcRenderer.emit("app:view-cached", {}, { flushId: "empty" });
      await vi.waitFor(() => expect(flushed()).toEqual(["empty"]));

      let finish!: () => void;
      const off = app.onViewCachedFlush(() => new Promise<void>((resolve) => (finish = resolve)));
      ipcRenderer.emit("app:view-cached", {}, { flushId: "held" });
      off();
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(flushed()).toEqual(["empty"]);

      finish();
      await vi.waitFor(() => expect(flushed()).toEqual(["empty", "held"]));
      ipcRenderer.emit("app:view-warm-activated", {});
    });

    it("still flushes on an edge main isn't holding, without answering it", async () => {
      const unhandled = vi.fn();
      process.on("unhandledRejection", unhandled);
      const flush = vi.fn();
      const offs = [
        app.onViewCachedFlush(flush),
        app.onViewCachedFlush(() => Promise.reject(new Error("save failed"))),
        app.onViewCachedFlush(() => {
          throw new Error("boom");
        }),
      ];
      try {
        ipcRenderer.emit("app:view-cached", {});
        for (const off of offs) off();
        await new Promise((resolve) => setTimeout(resolve, 0));
      } finally {
        process.off("unhandledRejection", unhandled);
      }

      expect(unhandled).not.toHaveBeenCalled();
      expect(flush).toHaveBeenCalledTimes(1);
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(flushed()).toEqual([]);
      ipcRenderer.emit("app:view-warm-activated", {});
    });
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
