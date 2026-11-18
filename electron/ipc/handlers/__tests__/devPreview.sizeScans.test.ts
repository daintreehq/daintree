import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";

const ipcMainMock = vi.hoisted(() => ({
  handle: vi.fn(),
  removeHandler: vi.fn(),
}));

interface Scan {
  root: string;
  signal: AbortSignal;
  release: (bytes: number) => void;
}

const scanLog = vi.hoisted(() => ({
  scans: [] as Scan[],
  active: 0,
  peak: 0,
}));

const measureMock = vi.hoisted(() =>
  vi.fn(
    (root: string, options: { signal?: AbortSignal; statBatch?: number }) =>
      new Promise<number | null>((resolve) => {
        scanLog.active += 1;
        scanLog.peak = Math.max(scanLog.peak, scanLog.active);
        // Like a killed `du`, a stopped scan settles only when it is released:
        // the slot it holds must not be handed on before then.
        scanLog.scans.push({
          root,
          signal: options.signal!,
          release: (bytes) => {
            scanLog.active -= 1;
            resolve(bytes);
          },
        });
      })
  )
);

vi.mock("electron", () => ({
  ipcMain: ipcMainMock,
  app: { getPath: () => os.tmpdir() },
  BrowserWindow: { fromWebContents: vi.fn(() => null), getAllWindows: vi.fn(() => []) },
}));
vi.mock("node:http", () => ({ default: { request: vi.fn() }, request: vi.fn() }));
vi.mock("node:https", () => ({ default: { request: vi.fn() }, request: vi.fn() }));
vi.mock("../../../services/DirectoryDiskUsage.js", () => ({ measureDirectorySize: measureMock }));
vi.mock("../../../services/DevPreviewManifestService.js", () => ({
  readAndClearDevPreviewManifest: () => [],
  writeDevPreviewManifest: () => {},
}));
vi.mock("../../../store.js", () => ({ store: { get: () => undefined, set: () => {} } }));
vi.mock("../../../window/webContentsRegistry.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../window/webContentsRegistry.js")>()),
  getProjectForWebContents: () => null,
  getWindowForWebContents: () => null,
}));
vi.mock("../../../window/windowRef.js", () => ({
  getProjectViewManager: vi.fn(() => null),
  setProjectViewManager: vi.fn(),
  getWindowRegistry: vi.fn(() => null),
  setWindowRegistry: vi.fn(),
  getMainWindow: vi.fn(() => null),
  setMainWindow: vi.fn(),
}));

import { CHANNELS } from "../../channels.js";
import { registerDevPreviewHandlers } from "../devPreview.js";
import type { DevPreviewDestructivePreviewSizes } from "../../../../shared/types/ipc/devPreview.js";

class FakeSender extends EventEmitter {
  constructor(readonly id: number) {
    super();
  }
  isDestroyed() {
    return false;
  }
}

function createPtyClientMock() {
  const terminals = new Set<string>();
  return {
    on: vi.fn(),
    off: vi.fn(),
    setIpcDataMirror: vi.fn(),
    spawn: vi.fn((id: string) => terminals.add(id)),
    hasTerminal: vi.fn((id: string) => terminals.has(id)),
    submit: vi.fn(),
    kill: vi.fn((id: string) => terminals.delete(id)),
    getTerminalAsync: vi.fn(async () => null),
    replayHistoryAsync: vi.fn(async () => 0),
  };
}

function handler(channel: string): (...args: unknown[]) => Promise<unknown> {
  const call = (ipcMainMock.handle as Mock).mock.calls.find(([c]) => c === channel);
  if (!call) throw new Error(`${channel} was never registered`);
  return call[1] as (...args: unknown[]) => Promise<unknown>;
}

async function invoke(channel: string, sender: FakeSender, payload: unknown): Promise<unknown> {
  const result = (await handler(channel)({ sender }, payload)) as {
    ok?: boolean;
    data?: unknown;
    error?: unknown;
  };
  if (result?.ok === false) throw new Error(JSON.stringify(result.error));
  return result?.ok ? result.data : result;
}

