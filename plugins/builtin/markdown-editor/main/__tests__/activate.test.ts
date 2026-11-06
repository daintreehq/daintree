import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs, { type FileHandle } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { activate } from "../index.js";
import { __resetKeyedMutexForTests } from "../../../../../electron/utils/keyedMutex.js";
import { readBoundedFromHandle } from "../../../../../electron/utils/boundedRead.js";
import {
  CHANNELS,
  MAX_EDITABLE_BYTES,
  PUSH_CHANNELS,
  type DocumentIdentity,
  type DocumentReadResult,
  type DocumentRevalidateResult,
  type DocumentSaveAsResult,
  type DocumentSaveResult,
  type DraftPutResult,
} from "../../shared/protocol.js";
import type {
  PluginHostApi,
  PluginIpcContext,
  PluginQuickPickItem,
} from "../../../../../shared/types/plugin.js";

/**
 * A host stand-in over a real temp directory. `fs.writeFile` reproduces the
 * host's checked-write contract (revision compare, create-new, missing
 * target) closely enough to drive the plugin's save paths, and `fs.readFiles`
 * stops at `maxBytesPerFile` through the host's own bounded read; the host's
 * own tests prove the real implementation. `largestRead` is the most bytes any
 * read handed the plugin, which bounds what it could have hashed or returned.
 */
type Handler = (ctx: PluginIpcContext, args: unknown) => unknown;

interface FakeHost {
  host: PluginHostApi;
  handlers: Map<string, Handler>;
  pushes: Array<{ channel: string; payload: unknown }>;
  watchers: Array<{ paths: string[]; callback: (changed: string) => void; disposed: boolean }>;
  wake: (() => void) | null;
  action: ((args: unknown) => unknown) | null;
  quickPick: (items: PluginQuickPickItem[]) => PluginQuickPickItem | undefined;
  dispatched: Array<{ actionId: string; args: unknown }>;
  toasts: Array<{ message: string }>;
  activeProjectId: string;
  largestRead: number;
}

const sha = (bytes: Uint8Array | string) =>
  createHash("sha256")
    .update(typeof bytes === "string" ? Buffer.from(bytes, "utf-8") : bytes)
    .digest("hex");

function fsError(code: string, message: string): Error & { code: string } {
  const error = new Error(`${code}: ${message}`) as Error & { code: string };
  error.code = code;
  return error;
}

