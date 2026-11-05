import { getEventListeners } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  app: { isPackaged: true, on: vi.fn(), getPath: vi.fn(() => os.tmpdir()) },
  webContents: { fromId: vi.fn(() => null), getAllWebContents: vi.fn(() => []) },
  BrowserWindow: { fromWebContents: vi.fn(() => null), getAllWindows: vi.fn(() => []) },
}));

import { LocalFolderPackError } from "../localFolderPack.js";
import type { LocalFolderWalkFs } from "../localFolderWalk.js";
import { createHostUploadClient } from "../uploadClient.js";

const GRANT_TTL_MS = 30 * 60_000;

let dir: string;

beforeEach(async () => {
  dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "upf-")));
});

afterEach(async () => {
  vi.useRealTimers();
  await fs.rm(dir, { recursive: true, force: true });
});

function setup(options: { walkFs?: LocalFolderWalkFs } = {}) {
  const gone = new Map<number, () => void>();
  const unwatched: number[] = [];
  const client = createHostUploadClient({
    transport: { upload: vi.fn() },
    hostForView: () => "studio-01",
    hostLabel: (hostId) => hostId,
    sendToView: () => {},
    localLabel: "This Mac",
    grantTtlMs: GRANT_TTL_MS,
    watchView: (webContentsId, onGone) => {
      gone.set(webContentsId, onGone);
      return () => unwatched.push(webContentsId);
    },
    walkOptions: options.walkFs ? { fs: options.walkFs } : undefined,
    packDir: path.join(dir, "packs"),
  });
  return { client, destroyView: (webContentsId: number) => gone.get(webContentsId)?.(), unwatched };
}

/** A folder holding `src/app.ts`, dropped in view 7. */
async function droppedFolder(client: ReturnType<typeof setup>["client"]) {
  const folder = path.join(dir, "Project");
  await fs.mkdir(path.join(folder, "src"), { recursive: true });
  await fs.writeFile(path.join(folder, "src", "app.ts"), "export {};");
  client.grantLocalSources(7, [folder]);
  return folder;
}

async function readyHandle(client: ReturnType<typeof setup>["client"], folder: string) {
  const result = await client.summarizeLocalFolder(7, { localPath: folder, opId: "op-walk" });
  if (result.status !== "ready") throw new Error("expected a ready folder");
  return result.handle;
}

