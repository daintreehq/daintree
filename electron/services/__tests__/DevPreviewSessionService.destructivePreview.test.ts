import http from "node:http";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync } from "node:fs";
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
    spawn: vi.fn((id: string, spawnOptions: { projectId?: string; args?: string[] }) => {
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
  };
}

describe("DevPreviewSessionService — destructive preview", () => {
  let onStateChanged: (state: DevPreviewSessionState) => void;
  let ptyClient: ReturnType<typeof createPtyClientMock>;
  let service: DevPreviewSessionService;
  let tmpDir: string;

  beforeEach(() => {
    onStateChanged = vi.fn();
    ptyClient = createPtyClientMock();
    service = new DevPreviewSessionService(ptyClient as unknown as PtyClient, onStateChanged);
    mockHttpResponse(200);
    tmpDir = mkdtempSync(path.join(os.tmpdir(), "devpreview-preview-"));
  });

  afterEach(() => {
    service.dispose();
    vi.restoreAllMocks();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function request() {
    return { panelId: "panel-1", projectId: "project-1" };
  }

  function ensureRequest() {
    return { ...request(), cwd: tmpDir, devCommand: "npm run dev" };
  }

  describe("getDestructivePreviewMeta", () => {
    it("reports existence + mtime for each cache directory present", async () => {
      mkdirSync(path.join(tmpDir, ".next"), { recursive: true });
      mkdirSync(path.join(tmpDir, ".vite"), { recursive: true });
      const knownTime = new Date("2025-01-15T10:00:00Z");
      utimesSync(path.join(tmpDir, ".next"), knownTime, knownTime);

      await service.ensure(ensureRequest());
      const meta = await service.getDestructivePreviewMeta(request());

      expect(meta.cwd).toBe(tmpDir);
      const next = meta.cacheDirs.find((d) => d.relPath === ".next");
      const vite = meta.cacheDirs.find((d) => d.relPath === ".vite");
      const turbo = meta.cacheDirs.find((d) => d.relPath === ".turbo");
      const nodeModulesVite = meta.cacheDirs.find(
        (d) => d.relPath === path.join("node_modules", ".vite")
      );
      expect(next?.exists).toBe(true);
      expect(next?.mtimeMs).toBe(knownTime.getTime());
      expect(vite?.exists).toBe(true);
      expect(turbo?.exists).toBe(false);
      expect(turbo?.mtimeMs).toBeNull();
      expect(nodeModulesVite?.exists).toBe(false);
    });

    it("reports nodeModules existence", async () => {
      mkdirSync(path.join(tmpDir, "node_modules"), { recursive: true });
      writeFileSync(path.join(tmpDir, "node_modules", "marker"), "x");

      await service.ensure(ensureRequest());
      const meta = await service.getDestructivePreviewMeta(request());

      expect(meta.nodeModules.exists).toBe(true);
      expect(meta.nodeModules.mtimeMs).toBeGreaterThan(0);
    });

    it("detects pnpm when pnpm-lock.yaml is present", async () => {
      writeFileSync(path.join(tmpDir, "pnpm-lock.yaml"), "lockfileVersion: 9.0\n");
      await service.ensure(ensureRequest());
      const meta = await service.getDestructivePreviewMeta(request());
      expect(meta.packageManager).toBe("pnpm");
      expect(meta.lockfileName).toBe("pnpm-lock.yaml");
    });

    it("detects yarn when yarn.lock is present", async () => {
      writeFileSync(path.join(tmpDir, "yarn.lock"), "");
      await service.ensure(ensureRequest());
      const meta = await service.getDestructivePreviewMeta(request());
      expect(meta.packageManager).toBe("yarn");
      expect(meta.lockfileName).toBe("yarn.lock");
    });

    it("detects bun by bun.lock (preferred) over bun.lockb", async () => {
      writeFileSync(path.join(tmpDir, "bun.lock"), "");
      writeFileSync(path.join(tmpDir, "bun.lockb"), "");
      await service.ensure(ensureRequest());
      const meta = await service.getDestructivePreviewMeta(request());
      expect(meta.packageManager).toBe("bun");
      expect(meta.lockfileName).toBe("bun.lock");
    });

    it("returns npm with package-lock.json when no other lockfile present", async () => {
      writeFileSync(path.join(tmpDir, "package-lock.json"), "{}");
      await service.ensure(ensureRequest());
      const meta = await service.getDestructivePreviewMeta(request());
      expect(meta.packageManager).toBe("npm");
      expect(meta.lockfileName).toBe("package-lock.json");
    });

    it("returns npm fallback with null lockfile when nothing matches", async () => {
      await service.ensure(ensureRequest());
      const meta = await service.getDestructivePreviewMeta(request());
      expect(meta.packageManager).toBe("npm");
      expect(meta.lockfileName).toBeNull();
    });

    it("respects lockfile precedence: bun > pnpm > yarn > npm", async () => {
      writeFileSync(path.join(tmpDir, "pnpm-lock.yaml"), "");
      writeFileSync(path.join(tmpDir, "yarn.lock"), "");
      writeFileSync(path.join(tmpDir, "package-lock.json"), "{}");
      writeFileSync(path.join(tmpDir, "bun.lock"), "");
      await service.ensure(ensureRequest());
      const meta = await service.getDestructivePreviewMeta(request());
      expect(meta.packageManager).toBe("bun");
    });

    it("throws when the session does not exist", async () => {
      await expect(service.getDestructivePreviewMeta(request())).rejects.toThrow(
        /No dev-preview session/
      );
    });
  });

  describe("getDestructivePreviewSizes", () => {
    it("returns null for cache dirs that do not exist", async () => {
      await service.ensure(ensureRequest());
      const sizes = await service.getDestructivePreviewSizes(request());

      expect(sizes.cacheDirSizes[".next"]).toBeNull();
      expect(sizes.cacheDirSizes[".vite"]).toBeNull();
      expect(sizes.cacheDirSizes[".turbo"]).toBeNull();
      expect(sizes.cacheDirSizes[path.join("node_modules", ".vite")]).toBeNull();
      expect(sizes.nodeModulesSizeBytes).toBeNull();
    });

    it("returns a numeric size when a cache dir exists with content", async () => {
      mkdirSync(path.join(tmpDir, ".next"), { recursive: true });
      const sample = "x".repeat(4096);
      writeFileSync(path.join(tmpDir, ".next", "build-output.txt"), sample);

      await service.ensure(ensureRequest());
      const sizes = await service.getDestructivePreviewSizes(request());

      expect(typeof sizes.cacheDirSizes[".next"]).toBe("number");
      expect(sizes.cacheDirSizes[".next"]).toBeGreaterThan(0);
    });

    it("returns nodeModules size when present", async () => {
      mkdirSync(path.join(tmpDir, "node_modules", "foo"), { recursive: true });
      writeFileSync(path.join(tmpDir, "node_modules", "foo", "index.js"), "module.exports = {};");
      await service.ensure(ensureRequest());
      const sizes = await service.getDestructivePreviewSizes(request());
      expect(typeof sizes.nodeModulesSizeBytes).toBe("number");
      expect(sizes.nodeModulesSizeBytes).toBeGreaterThan(0);
    });

    it("throws when the session does not exist", async () => {
      await expect(service.getDestructivePreviewSizes(request())).rejects.toThrow(
        /No dev-preview session/
      );
    });

    it("returns null for nodeModulesSizeBytes when skipNodeModules is true (cache tier)", async () => {
      mkdirSync(path.join(tmpDir, "node_modules", "foo"), { recursive: true });
      writeFileSync(path.join(tmpDir, "node_modules", "foo", "index.js"), "x");
      mkdirSync(path.join(tmpDir, ".next"), { recursive: true });
      writeFileSync(path.join(tmpDir, ".next", "out"), "data");

      await service.ensure(ensureRequest());
      const sizes = await service.getDestructivePreviewSizes({
        ...request(),
        skipNodeModules: true,
      });

      expect(sizes.nodeModulesSizeBytes).toBeNull();
      expect(typeof sizes.cacheDirSizes[".next"]).toBe("number");
    });
  });
});
