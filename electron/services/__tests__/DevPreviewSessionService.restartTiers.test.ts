import http from "node:http";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from "node:fs";
import fsPromises from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DevPreviewSessionService } from "../DevPreviewSessionService.js";
import type { PtyClient } from "../PtyClient.js";
import type { DevPreviewSessionState } from "../../../shared/types/ipc/devPreview.js";

vi.mock("node:http", () => ({ default: { request: vi.fn() }, request: vi.fn() }));
vi.mock("node:https", () => ({ default: { request: vi.fn() }, request: vi.fn() }));

type DataListener = (id: string, data: string | Uint8Array) => void;
type ExitListener = (id: string, exitCode: number) => void;

function mockHttpResponse(statusCode: number) {
  const impl = ((
    _: unknown,
    __: unknown,
    cb: (res: { statusCode: number; resume: () => void }) => void
  ) => {
    const req = {
      on: () => req,
      end: () => cb({ statusCode, resume: () => {} }),
      destroy: () => {},
    };
    return req;
  }) as unknown as typeof http.request;
  vi.mocked(http.request).mockImplementation(impl);
  vi.mocked(https.request).mockImplementation(impl);
}

function createPtyClientMock() {
  const dataListeners = new Set<DataListener>();
  const exitListeners = new Set<ExitListener>();
  const terminals = new Map<string, { projectId?: string; hasPty: boolean }>();

  return {
    on: vi.fn((event: string, callback: DataListener | ExitListener) => {
      if (event === "data") dataListeners.add(callback as DataListener);
      if (event === "exit") exitListeners.add(callback as ExitListener);
    }),
    off: vi.fn((event: string, callback: DataListener | ExitListener) => {
      if (event === "data") dataListeners.delete(callback as DataListener);
      if (event === "exit") exitListeners.delete(callback as ExitListener);
    }),
    spawn: vi.fn((id: string, spawnOptions: { projectId?: string }) => {
      terminals.set(id, { projectId: spawnOptions.projectId, hasPty: true });
    }),
    kill: vi.fn((id: string) => {
      const terminal = terminals.get(id);
      if (terminal) terminal.hasPty = false;
    }),
    submit: vi.fn(),
    hasTerminal: vi.fn((id: string) => terminals.get(id)?.hasPty ?? false),
    setIpcDataMirror: vi.fn(),
    replayHistoryAsync: vi.fn(async () => 0),
    getTerminalAsync: vi.fn(async (id: string) => {
      const terminal = terminals.get(id);
      if (!terminal) return null;
      return {
        id,
        projectId: terminal.projectId,
        hasPty: terminal.hasPty,
        cwd: "/repo",
        spawnedAt: Date.now(),
      };
    }),
    emitExit(id: string, exitCode: number) {
      const terminal = terminals.get(id);
      if (terminal) terminal.hasPty = false;
      for (const callback of exitListeners) callback(id, exitCode);
    },
    emitData(id: string, data: string | Uint8Array) {
      for (const callback of dataListeners) callback(id, data);
    },
  };
}