describe("summarizing a dropped folder", () => {
  it("summarizes a granted folder and issues a handle for exactly what it counted", async () => {
    const { client } = setup();
    const folder = await droppedFolder(client);

    const result = await client.summarizeLocalFolder(7, { localPath: folder, opId: "op-walk" });

    expect(result.status).toBe("ready");
    if (result.status !== "ready") return;
    expect(result.summary.totals).toEqual({ fileCount: 1, folderCount: 1, totalBytes: 10 });
    expect(result.handle).toMatch(/^[0-9a-f]{32}$/);
    const snapshot = client.resolveFolderHandle(7, result.handle);
    expect(snapshot.localPath).toBe(folder);
    expect(snapshot.entries.map((entry) => entry.path)).toEqual([
      "Project/",
      "Project/src/",
      "Project/src/app.ts",
    ]);
    expect(Object.isFrozen(snapshot.entries)).toBe(true);
    // Each record too, since the packer copies exactly what each one says.
    expect(snapshot.entries.every((entry) => Object.isFrozen(entry))).toBe(true);
  });

  it("refuses a folder this view wasn't granted, and any path inside a granted one", async () => {
    const { client } = setup();
    const folder = await droppedFolder(client);

    await expect(
      client.summarizeLocalFolder(8, { localPath: folder, opId: "op-1" })
    ).rejects.toMatchObject({ code: "PERMISSION" });
    await expect(
      client.summarizeLocalFolder(7, { localPath: path.join(folder, "src"), opId: "op-2" })
    ).rejects.toMatchObject({ code: "PERMISSION" });
    await expect(
      client.summarizeLocalFolder(7, { localPath: "relative/folder", opId: "op-3" })
    ).rejects.toMatchObject({ code: "VALIDATION" });
  });

  it("keeps the folder's name out of every error, since packaged builds log them", async () => {
    const { client } = setup();
    const secret = path.join(dir, "ConfidentialAcquisition");
    await fs.mkdir(secret);
    const named = (error: unknown) => JSON.stringify(error, Object.getOwnPropertyNames(error));

    const ungranted = await client
      .summarizeLocalFolder(7, { localPath: secret, opId: "op-a" })
      .catch((error: unknown) => error);
    await fs.rm(secret, { recursive: true });
    client.grantLocalSources(7, [secret]);
    const vanished = await client
      .summarizeLocalFolder(7, { localPath: secret, opId: "op-b" })
      .catch((error: unknown) => error);

    expect(ungranted).toMatchObject({ code: "PERMISSION" });
    expect(vanished).toMatchObject({ code: "INVALID_PATH" });
    for (const error of [ungranted, vanished]) {
      expect(named(error)).not.toContain("ConfidentialAcquisition");
    }
  });

  it("names a dropped file as not a folder", async () => {
    const { client } = setup();
    const file = path.join(dir, "notes.txt");
    await fs.writeFile(file, "x");
    client.grantLocalSources(7, [file]);

    await expect(
      client.summarizeLocalFolder(7, { localPath: file, opId: "op-file" })
    ).rejects.toMatchObject({
      code: "NOT_A_DIRECTORY",
      userMessage: "That isn't a folder on This Mac.",
    });
  });

  it("issues no handle for a refused folder", async () => {
    const { client } = setup();
    const folder = path.join(dir, "Root");
    await fs.mkdir(folder);
    await fs.writeFile(path.join(folder, "bad\\name"), "x").catch(() => {});
    client.grantLocalSources(7, [folder]);
    if (process.platform === "win32") return;

    const result = await client.summarizeLocalFolder(7, { localPath: folder, opId: "op-bad" });

    expect(result).toMatchObject({ status: "refused", problem: { kind: "path" } });
    expect("handle" in result).toBe(false);
  });

  it("refuses a handle from any view but the one it was issued to, without ending it there", async () => {
    const { client } = setup();
    const handle = await readyHandle(client, await droppedFolder(client));
    client.grantLocalSources(8, [path.join(dir, "Project")]);

    expect(() => client.resolveFolderHandle(8, handle)).toThrow(
      expect.objectContaining({ code: "PERMISSION" })
    );
    expect(client.resolveFolderHandle(7, handle).rootName).toBe("Project");
    expect(() => client.resolveFolderHandle(7, "not-a-handle")).toThrow(
      expect.objectContaining({ code: "VALIDATION" })
    );
  });

  it("refuses a handle once the grant it was issued under expires, even after the folder is dropped again", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const { client } = setup();
    const folder = await droppedFolder(client);
    const handle = await readyHandle(client, folder);

    vi.setSystemTime(Date.now() + GRANT_TTL_MS - 1000);
    expect(client.resolveFolderHandle(7, handle).localPath).toBe(folder);
    client.grantLocalSources(7, [folder]);
    vi.setSystemTime(Date.now() + 2000);

    expect(() => client.resolveFolderHandle(7, handle)).toThrow(
      expect.objectContaining({ code: "PERMISSION" })
    );
  });

  it("drops the view's handles and grants when the view is destroyed", async () => {
    const { client, destroyView, unwatched } = setup();
    const folder = await droppedFolder(client);
    const handle = await readyHandle(client, folder);

    destroyView(7);

    expect(() => client.resolveFolderHandle(7, handle)).toThrow(
      expect.objectContaining({ code: "PERMISSION" })
    );
    await expect(
      client.summarizeLocalFolder(7, { localPath: folder, opId: "op-again" })
    ).rejects.toMatchObject({ code: "PERMISSION" });
    expect(unwatched).toEqual([7]);
  });

  it("keeps a view's newest handles when it has summarized many folders", async () => {
    const { client } = setup();
    const folder = await droppedFolder(client);
    const handles: string[] = [];
    for (let i = 0; i < 10; i++) {
      const result = await client.summarizeLocalFolder(7, { localPath: folder, opId: `op-${i}` });
      if (result.status === "ready") handles.push(result.handle);
    }

    expect(() => client.resolveFolderHandle(7, handles[0])).toThrow();
    expect(client.resolveFolderHandle(7, handles[9]!).rootName).toBe("Project");
  });

  describe("cancelling", () => {
    /** A walk whose root listing waits for `open()`. */
    function heldWalk() {
      let open!: () => void;
      const opened = new Promise<void>((resolve) => (open = resolve));
      let started!: () => void;
      const startedWalk = new Promise<void>((resolve) => (started = resolve));
      const walkFs: LocalFolderWalkFs = {
        opendir: async (folder, options) => {
          started();
          await opened;
          return fs.opendir(folder, options);
        },
        lstat: (target) => fs.lstat(target),
        readlink: (target) => fs.readlink(target),
        access: (target, mode) => fs.access(target, mode),
      };
      return { walkFs, open, startedWalk };
    }

    it("stops a running walk under its operation id, for the view that started it only", async () => {
      const held = heldWalk();
      const { client } = setup({ walkFs: held.walkFs });
      const folder = await droppedFolder(client);

      const walking = client.summarizeLocalFolder(7, { localPath: folder, opId: "op-walk" });
      await held.startedWalk;
      expect(client.cancel("op-walk", 8)).toBe(false);
      expect(client.cancel("op-walk", 7)).toBe(true);

      await expect(walking).rejects.toMatchObject({ code: "CANCELLED" });
      held.open();
    });

    it("keeps a cancelled walk's slot until the walk itself stops", async () => {
      const held = heldWalk();
      const { client } = setup({ walkFs: held.walkFs });
      const folder = await droppedFolder(client);

      const first = client.summarizeLocalFolder(7, { localPath: folder, opId: "op-1" });
      await held.startedWalk;
      const second = client.summarizeLocalFolder(7, { localPath: folder, opId: "op-2" });
      client.cancel("op-1", 7);
      client.cancel("op-2", 7);
      await expect(first).rejects.toMatchObject({ code: "CANCELLED" });
      await expect(second).rejects.toMatchObject({ code: "CANCELLED" });

      // Both walks are still waiting on the disk, so a third is turned away.
      await expect(
        client.summarizeLocalFolder(7, { localPath: folder, opId: "op-3" })
      ).rejects.toMatchObject({ code: "RATE_LIMITED" });
      held.open();
      await vi.waitFor(async () => {
        const result = await client.summarizeLocalFolder(7, { localPath: folder, opId: "op-4" });
        expect(result.status).toBe("ready");
      });
    });

    it("starts cancelled when the cancel overtook the walk", async () => {
      const { client } = setup();
      const folder = await droppedFolder(client);

      expect(client.cancel("op-early", 7)).toBe(false);

      await expect(
        client.summarizeLocalFolder(7, { localPath: folder, opId: "op-early" })
      ).rejects.toMatchObject({ code: "CANCELLED" });
    });

    it("stops a walk when its view is destroyed", async () => {
      const held = heldWalk();
      const { client, destroyView } = setup({ walkFs: held.walkFs });
      const folder = await droppedFolder(client);

      const walking = client.summarizeLocalFolder(7, { localPath: folder, opId: "op-walk" });
      await held.startedWalk;
      destroyView(7);

      await expect(walking).rejects.toMatchObject({ code: "CANCELLED" });
      held.open();
    });

    it("shares a walk asked for twice and refuses its id for anything else", async () => {
      const held = heldWalk();
      const { client } = setup({ walkFs: held.walkFs });
      const folder = await droppedFolder(client);
      client.grantLocalSources(8, [folder]);

      const first = client.summarizeLocalFolder(7, { localPath: folder, opId: "op-walk" });
      const again = client.summarizeLocalFolder(7, { localPath: folder, opId: "op-walk" });
      await expect(
        client.summarizeLocalFolder(8, { localPath: folder, opId: "op-walk" })
      ).rejects.toMatchObject({ code: "VALIDATION" });
      await expect(
        client.uploadLocalFile(7, {
          hostId: "studio-01",
          localPath: folder,
          destination: { kind: "inbox", bucket: "files" },
          opId: "op-walk",
        })
      ).rejects.toMatchObject({ code: "VALIDATION" });
      held.open();

      const [a, b] = await Promise.all([first, again]);
      expect(a).toBe(b);
    });
  });
});

