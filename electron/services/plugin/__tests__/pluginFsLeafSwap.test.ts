// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs/promises";
import { rmSync, symlinkSync } from "node:fs";
import { createHash } from "node:crypto";
import os from "os";
import path from "path";
import { buildScopedFsApi } from "../PluginHostFactory.js";
import type { PluginHostFactoryDeps } from "../PluginHostFactory.js";
import type { BuiltinPluginFsApi } from "../../../../shared/types/plugin.js";
import { runExclusive } from "../../../utils/keyedMutex.js";

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

// Passthrough, so a test can tell when a write has actually joined the queue
// rather than guessing with timers.
vi.mock("../../../utils/keyedMutex.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../utils/keyedMutex.js")>();
  return { ...actual, runExclusive: vi.fn(actual.runExclusive) };
});

/**
 * #12618: a `host.fs` leaf that changes between containment and the syscall
 * that uses it. Containment realpaths the path once; everything after that
 * must either prove the entry is still the one it approved or refuse.
 *
 * The deps are the few the filesystem surface consults. The plugin is a
 * built-in so the write skips the consent prompt; the hooks below stand in for
 * the waits a real prompt or queue would add.
 */
const PLUGIN_ID = "leaf-swap-test";
const SCOPE = { projectId: "p1", worktreeId: "w1" };

const sha = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");

interface Harness {
  deps: PluginHostFactoryDeps;
  api: BuiltinPluginFsApi;
  /** Runs once, synchronously, at the first capability check after containment. */
  afterContainment(fn: () => void): void;
  containmentCalls(): number;
}

function harness(root: string, dataDir: string): Harness {
  let contained = false;
  let pending: (() => void) | null = null;
  let containments = 0;
  const deps = {
    plugins: new Map([[PLUGIN_ID, { isBuiltin: true }]]),
    declaredCapabilities: () => {
      if (contained && pending) {
        const fn = pending;
        pending = null;
        fn();
      }
      return new Set(["fs:project-read", "fs:project-write"]);
    },
    expandAllowedPathEntries: async () => {
      containments += 1;
      contained = true;
      return [{ path: root, rootClass: "project" }];
    },
    pluginDataDir: () => dataDir,
    isPathUnder: () => false,
    safeAppendAudit: vi.fn(),
    safeArgsHash: () => "hash",
  } as unknown as PluginHostFactoryDeps;
  return {
    deps,
    api: buildScopedFsApi(deps, PLUGIN_ID, SCOPE),
    afterContainment: (fn) => {
      pending = fn;
    },
    containmentCalls: () => containments,
  };
}

type ReadName = "readFile" | "readFileBytes" | "readFileBounded";

async function readAsText(
  api: BuiltinPluginFsApi,
  name: ReadName,
  target: string,
  signal?: AbortSignal
) {
  if (name === "readFile") return api.readFile(target, { signal });
  if (name === "readFileBytes") {
    return Buffer.from(await api.readFileBytes(target, { signal })).toString();
  }
  const read = await api.readFileBounded!(target, { limitBytes: 1 << 20, signal });
  if (read.status !== "ok") throw new Error(`unexpected ${read.status}`);
  return Buffer.from(read.bytes).toString();
}

let base: string;
let root: string;
let outside: string;

beforeEach(async () => {
  base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "plugin-fs-leaf-swap-")));
  root = path.join(base, "root");
  await fs.mkdir(root);
  outside = path.join(base, "outside.txt");
  await fs.writeFile(outside, "secret");
});

afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(base, { recursive: true, force: true });
});

