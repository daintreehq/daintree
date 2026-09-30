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
  webFrame: { getZoomFactor: () => 1 },
  webUtils: { getPathForFile: () => "" },
};

interface TerminalBridge {
  onActivity: (cb: (payload: unknown) => void) => () => void;
  onExit: (cb: (id: string, code: number) => void) => () => void;
}

const originalWindow = (globalThis as { window?: unknown }).window;
let terminal: TerminalBridge;

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
  const api = exposed.electron as { terminal?: TerminalBridge } | undefined;
  expect(api?.terminal, "preload did not expose window.electron.terminal").toBeDefined();
  terminal = api!.terminal!;
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
});