describe("packing a summarized folder", () => {
  const signal = () => new AbortController().signal;
  const posix = process.platform !== "win32";
  const isRoot = typeof process.getuid === "function" && process.getuid() === 0;
  const packsDir = () => path.join(dir, "packs");

  async function archivesLeft(): Promise<string[]> {
    try {
      return await fs.readdir(packsDir());
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }

  async function packed(client: ReturnType<typeof setup>["client"], handle: string, view = 7) {
    const result = await client.packFolder(view, handle, { signal: signal() });
    if (result.status !== "packed") throw new Error("expected a packed folder");
    return result.archive;
  }

  /** A second folder dropped in `view`, summarized there. */
  async function handleIn(client: ReturnType<typeof setup>["client"], view: number, name: string) {
    const folder = path.join(dir, name);
    await fs.mkdir(folder, { recursive: true });
    await fs.writeFile(path.join(folder, "a.txt"), "a");
    client.grantLocalSources(view, [folder]);
    const result = await client.summarizeLocalFolder(view, {
      localPath: folder,
      opId: `op-${name}`,
    });
    if (result.status !== "ready") throw new Error("expected a ready folder");
    return result.handle;
  }

  it("packs what the handle summarized into the private folder, until it is removed", async () => {
    const { client } = setup();
    const handle = await readyHandle(client, await droppedFolder(client));

    const archive = await packed(client, handle);

    expect(path.dirname(archive.path)).toBe(packsDir());
    expect(archive.totals).toEqual({ fileCount: 1, folderCount: 1, totalBytes: 10 });
    const bytes = await fs.readFile(archive.path);
    expect(archive.archiveBytes).toBe(bytes.byteLength);
    const source = await archive.openSource();
    expect(source.sha256).toBe(archive.sha256);
    expect(Buffer.from(await source.read(0, source.size)).equals(bytes)).toBe(true);
    await source.close?.();
    await archive.remove();
    expect(await archivesLeft()).toEqual([]);
  });

  it("refuses a handle from another view without packing anything", async () => {
    const { client } = setup();
    const folder = await droppedFolder(client);
    client.grantLocalSources(8, [folder]);
    const handle = await readyHandle(client, folder);

    await expect(client.packFolder(8, handle, { signal: signal() })).rejects.toMatchObject({
      code: "PERMISSION",
    });
    expect(await archivesLeft()).toEqual([]);
  });

  it("names what changed since the summary, and keeps nothing", async () => {
    const { client } = setup();
    const folder = await droppedFolder(client);
    const handle = await readyHandle(client, folder);
    await fs.writeFile(path.join(folder, "src", "app.ts"), "export const changed = true;");

    expect(await client.packFolder(7, handle, { signal: signal() })).toEqual({
      status: "changed",
      path: "Project/src/app.ts",
      change: "modified",
    });
    expect(await archivesLeft()).toEqual([]);
  });

  it("packs two folders per view at once, whether running or held", async () => {
    const { client } = setup();
    const handle = await readyHandle(client, await droppedFolder(client));

    const running = [
      client.packFolder(7, handle, { signal: signal() }),
      client.packFolder(7, handle, { signal: signal() }),
    ];
    await expect(client.packFolder(7, handle, { signal: signal() })).rejects.toMatchObject({
      code: "RATE_LIMITED",
    });

    const [first] = await Promise.all(running);
    await expect(client.packFolder(7, handle, { signal: signal() })).rejects.toMatchObject({
      code: "RATE_LIMITED",
    });
    if (first!.status !== "packed") throw new Error("expected a packed folder");
    await first!.archive.remove();
    await expect(packed(client, handle)).resolves.toBeTruthy();
  });

  it("packs four folders at once across views", async () => {
    const { client } = setup();
    const handles = [
      await handleIn(client, 7, "seven"),
      await handleIn(client, 8, "eight"),
      await handleIn(client, 9, "nine"),
    ];
    await packed(client, handles[0]!, 7);
    await packed(client, handles[0]!, 7);
    const held = await packed(client, handles[1]!, 8);
    await packed(client, handles[1]!, 8);

    await expect(client.packFolder(9, handles[2]!, { signal: signal() })).rejects.toMatchObject({
      code: "RATE_LIMITED",
    });

    await held.remove();
    await expect(packed(client, handles[2]!, 9)).resolves.toBeTruthy();
  });

  it("keeps an archive's place until it is actually removed", async () => {
    if (!posix || isRoot) return;
    const { client } = setup();
    const handle = await readyHandle(client, await droppedFolder(client));
    const first = await packed(client, handle);
    await packed(client, handle);
    await fs.chmod(packsDir(), 0o500);

    try {
      await expect(first.remove()).rejects.toBeTruthy();
      await expect(client.packFolder(7, handle, { signal: signal() })).rejects.toMatchObject({
        code: "RATE_LIMITED",
      });
    } finally {
      await fs.chmod(packsDir(), 0o700);
    }

    await first.remove();
    await expect(fs.stat(first.path)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(packed(client, handle)).resolves.toBeTruthy();
  });

  it("stops a pack when its caller cancels, leaving nothing, and lets go of its signal", async () => {
    const { client } = setup();
    const handle = await readyHandle(client, await droppedFolder(client));
    const controller = new AbortController();

    const packing = client.packFolder(7, handle, {
      signal: controller.signal,
      onProgress: () => controller.abort(),
    });

    await expect(packing).rejects.toBeInstanceOf(LocalFolderPackError);
    await expect(packing).rejects.toMatchObject({ reason: "cancelled" });
    expect(await archivesLeft()).toEqual([]);
    // The place it held is free again.
    await packed(client, handle);
    await packed(client, handle);
  });

  it("leaves no listener on a caller's signal once a pack settles", async () => {
    const { client } = setup();
    const folder = await droppedFolder(client);
    const handle = await readyHandle(client, folder);
    const shared = new AbortController();

    const done = await client.packFolder(7, handle, { signal: shared.signal });
    await fs.writeFile(path.join(folder, "src", "app.ts"), "export const changed = 1;");
    const changed = await client.packFolder(7, handle, { signal: shared.signal });

    expect(changed.status).toBe("changed");
    expect(getEventListeners(shared.signal, "abort")).toHaveLength(0);
    if (done.status === "packed") await done.archive.remove();
  });

  it("stops a running pack and removes a held archive when the view is destroyed", async () => {
    const { client, destroyView } = setup();
    const handle = await readyHandle(client, await droppedFolder(client));
    const held = await packed(client, handle);

    // On the last report, once every byte is in the archive.
    const running = client.packFolder(7, handle, {
      signal: signal(),
      onProgress: (progress) => {
        if (progress.filesDone === progress.filesTotal) destroyView(7);
      },
    });

    await expect(running).rejects.toMatchObject({ reason: "cancelled" });
    await vi.waitFor(async () => expect(await archivesLeft()).toEqual([]));
    await expect(fs.stat(held.path)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("stops every pack and removes every archive held, in every view, when disposed", async () => {
    const { client } = setup();
    const seven = await handleIn(client, 7, "seven");
    const eight = await handleIn(client, 8, "eight");
    await packed(client, seven, 7);
    await packed(client, eight, 8);

    const running = client.packFolder(8, eight, {
      signal: signal(),
      onProgress: (progress) => {
        if (progress.filesDone === progress.filesTotal) client.dispose();
      },
    });

    await expect(running).rejects.toMatchObject({ reason: "cancelled" });
    await vi.waitFor(async () => expect(await archivesLeft()).toEqual([]));
    await expect(client.packFolder(7, seven, { signal: signal() })).rejects.toBeTruthy();
    expect(await archivesLeft()).toEqual([]);
  });
});
