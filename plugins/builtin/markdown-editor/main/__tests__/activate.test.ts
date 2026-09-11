import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { activate } from "../index.js";
import { __resetKeyedMutexForTests } from "../../../../../electron/utils/keyedMutex.js";
import {
  CHANNELS,
  PUSH_CHANNELS,
  type DocumentIdentity,
  type DocumentReadResult,
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
 * target) closely enough to drive the plugin's save paths; the host's own
 * tests prove the real implementation.
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
  };
  fake.host = {
    pluginId: "daintree.markdown-editor",
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    fs: {
      readFile: (filePath: string) => fs.readFile(filePath, "utf-8"),
      readFileBytes: async (filePath: string) => new Uint8Array(await fs.readFile(filePath)),
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
      fake.wake?.();
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(fake.pushes).toEqual([]);
      await fs.writeFile(identity.filePath, "# Plan changed\n");
      fake.wake?.();
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(fake.pushes).toHaveLength(1);
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

    const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

    it("the recover action switches project when needed and retries until acknowledged", async () => {
      await call(CHANNELS.draftPut, {
        record: { ...record, identity: { ...identity, projectId: "p2" } },
        generation: 1,
      });
      fake.quickPick = (items) => items[0];
      fake.activeProjectId = "p1";
      const run = fake.action!({});
      await sleep(70);
      expect(fake.dispatched).toEqual([{ actionId: "project.switch", args: { projectId: "p2" } }]);
      // One immediate push plus retries every 20ms until acknowledged.
      const recoverPushes = fake.pushes.filter((p) => p.channel === PUSH_CHANNELS.recoverDraft);
      expect(recoverPushes.length).toBeGreaterThanOrEqual(2);
      const requestId = (recoverPushes[0]!.payload as { requestId: string }).requestId;
      expect(await call(CHANNELS.recoverAck, { requestId })).toEqual({ acknowledged: true });
      await expect(run).resolves.toEqual({ recovered: true });
      const after = fake.pushes.length;
      await sleep(60);
      expect(fake.pushes.length).toBe(after);
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
