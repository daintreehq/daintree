// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs/promises";
import { execFileSync } from "node:child_process";
import os from "os";
import path from "path";
import { buildScopedFsApi } from "../PluginHostFactory.js";
import type { PluginHostFactoryDeps } from "../PluginHostFactory.js";

// The factory module reaches Electron's `app` on import through the settings
// manager; nothing under test here touches it.
vi.mock("electron", () => ({
  app: { getPath: (key: string) => `/mock/electron/${key}`, getVersion: () => "0.0.0" },
  ipcMain: { handle: vi.fn(), removeHandler: vi.fn() },
  BrowserWindow: { getAllWindows: () => [] },
  webContents: { getAllWebContents: () => [] },
  clipboard: {},
  shell: {},
}));

/**
 * `host.fs.readFileBounded` against real files: what it refuses, what it never
 * opens for longer than the call, and that the uncapped reads beside it are
 * untouched.
 *
 * The deps are the few the filesystem surface actually consults — liveness,
 * declared capabilities and the expanded roots — so the test exercises the
 * real closures rather than a reimplementation of them.
 */
const PLUGIN_ID = "bounds-test";
const SCOPE = { projectId: "p1", worktreeId: "w1" };

function depsFor(
  root: string,
  capabilities: string[] = ["fs:project-read"]
): PluginHostFactoryDeps {
  return {
    plugins: new Map([[PLUGIN_ID, {}]]),
    declaredCapabilities: () => new Set(capabilities),
    expandAllowedPathEntries: async () => [{ path: root, rootClass: "project" }],
  } as unknown as PluginHostFactoryDeps;
}

describe("host.fs.readFileBounded", () => {
  let root: string;

  beforeEach(async () => {
    root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "plugin-fs-bounds-")));
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it("hands back a file that fits under the limit", async () => {
    const target = path.join(root, "small.json");
    await fs.writeFile(target, '{"a":1}');
    const api = buildScopedFsApi(depsFor(root), PLUGIN_ID, SCOPE);

    const read = await api.readFileBounded!(target, { limitBytes: 1024 });

    expect(read).toEqual({ status: "ok", bytes: new TextEncoder().encode('{"a":1}') });
  });

  it("reads a file exactly at the limit, and refuses one byte more", async () => {
    const at = path.join(root, "at.txt");
    const over = path.join(root, "over.txt");
    await fs.writeFile(at, "x".repeat(64));
    await fs.writeFile(over, "x".repeat(65));
    const api = buildScopedFsApi(depsFor(root), PLUGIN_ID, SCOPE);

    expect(await api.readFileBounded!(at, { limitBytes: 64 })).toMatchObject({ status: "ok" });
    expect(await api.readFileBounded!(over, { limitBytes: 64 })).toEqual({ status: "too-large" });
  });

  it("refuses an oversized file without holding more than the limit and a byte", async () => {
    const target = path.join(root, "huge.bin");
    await fs.writeFile(target, Buffer.alloc(4 * 1024 * 1024));
    const api = buildScopedFsApi(depsFor(root), PLUGIN_ID, SCOPE);

    expect(await api.readFileBounded!(target, { limitBytes: 1024 })).toEqual({
      status: "too-large",
    });
  });

  // mkfifo has no Windows equivalent; CI is Ubuntu.
  it.skipIf(process.platform === "win32")(
    "refuses a FIFO instead of waiting on a writer that never comes",
    async () => {
      const fifo = path.join(root, "package.json");
      execFileSync("mkfifo", [fifo]);
      const api = buildScopedFsApi(depsFor(root), PLUGIN_ID, SCOPE);

      // Raced deliberately: a blocking open on a writer-less FIFO never
      // returns, and a wedged suite is worse than a failing assertion.
      const read = await Promise.race([
        api.readFileBounded!(fifo, { limitBytes: 1024 }),
        new Promise((resolve) => setTimeout(() => resolve({ status: "pending" }), 2000)),
      ]);

      expect(read).toEqual({ status: "not-a-file" });
    }
  );

  it("refuses a directory the same way", async () => {
    const dir = path.join(root, "nested");
    await fs.mkdir(dir);
    const api = buildScopedFsApi(depsFor(root), PLUGIN_ID, SCOPE);

    expect(await api.readFileBounded!(dir, { limitBytes: 1024 })).toEqual({ status: "not-a-file" });
  });

  it("rejects an already-aborted read before it opens anything", async () => {
    const target = path.join(root, "small.txt");
    await fs.writeFile(target, "x");
    const api = buildScopedFsApi(depsFor(root), PLUGIN_ID, SCOPE);

    await expect(
      api.readFileBounded!(target, { limitBytes: 1024, signal: AbortSignal.abort() })
    ).rejects.toThrow(/abort/i);
  });

  it("keeps the same containment and capability gates as every other read", async () => {
    const outside = path.join(os.tmpdir(), "not-in-scope.txt");
    const target = path.join(root, "small.txt");
    await fs.writeFile(target, "x");

    await expect(
      buildScopedFsApi(depsFor(root), PLUGIN_ID, SCOPE).readFileBounded!(outside, {
        limitBytes: 16,
      })
    ).rejects.toThrow();
    await expect(
      buildScopedFsApi(depsFor(root, []), PLUGIN_ID, SCOPE).readFileBounded!(target, {
        limitBytes: 16,
      })
    ).rejects.toThrow(/PERMISSION_REQUIRED/);
  });

  it("refuses a limit that is not a byte count", async () => {
    const target = path.join(root, "small.txt");
    await fs.writeFile(target, "x");
    const api = buildScopedFsApi(depsFor(root), PLUGIN_ID, SCOPE);

    await expect(api.readFileBounded!(target, { limitBytes: -1 })).rejects.toThrow(/limitBytes/);
  });

  it("leaves the uncapped reads beside it uncapped", async () => {
    // Other plugins depend on `readFile` having no size ceiling; the bounded
    // read is an addition, not a new policy over the existing surface.
    const target = path.join(root, "big.txt");
    const contents = "y".repeat(2 * 1024 * 1024);
    await fs.writeFile(target, contents);
    const api = buildScopedFsApi(depsFor(root), PLUGIN_ID, SCOPE);

    expect((await api.readFile(target)).length).toBe(contents.length);
    expect((await api.readFileBytes(target)).byteLength).toBe(contents.length);
  });
});