function makeHost(): FakeHost {
  const fake: FakeHost = {
    host: null as unknown as PluginHostApi,
    handlers: new Map(),
    pushes: [],
    watchers: [],
    wake: null,
    action: null,
    quickPick: () => undefined,
    dispatched: [],
    toasts: [],
    activeProjectId: "p1",
    largestRead: 0,
  };
  const recordRead = (length: number) => {
    fake.largestRead = Math.max(fake.largestRead, length);
  };
  fake.host = {
    pluginId: "daintree.markdown-editor",
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    fs: {
      readFile: (filePath: string) => fs.readFile(filePath, "utf-8"),
      readFileBytes: async (filePath: string) => {
        const bytes = new Uint8Array(await fs.readFile(filePath));
        recordRead(bytes.length);
        return bytes;
      },
      readFiles: async (
        paths: readonly string[],
        options?: { encoding?: "utf-8" | "bytes"; maxBytesPerFile?: number }
      ) =>
        Promise.all(
          paths.map(async (filePath) => {
            const fail = (code: string) => ({
              path: filePath,
              ok: false as const,
              error: { code, message: code },
            });
            let handle: FileHandle;
            try {
              handle = await fs.open(filePath, "r");
            } catch (error) {
              const code = (error as NodeJS.ErrnoException).code;
              return fail(code === "ENOENT" ? "NOT_FOUND" : "READ_FAILED");
            }
            try {
              const opened = await handle.stat();
              if (!opened.isFile()) return fail("NOT_A_FILE");
              const bytes = await readBoundedFromHandle(
                handle,
                opened.size,
                options?.maxBytesPerFile ?? Number.MAX_SAFE_INTEGER
              );
              if (bytes === null) return fail("TOO_LARGE");
              recordRead(bytes.length);
              return {
                path: filePath,
                ok: true as const,
                content:
                  options?.encoding === "bytes" ? new Uint8Array(bytes) : bytes.toString("utf-8"),
              };
            } finally {
              await handle.close();
            }
          })
        ),
      writeFile: async (
        filePath: string,
        contents: string,
        options?: { expectedRevision?: string | null }
      ) => {
        if (options !== undefined) {
          const current = await fs.readFile(filePath).catch(() => null);
          const expected = options.expectedRevision;
          if (expected === null && current !== null) throw fsError("TARGET_EXISTS", "exists");
          if (typeof expected === "string") {
            if (current === null) throw fsError("TARGET_UNAVAILABLE", "gone");
            const currentRevision = sha(current);
            if (currentRevision !== expected) {
              const error = fsError("REVISION_MISMATCH", "changed") as Error & {
                code: string;
                currentRevision: string;
              };
              error.currentRevision = currentRevision;
              throw error;
            }
          }
        }
        await fs.mkdir(path.dirname(filePath), { recursive: true });
        await fs.writeFile(filePath, contents, "utf-8");
        return { revision: sha(contents) };
      },
      readdir: async (dirPath: string) => {
        const entries = await fs.readdir(dirPath, { withFileTypes: true });
        return Promise.all(
          entries.map(async (entry) => {
            const stat = await fs.lstat(path.join(dirPath, entry.name));
            return {
              name: entry.name,
              isDirectory: entry.isDirectory(),
              isFile: entry.isFile(),
              isSymbolicLink: entry.isSymbolicLink(),
              size: stat.size,
              mtimeMs: stat.mtimeMs,
            };
          })
        );
      },
      stat: async (target: string) => {
        const stat = await fs.stat(target);
        return {
          isDirectory: stat.isDirectory(),
          isFile: stat.isFile(),
          isSymbolicLink: false,
          size: stat.size,
          mtimeMs: stat.mtimeMs,
        };
      },
      watch: async (paths: string[], callback: (changed: string) => void) => {
        const entry = { paths, callback, disposed: false };
        fake.watchers.push(entry);
        return () => {
          entry.disposed = true;
        };
      },
    },
    registerHandler: async (channel: string, _schema: unknown, handler: Handler) => {
      fake.handlers.set(channel, handler);
    },
    registerAction: async (_descriptor: unknown, handler: (args: unknown) => unknown) => {
      fake.action = handler;
    },
    postToPanel: async (channel: string, payload: unknown) => {
      fake.pushes.push({ channel, payload });
    },
    onDidWake: async (callback: () => void) => {
      fake.wake = callback;
      return () => {
        fake.wake = null;
      };
    },
    showToast: async (options: { message: string }) => {
      fake.toasts.push({ message: options.message });
    },
    showQuickPick: async (items: PluginQuickPickItem[]) => fake.quickPick(items),
    dispatch: async (actionId: string, args: unknown) => {
      fake.dispatched.push({ actionId, args });
      return { ok: true, result: undefined };
    },
    getWorktreesResult: async () => ({
      status: "ok" as const,
      projectId: fake.activeProjectId,
      worktrees: [],
    }),
  } as unknown as PluginHostApi;
  return fake;
}

const ctx: PluginIpcContext = {
  projectId: "p1",
  worktreeId: null,
  webContentsId: 1,
  pluginId: "x",
};

let dir: string;
let fake: FakeHost;
let dispose: () => void;
let identity: DocumentIdentity;
let homedirSpy: ReturnType<typeof vi.spyOn>;

async function call<T>(channel: string, args: unknown): Promise<T> {
  const handler = fake.handlers.get(channel);
  if (!handler) throw new Error(`no handler for ${channel}`);
  return (await handler(ctx, args)) as T;
}