describe.each<ReadName>(["readFile", "readFileBytes", "readFileBounded"])(
  "host.fs.%s against a leaf that changed after containment",
  (name) => {
    it.skipIf(process.platform === "win32")(
      "still follows a symlink the caller names inside the root",
      async () => {
        const { api } = harness(root, path.join(base, "data"));
        const real = path.join(root, "AGENTS.md");
        await fs.writeFile(real, "shared");
        const link = path.join(root, "CLAUDE.md");
        await fs.symlink(real, link);
        expect(await readAsText(api, name, link)).toBe("shared");
      }
    );

    it.skipIf(process.platform === "win32")(
      "refuses a leaf swapped for an outside symlink after containment",
      async () => {
        const h = harness(root, path.join(base, "data"));
        const target = path.join(root, "notes.md");
        await fs.writeFile(target, "mine");
        h.afterContainment(() => {
          rmSync(target);
          symlinkSync(outside, target);
        });
        await expect(readAsText(h.api, name, target)).rejects.toMatchObject({
          code: "TARGET_IS_SYMLINK",
          message: expect.stringMatching(/^TARGET_IS_SYMLINK:/),
        });
      }
    );

    it("refuses a descriptor that is not the file standing at the path", async () => {
      // What a platform without O_NOFOLLOW sees when the leaf is swapped for a
      // symlink, followed, and swapped back before anyone looks: the path is
      // an ordinary file again, but the descriptor is somewhere else.
      const { api } = harness(root, path.join(base, "data"));
      const target = path.join(root, "notes.md");
      await fs.writeFile(target, "mine");
      const realOpen = fs.open.bind(fs);
      vi.spyOn(fs, "open").mockImplementation(((file, flags, mode) =>
        realOpen(file === target ? outside : file, flags, mode)) as typeof fs.open);
      await expect(readAsText(api, name, target)).rejects.toMatchObject({
        code: "TARGET_UNAVAILABLE",
      });
    });

    it("honours an abort that lands during containment without opening the target", async () => {
      const h = harness(root, path.join(base, "data"));
      const target = path.join(root, "notes.md");
      await fs.writeFile(target, "mine");
      const controller = new AbortController();
      h.afterContainment(() => controller.abort());
      const openSpy = vi.spyOn(fs, "open");
      await expect(readAsText(h.api, name, target, controller.signal)).rejects.toMatchObject({
        name: "AbortError",
      });
      // An open cannot be cancelled, so a cancelled read must never start one.
      expect(openSpy.mock.calls.map((call) => call[0])).not.toContain(target);
    });
  }
);

describe("host.fs.writeFile while queued behind another writer", () => {
  /**
   * Hold `key`, start `write` behind it, run `duringWait` once the write has
   * joined the queue, then let it through and hand back how it settled.
   */
  async function whileQueued(
    key: string,
    write: () => Promise<unknown>,
    duringWait: () => void | Promise<void>
  ): Promise<unknown> {
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    const held = runExclusive(key, () => barrier);
    const outcome = write().catch((error: unknown) => error);
    try {
      await vi.waitFor(() => expect(vi.mocked(runExclusive)).toHaveBeenCalledTimes(2));
      await duringWait();
    } finally {
      release();
      await held;
    }
    return outcome;
  }

  beforeEach(() => {
    vi.mocked(runExclusive).mockClear();
  });

  it("rejects a write whose plugin unloaded while it waited, before touching the path", async () => {
    const h = harness(root, path.join(base, "data"));
    const target = path.join(root, "doc.md");
    await fs.writeFile(target, "before");
    const outcome = await whileQueued(
      target,
      () => h.api.writeFile(target, "after"),
      () => {
        h.deps.plugins.delete(PLUGIN_ID);
      }
    );
    expect(String(outcome)).toMatch(/PLUGIN_UNLOADED:/);
    // Refused on entering the critical section, not by a containment recheck
    // against an unloaded plugin's (now empty) roots.
    expect(h.containmentCalls()).toBe(1);
    expect(await fs.readFile(target, "utf-8")).toBe("before");
  });

  it.skipIf(process.platform === "win32")(
    "refuses a leaf swapped for an outside symlink while the write waited",
    async () => {
      const h = harness(root, path.join(base, "data"));
      const target = path.join(root, "doc.md");
      await fs.writeFile(target, "before");
      const outcome = await whileQueued(
        target,
        () => h.api.writeFile(target, "redirected"),
        async () => {
          await fs.rm(target);
          await fs.symlink(outside, target);
        }
      );
      expect(outcome).toMatchObject({ code: "TARGET_UNAVAILABLE" });
      expect(await fs.readFile(outside, "utf-8")).toBe("secret");
    }
  );

  it("never hashes a file the revision read did not verify", async () => {
    const h = harness(root, path.join(base, "data"));
    const target = path.join(root, "doc.md");
    await fs.writeFile(target, "v1");
    const realOpen = fs.open.bind(fs);
    vi.spyOn(fs, "open").mockImplementation(((file, flags, mode) =>
      realOpen(file === target ? outside : file, flags, mode)) as typeof fs.open);
    const caught = await h.api.writeFile(target, "v2", { expectedRevision: sha("v1") }).then(
      () => null,
      (error: unknown) => error as Error & { code?: string; currentRevision?: string }
    );
    expect(caught?.code).toBe("TARGET_UNAVAILABLE");
    expect(caught?.currentRevision).toBeUndefined();
    expect(await fs.readFile(target, "utf-8")).toBe("v1");
  });
});