const SESSION = { panelId: "panel-1", projectId: "project-1" };
const CACHE_ROOT_COUNT = 7;

function sizes(sender: FakeSender, sessionId: string, skipNodeModules = false) {
  return invoke(CHANNELS.DEV_PREVIEW_GET_DESTRUCTIVE_PREVIEW_SIZES, sender, {
    ...SESSION,
    skipNodeModules,
    sessionId,
  }) as Promise<DevPreviewDestructivePreviewSizes>;
}

function cancel(sender: FakeSender, sessionId: string) {
  return invoke(CHANNELS.DEV_PREVIEW_CANCEL_DESTRUCTIVE_PREVIEW_SIZES, sender, { sessionId });
}

function expectAllNull(result: DevPreviewDestructivePreviewSizes) {
  expect(Object.keys(result.cacheDirSizes)).toHaveLength(CACHE_ROOT_COUNT);
  expect(Object.values(result.cacheDirSizes).every((size) => size === null)).toBe(true);
  expect(result.nodeModulesSizeBytes).toBeNull();
}

describe("dev-preview confirmation size scans", () => {
  let cleanup: (() => void) | null = null;
  let tmpDir: string;

  function register() {
    cleanup = registerDevPreviewHandlers({
      ptyClient: createPtyClientMock(),
    } as never);
  }

  async function ensureSession(sender: FakeSender) {
    await invoke(CHANNELS.DEV_PREVIEW_ENSURE, sender, {
      ...SESSION,
      cwd: tmpDir,
      devCommand: "npm run dev",
    });
  }

  beforeEach(() => {
    vi.clearAllMocks();
    scanLog.scans = [];
    scanLog.active = 0;
    scanLog.peak = 0;
    tmpDir = mkdtempSync(path.join(os.tmpdir(), "devpreview-size-scans-"));
    register();
  });

  afterEach(() => {
    vi.useRealTimers();
    for (const scan of scanLog.scans) scan.release(0);
    cleanup?.();
    cleanup = null;
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("a newer opening stops the old one's scans, and its own wait for the slots they hold", async () => {
    const view = new FakeSender(1);
    await ensureSession(view);

    const first = sizes(view, "opening-a");
    await vi.waitFor(() => expect(scanLog.scans).toHaveLength(2));
    const firstScans = [...scanLog.scans];

    const second = sizes(view, "opening-b");
    expectAllNull(await first);
    expect(firstScans.every((scan) => scan.signal.aborted)).toBe(true);
    // The stopped scans haven't exited yet, so nothing new may start.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(scanLog.scans).toHaveLength(2);

    for (const scan of firstScans) scan.release(0);
    for (let released = 0; released < CACHE_ROOT_COUNT + 1; released++) {
      await vi.waitFor(() => expect(scanLog.scans.length).toBeGreaterThan(2 + released));
      scanLog.scans[2 + released]!.release(1024);
    }

    const result = await second;
    expect(result.nodeModulesSizeBytes).toBe(1024);
    expect(Object.values(result.cacheDirSizes).every((size) => size === 1024)).toBe(true);
    // The first opening's queued roots never started.
    expect(scanLog.scans).toHaveLength(2 + CACHE_ROOT_COUNT + 1);
    expect(scanLog.peak).toBe(2);
  });

  it("a newer opening sent in the same turn stops the old one before it starts a scan", async () => {
    const view = new FakeSender(1);
    await ensureSession(view);

    const first = sizes(view, "opening-a");
    const second = sizes(view, "opening-b");

    expectAllNull(await first);
    await vi.waitFor(() => expect(scanLog.scans).toHaveLength(2));
    expect(scanLog.scans.every((scan) => !scan.signal.aborted)).toBe(true);
    for (let released = 0; released < CACHE_ROOT_COUNT + 1; released++) {
      await vi.waitFor(() => expect(scanLog.scans.length).toBeGreaterThan(released));
      scanLog.scans[released]!.release(512);
    }
    expect((await second).nodeModulesSizeBytes).toBe(512);
    expect(scanLog.scans).toHaveLength(CACHE_ROOT_COUNT + 1);
  });

  it("keeps an answered opening's session until its cancel", async () => {
    const view = new FakeSender(1);
    await ensureSession(view);

    const pending = sizes(view, "opening-a", true);
    for (let released = 0; released < CACHE_ROOT_COUNT; released++) {
      await vi.waitFor(() => expect(scanLog.scans.length).toBeGreaterThan(released));
      scanLog.scans[released]!.release(64);
    }
    expect((await pending).cacheDirSizes[".next"]).toBe(64);
    expect(scanLog.scans.every((scan) => !scan.signal.aborted)).toBe(true);

    await cancel(view, "opening-a");
    expect(scanLog.scans.every((scan) => scan.signal.aborted)).toBe(true);
  });

  it("gives a request from a Shell without sessions its own session, closed once it answers", async () => {
    const view = new FakeSender(1);
    await ensureSession(view);

    const pending = invoke(CHANNELS.DEV_PREVIEW_GET_DESTRUCTIVE_PREVIEW_SIZES, view, {
      ...SESSION,
      skipNodeModules: true,
    }) as Promise<DevPreviewDestructivePreviewSizes>;
    for (let released = 0; released < CACHE_ROOT_COUNT; released++) {
      await vi.waitFor(() => expect(scanLog.scans.length).toBeGreaterThan(released));
      scanLog.scans[released]!.release(32);
    }

    expect((await pending).cacheDirSizes[".next"]).toBe(32);
    expect(scanLog.scans.every((scan) => scan.signal.aborted)).toBe(true);
  });

  it("walks one lstat at a time, so two scans never hold more than two pool workers", async () => {
    const view = new FakeSender(1);
    await ensureSession(view);

    void sizes(view, "opening-a");
    await vi.waitFor(() => expect(measureMock).toHaveBeenCalled());
    expect(measureMock.mock.calls[0]![1]).toMatchObject({ statBatch: 1 });
  });

  it("abandons a scan at its 30-second deadline while queued roots keep waiting for its slot", async () => {
    const view = new FakeSender(1);
    await ensureSession(view);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });

    const pending = sizes(view, "opening-a");
    for (let i = 0; i < 20 && scanLog.scans.length < 2; i++) await vi.advanceTimersByTimeAsync(0);
    expect(scanLog.scans).toHaveLength(2);

    await vi.advanceTimersByTimeAsync(29_999);
    expect(scanLog.scans.every((scan) => !scan.signal.aborted)).toBe(true);
    await vi.advanceTimersByTimeAsync(1);
    expect(scanLog.scans.every((scan) => scan.signal.aborted)).toBe(true);
    // Abandoned, but still running: nothing else may start until they exit.
    expect(scanLog.scans).toHaveLength(2);

    for (const scan of scanLog.scans.slice(0, 2)) scan.release(0);
    for (let i = 0; i < 20 && scanLog.scans.length < 4; i++) await vi.advanceTimersByTimeAsync(0);
    expect(scanLog.scans).toHaveLength(4);
    vi.useRealTimers();
    for (let released = 2; released < CACHE_ROOT_COUNT + 1; released++) {
      await vi.waitFor(() => expect(scanLog.scans.length).toBeGreaterThan(released));
      scanLog.scans[released]!.release(1);
    }
    const result = await pending;
    expect(result.cacheDirSizes[".next"]).toBeNull();
    expect(result.nodeModulesSizeBytes).toBe(1);
  });

  it("a cancel naming the opening stops its scans", async () => {
    const view = new FakeSender(1);
    await ensureSession(view);

    const pending = sizes(view, "opening-a");
    await vi.waitFor(() => expect(scanLog.scans).toHaveLength(2));
    await cancel(view, "opening-a");

    expectAllNull(await pending);
    expect(scanLog.scans.every((scan) => scan.signal.aborted)).toBe(true);
  });

  it("a cancel sent right behind the first request stops it before the service loads", async () => {
    const view = new FakeSender(1);
    const pending = sizes(view, "opening-a");
    await cancel(view, "opening-a");

    expectAllNull(await pending);
    expect(measureMock).not.toHaveBeenCalled();
  });

  it("a late cancel for an older opening leaves the current one running", async () => {
    const view = new FakeSender(1);
    await ensureSession(view);

    const first = sizes(view, "opening-a");
    await vi.waitFor(() => expect(scanLog.scans).toHaveLength(2));
    for (const scan of scanLog.scans) scan.release(0);
    const second = sizes(view, "opening-b", true);
    expectAllNull(await first);
    await vi.waitFor(() => expect(scanLog.scans).toHaveLength(4));

    await cancel(view, "opening-a");
    expect(scanLog.scans.slice(2).every((scan) => !scan.signal.aborted)).toBe(true);
    for (let released = 2; released < 2 + CACHE_ROOT_COUNT; released++) {
      await vi.waitFor(() => expect(scanLog.scans.length).toBeGreaterThan(released));
      scanLog.scans[released]!.release(256);
    }
    expect((await second).cacheDirSizes[".next"]).toBe(256);
  });

  it("each view's opening is its own", async () => {
    const a = new FakeSender(1);
    const b = new FakeSender(2);
    await ensureSession(a);

    const pendingA = sizes(a, "opening", true);
    await vi.waitFor(() => expect(scanLog.scans).toHaveLength(2));
    const fromA = [...scanLog.scans];

    const pendingB = sizes(b, "opening", true);
    await cancel(b, "opening");
    expectAllNull(await pendingB);

    expect(fromA.every((scan) => !scan.signal.aborted)).toBe(true);
    for (let released = 0; released < CACHE_ROOT_COUNT; released++) {
      await vi.waitFor(() => expect(scanLog.scans.length).toBeGreaterThan(released));
      scanLog.scans[released]!.release(128);
    }
    expect((await pendingA).cacheDirSizes[".next"]).toBe(128);
  });

  it("stops a view's scans when the view is destroyed", async () => {
    const view = new FakeSender(1);
    await ensureSession(view);

    const pending = sizes(view, "opening-a");
    await vi.waitFor(() => expect(scanLog.scans).toHaveLength(2));
    view.emit("destroyed");

    expectAllNull(await pending);
    expect(scanLog.scans.every((scan) => scan.signal.aborted)).toBe(true);
  });

  it("stops a view's scans when it navigates away", async () => {
    const view = new FakeSender(1);
    await ensureSession(view);

    const pending = sizes(view, "opening-a");
    await vi.waitFor(() => expect(scanLog.scans).toHaveLength(2));
    view.emit("did-start-navigation", { isMainFrame: true, isSameDocument: false });

    expectAllNull(await pending);
    expect(scanLog.scans.every((scan) => scan.signal.aborted)).toBe(true);
  });

  it("stops running scans when the handlers are disposed", async () => {
    const view = new FakeSender(1);
    await ensureSession(view);

    void sizes(view, "opening-a");
    await vi.waitFor(() => expect(scanLog.scans).toHaveLength(2));
    cleanup?.();
    cleanup = null;

    expect(scanLog.scans.every((scan) => scan.signal.aborted)).toBe(true);
    expect(view.listenerCount("did-start-navigation")).toBe(0);
    expect(view.listenerCount("render-process-gone")).toBe(0);
  });

  it("still refuses a request for a panel with no session", async () => {
    await expect(sizes(new FakeSender(1), "opening-a")).rejects.toThrow(/No dev-preview session/);
  });

  it("refuses a malformed session id, and a cancel that names none", async () => {
    const view = new FakeSender(1);
    await ensureSession(view);
    await expect(
      invoke(CHANNELS.DEV_PREVIEW_GET_DESTRUCTIVE_PREVIEW_SIZES, view, {
        ...SESSION,
        sessionId: 42,
      })
    ).rejects.toThrow(/Invalid sessionId/);
    await expect(
      invoke(CHANNELS.DEV_PREVIEW_CANCEL_DESTRUCTIVE_PREVIEW_SIZES, view, {})
    ).rejects.toThrow(/Invalid sessionId/);
    expect(measureMock).not.toHaveBeenCalled();
  });
});