beforeEach(async () => {
  __resetKeyedMutexForTests();
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "md-editor-"));
  // The draft store lives under the (faked) home directory.
  homedirSpy = vi.spyOn(os, "homedir").mockReturnValue(path.join(dir, "home"));
  await fs.mkdir(path.join(dir, "repo", "docs"), { recursive: true });
  identity = {
    projectId: "p1",
    worktreePath: path.join(dir, "repo"),
    filePath: path.join(dir, "repo", "docs", "plan.md"),
  };
  fake = makeHost();
  dispose = await activate(fake.host, { recoverAckRetryMs: 20, recoverAckTimeoutMs: 300 });
});

afterEach(async () => {
  vi.useRealTimers();
  dispose();
  homedirSpy.mockRestore();
  await fs.rm(dir, { recursive: true, force: true });
});

describe("markdown-editor main (#12323)", () => {
  describe("document.read", () => {
    it("returns the decoded document and starts one directory watch", async () => {
      await fs.writeFile(identity.filePath, "# Plan\r\n\r\nBody\r\n");
      const result = await call<DocumentReadResult>(CHANNELS.read, { identity, panelId: "a" });
      expect(result).toMatchObject({
        status: "ok",
        text: "# Plan\n\nBody\n",
        eol: "\r\n",
        mixedEol: false,
        hasBom: false,
      });
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(fake.watchers).toHaveLength(1);
      expect(fake.watchers[0]?.paths).toEqual([path.dirname(identity.filePath)]);
      // A second panel on the same document shares the watch.
      await call(CHANNELS.read, { identity, panelId: "b" });
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(fake.watchers).toHaveLength(1);
    });

    it("refuses non-Markdown, oversized, undecodable and symlinked targets", async () => {
      const mdx = { ...identity, filePath: path.join(dir, "repo", "page.mdx") };
      await fs.writeFile(mdx.filePath, "x");
      expect(await call(CHANNELS.read, { identity: mdx, panelId: "a" })).toEqual({
        status: "refused",
        reason: "NOT_MARKDOWN",
      });

      await fs.writeFile(identity.filePath, Buffer.alloc(2 * 1024 * 1024 + 1, 0x61));
      expect(await call(CHANNELS.read, { identity, panelId: "a" })).toEqual({
        status: "refused",
        reason: "TOO_LARGE",
      });

      await fs.writeFile(identity.filePath, Buffer.from([0x23, 0xff, 0xfe]));
      expect(await call(CHANNELS.read, { identity, panelId: "a" })).toEqual({
        status: "refused",
        reason: "NOT_UTF8",
      });

      const real = path.join(dir, "repo", "docs", "real.md");
      await fs.writeFile(real, "# real\n");
      const link = { ...identity, filePath: path.join(dir, "repo", "docs", "link.md") };
      await fs.symlink(real, link.filePath);
      expect(await call(CHANNELS.read, { identity: link, panelId: "a" })).toEqual({
        status: "refused",
        reason: "SYMLINK",
      });
    });

    it("reports a missing file as unavailable", async () => {
      expect(await call(CHANNELS.read, { identity, panelId: "a" })).toEqual({
        status: "unavailable",
      });
    });
  });

  describe("document.save", () => {
    async function open(text: string) {
      await fs.writeFile(identity.filePath, text);
      const read = await call<DocumentReadResult>(CHANNELS.read, { identity, panelId: "a" });
      if (read.status !== "ok") throw new Error(read.status);
      return read;
    }

    it("an unedited save writes nothing and returns the same revision", async () => {
      const read = await open("# Plan\n");
      const before = await fs.stat(identity.filePath);
      await new Promise((resolve) => setTimeout(resolve, 5));
      const result = await call<DocumentSaveResult>(CHANNELS.save, {
        identity,
        text: read.text,
        expectedRevision: read.revision,
        unchanged: true,
        hasBom: read.hasBom,
        eol: read.eol,
      });
      expect(result).toEqual({ status: "saved", revision: read.revision, wrote: false });
      expect((await fs.stat(identity.filePath)).mtimeMs).toBe(before.mtimeMs);
    });

    it("an unedited save over a file that moved reports the conflict rather than success", async () => {
      const read = await open("# Plan\n");
      await fs.writeFile(identity.filePath, "# Plan\n\nagent wrote this\n");
      const result = await call<DocumentSaveResult>(CHANNELS.save, {
        identity,
        text: read.text,
        expectedRevision: read.revision,
        unchanged: true,
        hasBom: read.hasBom,
        eol: read.eol,
      });
      expect(result).toMatchObject({ status: "conflict", text: "# Plan\n\nagent wrote this\n" });
    });

    it("an edited save writes exactly the buffer with BOM and CRLF re-applied", async () => {
      const read = await open("\uFEFF# Plan\r\n\r\nBody\r\n");
      expect(read.hasBom).toBe(true);
      const result = await call<DocumentSaveResult>(CHANNELS.save, {
        identity,
        text: "# Plan\n\nBody edited\n",
        expectedRevision: read.revision,
        unchanged: false,
        hasBom: read.hasBom,
        eol: read.eol,
      });
      expect(result).toMatchObject({ status: "saved", wrote: true });
      const bytes = await fs.readFile(identity.filePath);
      expect(bytes.subarray(0, 3)).toEqual(Buffer.from([0xef, 0xbb, 0xbf]));
      expect(bytes.subarray(3).toString("utf-8")).toBe("# Plan\r\n\r\nBody edited\r\n");
      expect(result.status === "saved" && result.revision).toBe(sha(new Uint8Array(bytes)));
    });

    it("a stale save is refused as a conflict carrying the disk text, and writes nothing", async () => {
      const read = await open("# Plan\n");
      await fs.writeFile(identity.filePath, "# Plan\n\nsomeone else\n");
      const result = await call<DocumentSaveResult>(CHANNELS.save, {
        identity,
        text: "# Plan\n\nmine\n",
        expectedRevision: read.revision,
        unchanged: false,
        hasBom: false,
        eol: "\n",
      });
      expect(result).toMatchObject({
        status: "conflict",
        text: "# Plan\n\nsomeone else\n",
        revision: sha("# Plan\n\nsomeone else\n"),
      });
      expect(await fs.readFile(identity.filePath, "utf-8")).toBe("# Plan\n\nsomeone else\n");
    });

    it("a deleted file reports unavailable and the draft is never recreated", async () => {
      const read = await open("# Plan\n");
      await fs.unlink(identity.filePath);
      const result = await call<DocumentSaveResult>(CHANNELS.save, {
        identity,
        text: "# Plan\n\nmine\n",
        expectedRevision: read.revision,
        unchanged: false,
        hasBom: false,
        eol: "\n",
      });
      expect(result).toEqual({ status: "unavailable" });
      await expect(fs.stat(identity.filePath)).rejects.toThrow();
    });

    it("a save the host refuses because another screen drives the project says to take control", async () => {
      const read = await open("# Plan\n");
      const wording = "greg-mbp has control of this project. Take control first.";
      vi.spyOn(fake.host.fs, "writeFile").mockRejectedValueOnce(
        Object.assign(fsError("DRIVEN_ELSEWHERE", wording), { userMessage: wording })
      );
      const result = await call<DocumentSaveResult>(CHANNELS.save, {
        identity,
        text: "# Plan\n\nmine\n",
        expectedRevision: read.revision,
        unchanged: false,
        hasBom: false,
        eol: "\n",
      });
      expect(result).toEqual({ status: "error", message: wording });
      expect(await fs.readFile(identity.filePath, "utf-8")).toBe("# Plan\n");
    });

    it("refuses the write boundary for a non-Markdown path and an oversized buffer", async () => {
      const read = await open("# Plan\n");
      expect(
        await call(CHANNELS.save, {
          identity: { ...identity, filePath: path.join(dir, "repo", "x.txt") },
          text: "x",
          expectedRevision: read.revision,
          unchanged: false,
          hasBom: false,
          eol: "\n",
        })
      ).toEqual({ status: "refused", reason: "NOT_MARKDOWN" });
      expect(
        await call(CHANNELS.save, {
          identity,
          text: "a".repeat(2 * 1024 * 1024 + 1),
          expectedRevision: read.revision,
          unchanged: false,
          hasBom: false,
          eol: "\n",
        })
      ).toEqual({ status: "refused", reason: "TOO_LARGE" });
    });
  });

  describe("document.saveAs", () => {
    it("refuses a target outside the document's own root", async () => {
      const outside = path.join(dir, "elsewhere.md");
      const result = await call<DocumentSaveAsResult>(CHANNELS.saveAs, {
        identity,
        targetPath: outside,
        text: "draft\n",
        hasBom: false,
        eol: "\n",
      });
      expect(result).toEqual({ status: "refused", reason: "OUTSIDE_ROOT" });
      await expect(fs.stat(outside)).rejects.toThrow();
    });

    it("creates a new Markdown file and refuses an existing one", async () => {
      const target = path.join(dir, "repo", "docs", "plan-draft.md");
      const first = await call<DocumentSaveAsResult>(CHANNELS.saveAs, {
        identity,
        targetPath: target,
        text: "draft\n",
        hasBom: false,
        eol: "\n",
      });
      expect(first).toMatchObject({ status: "saved", path: target });
      expect(await fs.readFile(target, "utf-8")).toBe("draft\n");
      const second = await call<DocumentSaveAsResult>(CHANNELS.saveAs, {
        identity,
        targetPath: target,
        text: "draft 2\n",
        hasBom: false,
        eol: "\n",
      });
      expect(second).toEqual({ status: "exists" });
      expect(await fs.readFile(target, "utf-8")).toBe("draft\n");
    });

    it("drops the code from a lease refusal that reaches it as a message alone", async () => {
      const target = path.join(dir, "repo", "docs", "plan-draft.md");
      vi.spyOn(fake.host.fs, "writeFile").mockRejectedValueOnce(
        fsError(
          "DRIVEN_ELSEWHERE",
          "Another screen has control of this project. Take control first."
        )
      );
      const result = await call<DocumentSaveAsResult>(CHANNELS.saveAs, {
        identity,
        targetPath: target,
        text: "draft\n",
        hasBom: false,
        eol: "\n",
      });
      expect(result).toEqual({
        status: "error",
        message: "Another screen has control of this project. Take control first.",
      });
      await expect(fs.stat(target)).rejects.toThrow();
    });
  });

  describe("watch, release and wake", () => {
    it("posts document-changed only for the watched file, and drops the watch on the last release", async () => {
      await fs.writeFile(identity.filePath, "# Plan\n");
      await call(CHANNELS.read, { identity, panelId: "a" });
      await call(CHANNELS.read, { identity, panelId: "b" });
      await new Promise((resolve) => setTimeout(resolve, 0));
      const watcher = fake.watchers[0]!;
      watcher.callback(path.join(dir, "repo", "docs", "other.md"));
      expect(fake.pushes).toEqual([]);
      watcher.callback(identity.filePath);
      expect(fake.pushes).toEqual([
        { channel: PUSH_CHANNELS.documentChanged, payload: { identityKey: expect.any(String) } },
      ]);

      await call(CHANNELS.release, { identity, panelId: "a" });
      expect(watcher.disposed).toBe(false);
      await call(CHANNELS.release, { identity, panelId: "b" });
      expect(watcher.disposed).toBe(true);
    });

    it("concurrent reads of one document share a single watch", async () => {
      await fs.writeFile(identity.filePath, "# Plan\n");
      await Promise.all([
        call(CHANNELS.read, { identity, panelId: "a" }),
        call(CHANNELS.read, { identity, panelId: "b" }),
      ]);
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(fake.watchers).toHaveLength(1);
    });

    it("a second panel attaches without a read and keeps the watch alive after the first leaves", async () => {
      await fs.writeFile(identity.filePath, "# Plan\n");
      await call(CHANNELS.read, { identity, panelId: "a" });
      expect(await call(CHANNELS.attach, { identity, panelId: "b" })).toEqual({ attached: true });
      await new Promise((resolve) => setTimeout(resolve, 0));
      await call(CHANNELS.release, { identity, panelId: "a" });
      expect(fake.watchers[0]?.disposed).toBe(false);
      await call(CHANNELS.release, { identity, panelId: "b" });
      expect(fake.watchers[0]?.disposed).toBe(true);
    });

    it("a release that lands while the read is in flight leaves no watch behind", async () => {
      await fs.writeFile(identity.filePath, "# Plan\n");
      const reading = call(CHANNELS.read, { identity, panelId: "a" });
      await call(CHANNELS.release, { identity, panelId: "a" });
      await reading;
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(fake.watchers.filter((w) => !w.disposed)).toHaveLength(0);
    });

    it("a wake re-hashes open documents and announces the ones that moved", async () => {
      await fs.writeFile(identity.filePath, "# Plan\n");
      await call(CHANNELS.read, { identity, panelId: "a" });
      // Waited on the re-hash's own read rather than a clock, which a loaded
      // machine can outrun: it has to land before the file moves.
      const reads = vi.spyOn(fake.host.fs, "readFiles");
      fake.wake?.();
      await vi.waitFor(() => expect(reads).toHaveBeenCalledTimes(1));
      await reads.mock.results[0]!.value;
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(fake.pushes).toEqual([]);
      await fs.writeFile(identity.filePath, "# Plan changed\n");
      fake.wake?.();
      await vi.waitFor(() => expect(fake.pushes).toHaveLength(1));
    });
  });

  describe("a document whose disk file grows past the ceiling (#15608)", () => {
    // One byte over, so a weaker cap than the ceiling would read it whole and
    // show up in `largestRead` instead of being refused on its size alone.
    const oversized = () => Buffer.alloc(MAX_EDITABLE_BYTES + 1, 0x61);
    let uncapped: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      uncapped = vi.spyOn(fake.host.fs, "readFileBytes");
    });

    /** Nothing the plugin held, hashed or returned can be larger than what it was handed. */
    function expectBounded() {
      expect(uncapped).not.toHaveBeenCalled();
      expect(fake.largestRead).toBeLessThanOrEqual(MAX_EDITABLE_BYTES);
    }

    async function openThenGrow() {
      await fs.writeFile(identity.filePath, "# Plan\n");
      const read = await call<DocumentReadResult>(CHANNELS.read, { identity, panelId: "a" });
      if (read.status !== "ok") throw new Error(read.status);
      await fs.writeFile(identity.filePath, oversized());
      return read;
    }

    async function settleWake() {
      const reads = vi.spyOn(fake.host.fs, "readFiles");
      reads.mockClear();
      fake.wake?.();
      await vi.waitFor(() => expect(reads).toHaveBeenCalledTimes(1));
      await reads.mock.results[0]!.value;
      await new Promise((resolve) => setTimeout(resolve, 0));
    }

    it("a file of exactly the ceiling still opens", async () => {
      await fs.writeFile(identity.filePath, Buffer.alloc(MAX_EDITABLE_BYTES, 0x61));
      expect(await call(CHANNELS.read, { identity, panelId: "a" })).toMatchObject({
        status: "ok",
        size: MAX_EDITABLE_BYTES,
      });
      expectBounded();
    });

    it("a read refuses it as too large without reading it whole, and keeps watching it", async () => {
      await fs.writeFile(identity.filePath, oversized());
      expect(await call(CHANNELS.read, { identity, panelId: "a" })).toEqual({
        status: "refused",
        reason: "TOO_LARGE",
      });
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(fake.watchers).toHaveLength(1);
      expectBounded();
      // The refusal is what this side observed, so a wake has nothing new to say.
      await settleWake();
      expect(fake.pushes).toEqual([]);
    });

    it("a release that lands while an oversized read is in flight leaves no watch behind", async () => {
      await fs.writeFile(identity.filePath, oversized());
      const reading = call(CHANNELS.read, { identity, panelId: "a" });
      await call(CHANNELS.release, { identity, panelId: "a" });
      expect(await reading).toEqual({ status: "refused", reason: "TOO_LARGE" });
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(fake.watchers.filter((w) => !w.disposed)).toHaveLength(0);
    });

    it("revalidate reports it as too large without reading or hashing it, and its revision once it shrinks", async () => {
      await openThenGrow();
      expect(await call<DocumentRevalidateResult>(CHANNELS.revalidate, { identity })).toEqual({
        status: "too-large",
      });
      expectBounded();
      await fs.writeFile(identity.filePath, "# Smaller\n");
      expect(await call<DocumentRevalidateResult>(CHANNELS.revalidate, { identity })).toEqual({
        status: "ok",
        revision: sha("# Smaller\n"),
      });
    });

    it("a wake announces it without reading it whole, stays quiet while it stays oversized, and announces the shrink", async () => {
      await openThenGrow();
      await settleWake();
      expect(fake.pushes).toHaveLength(1);
      // The view answers the push with a revalidate, which records what it saw.
      await call(CHANNELS.revalidate, { identity });
      await fs.appendFile(identity.filePath, "more");
      await settleWake();
      expect(fake.pushes).toHaveLength(1);
      expectBounded();
      await fs.writeFile(identity.filePath, "# Smaller\n");
      await settleWake();
      expect(fake.pushes).toHaveLength(2);
    });

    it("an unedited save is held as too large", async () => {
      const read = await openThenGrow();
      const result = await call<DocumentSaveResult>(CHANNELS.save, {
        identity,
        text: read.text,
        expectedRevision: read.revision,
        unchanged: true,
        hasBom: read.hasBom,
        eol: read.eol,
      });
      expect(result).toEqual({ status: "too-large" });
      expectBounded();
      await settleWake();
      expect(fake.pushes).toEqual([]);
    });

    it("a stale edited save is held as too large before the host's revision compare, and writes nothing", async () => {
      const read = await openThenGrow();
      const writes = vi.spyOn(fake.host.fs, "writeFile");
      const result = await call<DocumentSaveResult>(CHANNELS.save, {
        identity,
        text: "# Plan\n\nmine\n",
        expectedRevision: read.revision,
        unchanged: false,
        hasBom: false,
        eol: "\n",
      });
      expect(result).toEqual({ status: "too-large" });
      expect(writes).not.toHaveBeenCalled();
      expectBounded();
      expect((await fs.stat(identity.filePath)).size).toBe(MAX_EDITABLE_BYTES + 1);
    });

    it("a save that loses the race to a file growing after the check is held as too large", async () => {
      const read = await openThenGrow();
      await fs.writeFile(identity.filePath, "# Plan\n");
      vi.spyOn(fake.host.fs, "writeFile").mockImplementationOnce(async () => {
        await fs.writeFile(identity.filePath, oversized());
        throw fsError("REVISION_MISMATCH", "changed");
      });
      const result = await call<DocumentSaveResult>(CHANNELS.save, {
        identity,
        text: "# Plan\n\nmine\n",
        expectedRevision: read.revision,
        unchanged: false,
        hasBom: false,
        eol: "\n",
      });
      expect(result).toEqual({ status: "too-large" });
      expectBounded();
    });

    it("without the host's bounded read every document read fails closed, never uncapped", async () => {
      await fs.writeFile(identity.filePath, "# Plan\n");
      delete (fake.host.fs as { readFiles?: unknown }).readFiles;
      expect(await call(CHANNELS.read, { identity, panelId: "a" })).toEqual({
        status: "unavailable",
      });
      expect(await call(CHANNELS.revalidate, { identity })).toEqual({ status: "unavailable" });
      expect(uncapped).not.toHaveBeenCalled();
    });
  });

  describe("drafts and recovery", () => {
    const record = {
      stateVersion: 1 as const,
      identity: null as unknown as DocumentIdentity,
      baseRevision: "a".repeat(64),
      baseText: "# Plan\n",
      draftText: "# Plan\n\ndraft\n",
      hasBom: false,
      eol: "\n" as const,
      updatedAt: 5,
    };

    it("stores drafts under the plugin data dir and lists them for recovery", async () => {
      const result = await call<DraftPutResult>(CHANNELS.draftPut, {
        record: { ...record, identity },
        generation: 1,
      });
      expect(result).toEqual({ status: "stored" });
      const stored = await fs.readdir(
        path.join(dir, "home", ".daintree", "plugin-data", "daintree.markdown-editor", "drafts")
      );
      expect(stored).toHaveLength(1);
      expect(await call(CHANNELS.draftList, {})).toEqual({
        drafts: [{ identity, updatedAt: 5, bytes: expect.any(Number) }],
      });
      expect(await call(CHANNELS.draftDelete, { identity, generation: 2 })).toEqual({
        deleted: true,
      });
      expect(await call(CHANNELS.draftGet, { identity })).toEqual({ record: null });
    });

    it("the recover action switches project when needed and retries until acknowledged", async () => {
      await call(CHANNELS.draftPut, {
        record: { ...record, identity: { ...identity, projectId: "p2" } },
        generation: 1,
      });
      fake.quickPick = (items) => items[0];
      fake.activeProjectId = "p1";
      // Only the retry and give-up timers are faked. The draft listing before
      // the first push is real fs I/O, and against a wall-clock sleep a slow
      // disk or GC pause there left one push where the test expected two.
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
      const recoverPushes = () =>
        fake.pushes.filter((p) => p.channel === PUSH_CHANNELS.recoverDraft);
      const run = fake.action!({});
      while (recoverPushes().length === 0) {
        await new Promise((resolve) => setImmediate(resolve));
      }
      expect(fake.dispatched).toEqual([{ actionId: "project.switch", args: { projectId: "p2" } }]);
      expect(recoverPushes()).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(20);
      expect(recoverPushes()).toHaveLength(2);
      await vi.advanceTimersByTimeAsync(40);
      expect(recoverPushes()).toHaveLength(4);
      const requestId = (recoverPushes()[0]!.payload as { requestId: string }).requestId;
      expect(
        recoverPushes().every((p) => (p.payload as { requestId: string }).requestId === requestId)
      ).toBe(true);
      expect(await call(CHANNELS.recoverAck, { requestId })).toEqual({ acknowledged: true });
      await expect(run).resolves.toEqual({ recovered: true });
      const after = fake.pushes.length;
      // Past the 300ms give-up deadline too: acknowledging must clear both timers.
      await vi.advanceTimersByTimeAsync(1_000);
      expect(fake.pushes.length).toBe(after);
      expect(fake.toasts).toEqual([]);
    });

    it("the recover action gives up after the timeout and says where the draft is", async () => {
      await call(CHANNELS.draftPut, { record: { ...record, identity }, generation: 1 });
      fake.quickPick = (items) => items[0];
      await expect(fake.action!({})).resolves.toEqual({ recovered: false });
      expect(fake.toasts.some((t) => t.message.startsWith("Couldn't open the draft"))).toBe(true);
      expect(await call(CHANNELS.recoverAck, { requestId: "stale" })).toEqual({
        acknowledged: false,
      });
    });

    it("the recover action tells the user when there is nothing to recover", async () => {
      await expect(fake.action!({})).resolves.toEqual({ recovered: false });
      expect(fake.toasts.some((t) => t.message.startsWith("No Markdown drafts to recover"))).toBe(
        true
      );
    });
  });
});