describe("DevPreviewSessionService — tiered restart", () => {
  let onStateChanged: (state: DevPreviewSessionState) => void;
  let ptyClient: ReturnType<typeof createPtyClientMock>;
  let service: DevPreviewSessionService;
  let tmpDir: string;

  beforeEach(() => {
    onStateChanged = vi.fn();
    ptyClient = createPtyClientMock();
    service = new DevPreviewSessionService(ptyClient as unknown as PtyClient, onStateChanged);
    mockHttpResponse(200);
    tmpDir = mkdtempSync(path.join(os.tmpdir(), "devpreview-tiers-"));
  });

  afterEach(() => {
    service.dispose();
    vi.restoreAllMocks();
    vi.useRealTimers();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function request() {
    return { panelId: "panel-1", projectId: "project-1" };
  }

  function ensureRequest() {
    return { ...request(), cwd: tmpDir, devCommand: "npm run dev" };
  }

  describe("restartAndClearCache", () => {
    it("kills the terminal, wipes the cache dirs, then respawns", async () => {
      for (const dir of [".next", ".vite", ".turbo", path.join("node_modules", ".vite")]) {
        const full = path.join(tmpDir, dir);
        mkdirSync(full, { recursive: true });
        writeFileSync(path.join(full, "stale"), "x");
      }
      // A non-cache marker directly under node_modules — must survive so an
      // accidental widening of CACHE_DIRS to all of node_modules is caught.
      writeFileSync(path.join(tmpDir, "node_modules", "package.json"), "{}");

      const started = await service.ensure(ensureRequest());
      expect(started.terminalId).toBeTruthy();

      const result = await service.restartAndClearCache(request());

      expect(ptyClient.kill).toHaveBeenCalledWith(
        started.terminalId,
        "dev-preview:restart-clear-cache"
      );
      expect(existsSync(path.join(tmpDir, ".next"))).toBe(false);
      expect(existsSync(path.join(tmpDir, ".vite"))).toBe(false);
      expect(existsSync(path.join(tmpDir, ".turbo"))).toBe(false);
      expect(existsSync(path.join(tmpDir, "node_modules", ".vite"))).toBe(false);
      expect(existsSync(path.join(tmpDir, "node_modules", "package.json"))).toBe(true);
      expect(result.status).toBe("starting");
      expect(result.terminalId).not.toBe(started.terminalId);
      expect(ptyClient.spawn).toHaveBeenCalledTimes(2);
    });

    it("is forgiving when cache dirs do not exist", async () => {
      const started = await service.ensure(ensureRequest());
      const result = await service.restartAndClearCache(request());

      expect(result.status).toBe("starting");
      expect(result.terminalId).not.toBe(started.terminalId);
      expect(ptyClient.spawn).toHaveBeenCalledTimes(2);
    });

    it("surfaces a deletion failure as an error state and does not respawn", async () => {
      await service.ensure(ensureRequest());
      vi.spyOn(fsPromises, "rm").mockRejectedValue(new Error("EPERM: operation not permitted"));

      const result = await service.restartAndClearCache(request());

      expect(result.status).toBe("error");
      expect(result.error?.message).toContain("Failed to clear cache");
      // Only the initial ensure() spawn — no respawn after the failure.
      expect(ptyClient.spawn).toHaveBeenCalledTimes(1);
    });

    it("deletes caches only after the terminal is confirmed gone", async () => {
      mkdirSync(path.join(tmpDir, ".next"), { recursive: true });
      const started = await service.ensure(ensureRequest());
      ptyClient.getTerminalAsync.mockClear();
      const rmSpy = vi.spyOn(fsPromises, "rm");

      await service.restartAndClearCache(request());

      // kill must precede deletion, and the liveness poll
      // (getTerminalAsync via waitForTerminalGone) must run between them —
      // proving rm waits for the PTY to be confirmed dead, not just signalled.
      const killOrder = ptyClient.kill.mock.invocationCallOrder.at(-1)!;
      const pollOrder = ptyClient.getTerminalAsync.mock.invocationCallOrder[0];
      const rmOrder = rmSpy.mock.invocationCallOrder[0];
      expect(pollOrder).toBeGreaterThan(killOrder);
      expect(rmOrder).toBeGreaterThan(pollOrder);
      expect(started.terminalId).toBeTruthy();
    });
  });

  describe("reinstallAndRestart", () => {
    it("removes node_modules with retries, runs install, and does not double-spawn", async () => {
      mkdirSync(path.join(tmpDir, "node_modules"), { recursive: true });
      writeFileSync(path.join(tmpDir, "node_modules", "marker"), "x");
      writeFileSync(path.join(tmpDir, "bun.lock"), "");

      const rmSpy = vi.spyOn(fsPromises, "rm");
      const started = await service.ensure(ensureRequest());
      expect(started.terminalId).toBeTruthy();

      const result = await service.reinstallAndRestart(request());

      expect(ptyClient.kill).toHaveBeenCalledWith(
        started.terminalId,
        "dev-preview:reinstall-restart"
      );
      expect(rmSpy).toHaveBeenCalledWith(
        path.join(tmpDir, "node_modules"),
        expect.objectContaining({ recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
      );
      expect(existsSync(path.join(tmpDir, "node_modules"))).toBe(false);
      expect(result.status).toBe("installing");

      // runInstall spawns exactly one install PTY (initial dev spawn + install
      // spawn = 2). The dev server is NOT respawned until the install exits 0.
      expect(ptyClient.spawn).toHaveBeenCalledTimes(2);

      await vi.waitFor(() => {
        expect(ptyClient.submit).toHaveBeenCalledWith(expect.any(String), "bun install");
      });

      const installTerminalId = result.terminalId!;
      ptyClient.emitExit(installTerminalId, 0);
      // spawnSessionTerminal awaits port allocation before calling spawn.
      await vi.waitFor(() => {
        expect(ptyClient.spawn).toHaveBeenCalledTimes(3);
      });
    });

    it("surfaces a node_modules removal failure as an error state", async () => {
      await service.ensure(ensureRequest());
      vi.spyOn(fsPromises, "rm").mockRejectedValue(new Error("EBUSY: resource busy"));

      const result = await service.reinstallAndRestart(request());

      expect(result.status).toBe("error");
      expect(result.error?.message).toContain("Failed to remove node_modules");
      expect(ptyClient.spawn).toHaveBeenCalledTimes(1);
    });

    it("detects bun from bun.lock (text lockfile) when bun.lockb also present", async () => {
      mkdirSync(path.join(tmpDir, "node_modules"), { recursive: true });
      writeFileSync(path.join(tmpDir, "bun.lock"), "");
      writeFileSync(path.join(tmpDir, "bun.lockb"), "");

      await service.ensure(ensureRequest());
      const result = await service.reinstallAndRestart(request());

      await vi.waitFor(() => {
        expect(ptyClient.submit).toHaveBeenCalledWith(result.terminalId, "bun install");
      });
    });

    it("does not respawn the dev server when the install exits nonzero", async () => {
      mkdirSync(path.join(tmpDir, "node_modules"), { recursive: true });
      writeFileSync(path.join(tmpDir, "bun.lock"), "");

      await service.ensure(ensureRequest());
      const result = await service.reinstallAndRestart(request());
      expect(result.status).toBe("installing");

      const installTerminalId = result.terminalId!;
      ptyClient.emitExit(installTerminalId, 1);

      const state = service.getState(request());
      expect(state.status).toBe("error");
      expect(state.error?.type).toBe("missing-dependencies");
      // initial dev spawn + install spawn only — no dev-server respawn.
      expect(ptyClient.spawn).toHaveBeenCalledTimes(2);
    });
  });
});
