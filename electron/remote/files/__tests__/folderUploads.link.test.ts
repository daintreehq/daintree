import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  app: { isPackaged: true, on: vi.fn(), getPath: vi.fn(() => os.tmpdir()) },
}));

import {
  FOLDER_UPLOAD_MAX_ARCHIVE_BYTES,
  FOLDER_UPLOAD_MAX_FOLDERS,
} from "../../../../shared/types/folderUpload.js";
import {
  FOLDER_UPLOAD_MAX_BYTES,
  FOLDER_UPLOAD_MAX_FILES,
} from "../../../../shared/types/remoteHosts.js";
import { BULK_CHUNK_BYTES } from "../../link/frames.js";
import type { LinkSession } from "../../link/session.js";
import {
  bytesTransferSource,
  sha256Hex,
  type LinkTransfersOptions,
  type TransferSource,
} from "../../link/transfer.js";
import { makeTempDir, openSessionPair, removeTempDir } from "../../link/__tests__/linkTestUtils.js";
import { unpackFolderArchive } from "../folderArchiveUnpack.js";
import {
  FOLDER_UPLOAD_SINK_PREFIX,
  FolderUploadCancelResultSchema,
  FolderUploadLinkMethod,
  FolderUploadPrepareResultSchema,
  FolderUploadStatusSchema,
  type FolderUploadPreparePayload,
  type FolderUploadStatus,
} from "../folderUploadLinkMethods.js";
import type { HostFileEndpoint } from "../HostFileService.js";
import {
  HostFolderUploadService,
  type HostFolderUploadServiceOptions,
} from "../HostFolderUploadService.js";
import { HostInbox } from "../hostInbox.js";
import { HostUploadService } from "../HostUploadService.js";
import { UPLOAD_SINK_PREFIX, UploadLinkMethod } from "../uploadLinkMethods.js";
import { forgeFolderArchive, type ForgedEntry } from "./forgeFolderArchive.js";

class FakeEndpoint implements HostFileEndpoint {
  constructor(
    readonly endpointId = "session-1:view-7",
    readonly clientEndpointId = "view-7",
    readonly clientId = "client-a"
  ) {}
  projectId: string | null = "p1";
  private closed = false;
  private readonly listeners = new Set<() => void>();
  isClosed() {
    return this.closed;
  }
  onClose(cb: () => void) {
    this.listeners.add(cb);
    return { dispose: () => this.listeners.delete(cb) };
  }
  close() {
    this.closed = true;
    for (const listener of [...this.listeners]) listener();
  }
}

let socketDir: string;
let inboxRoot: string;
const sessions: LinkSession[] = [];
const services: Array<{ dispose(): void }> = [];
/** Gates a test holds, let go at teardown even when an assertion failed first. */
const gates: Array<() => void> = [];

beforeEach(async () => {
  socketDir = await makeTempDir();
  const tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "folder-up-")));
  inboxRoot = path.join(tmp, "daintree-inbox");
});

afterEach(async () => {
  for (const release of gates.splice(0)) release();
  vi.restoreAllMocks();
  for (const service of services.splice(0)) service.dispose();
  for (const session of sessions.splice(0)) session.close("test done");
  await removeTempDir(socketDir);
  await fs.rm(path.dirname(inboxRoot), { recursive: true, force: true });
});

interface SetupOptions extends Partial<
  Pick<
    HostFolderUploadServiceOptions,
    "unpack" | "pendingTtlMs" | "outcomeTtlMs" | "maxActive" | "cancelWaitMs"
  >
> {
  driving?: () => boolean;
  leaseId?: () => number | null;
  /** Free bytes the inbox sees; unknown (admitting) when absent. */
  freeBytes?: number;
  /** Transfer options for both ends of the link. */
  transfers?: LinkTransfersOptions;
  /** Bytes the host's sink has taken for each transfer. */
  onHostReceived?: (bytes: number) => void;
}

async function setup(options: SetupOptions = {}) {
  const extra = options.transfers ? { transfers: options.transfers } : {};
  const hostExtra = options.onHostReceived
    ? {
        transfers: {
          ...options.transfers,
          onIncomingProgress: (_begin: unknown, bytes: number) => options.onHostReceived!(bytes),
        },
      }
    : extra;
  const { host, client } = await openSessionPair(socketDir, hostExtra, extra);
  sessions.push(host, client);
  const endpoint = new FakeEndpoint();
  const inbox = new HostInbox({
    root: inboxRoot,
    freeBytes: async () => options.freeBytes ?? null,
    freeSpaceMarginBytes: 0,
  });
  const service = new HostFolderUploadService({
    isDriving: () => options.driving?.() ?? true,
    leaseIdFor: () => (options.leaseId ? options.leaseId() : 1),
    inbox,
    unpack: options.unpack,
    pendingTtlMs: options.pendingTtlMs,
    outcomeTtlMs: options.outcomeTtlMs,
    maxActive: options.maxActive,
    cancelWaitMs: options.cancelWaitMs,
  });
  services.push(service);
  service.attach(host, endpoint);
  /** The link comes back: a new session, and the view's endpoint on it, for the same Shell. */
  const relink = async () => {
    const next = await openSessionPair(socketDir, hostExtra, extra);
    sessions.push(next.host, next.client);
    service.attach(next.host, new FakeEndpoint("session-2:view-7", "view-7", endpoint.clientId));
    return next.client;
  };
  return { host, client, service, inbox, endpoint, relink };
}

interface PackedFolder {
  archive: Buffer;
  rootName: string;
  fileCount: number;
  folderCount: number;
  totalBytes: number;
}

/** A valid folder archive, as the Shell's packer lays one out. */
function packFolder(
  rootName: string,
  tree: { files?: Record<string, string | Buffer>; folders?: string[]; executable?: string[] }
): PackedFolder {
  const entries: ForgedEntry[] = [{ name: `${rootName}/` }];
  for (const folder of tree.folders ?? []) entries.push({ name: `${rootName}/${folder}/` });
  let totalBytes = 0;
  for (const [file, data] of Object.entries(tree.files ?? {})) {
    entries.push({
      name: `${rootName}/${file}`,
      data,
      executable: tree.executable?.includes(file),
    });
    totalBytes += typeof data === "string" ? Buffer.byteLength(data) : data.length;
  }
  return {
    archive: forgeFolderArchive(entries),
    rootName,
    fileCount: Object.keys(tree.files ?? {}).length,
    folderCount: (tree.folders ?? []).length,
    totalBytes,
  };
}

const SMALL = () =>
  packFolder("Audit", {
    folders: ["src", "src/empty"],
    files: { "README.md": "# Audit", "src/app.ts": "export {};", "run.sh": "#!/bin/sh" },
    executable: ["run.sh"],
  });

function payloadFor(
  folder: PackedFolder,
  opId: string,
  overrides: Partial<FolderUploadPreparePayload> = {}
): FolderUploadPreparePayload {
  return {
    endpointId: "view-7",
    opId,
    rootName: folder.rootName,
    archiveBytes: folder.archive.length,
    sha256: sha256Hex(folder.archive),
    fileCount: folder.fileCount,
    folderCount: folder.folderCount,
    totalBytes: folder.totalBytes,
    ...overrides,
  };
}

async function prepare(
  client: LinkSession,
  folder: PackedFolder,
  opId: string,
  overrides: Partial<FolderUploadPreparePayload> = {}
) {
  return FolderUploadPrepareResultSchema.parse(
    await client.call(FolderUploadLinkMethod.PREPARE, payloadFor(folder, opId, overrides))
  );
}

async function readyToken(client: LinkSession, folder: PackedFolder, opId: string) {
  const result = await prepare(client, folder, opId);
  if (result.status !== "ready") throw new Error(`Expected ready, got ${result.status}`);
  return result.token;
}

function send(client: LinkSession, token: string, source: TransferSource) {
  return client.transfers.send(source, {
    name: "folder.zip",
    destination: { kind: "path", path: `${FOLDER_UPLOAD_SINK_PREFIX}${token}` },
  });
}

async function status(client: LinkSession, opId: string): Promise<FolderUploadStatus> {
  return FolderUploadStatusSchema.parse(
    await client.call(FolderUploadLinkMethod.STATUS, { endpointId: "view-7", opId })
  );
}

async function cancel(client: LinkSession, opId: string) {
  return FolderUploadCancelResultSchema.parse(
    await client.call(FolderUploadLinkMethod.CANCEL, { endpointId: "view-7", opId })
  );
}

/** Ask until the operation stops receiving and unpacking. */
async function settled(client: LinkSession, opId: string, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const current = await status(client, opId);
    if (current.status !== "receiving" && current.status !== "unpacking") return current;
    if (Date.now() > deadline) throw new Error(`Still ${current.status} after ${timeoutMs} ms`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function until(check: () => Promise<boolean>, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error("Timed out");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function upload(client: LinkSession, folder: PackedFolder, opId: string) {
  const token = await readyToken(client, folder, opId);
  await send(client, token, bytesTransferSource(folder.archive));
  return settled(client, opId);
}

/** Part files and staging folders: what an upload under way holds in the inbox root. */
async function inFlightLeftovers(): Promise<string[]> {
  const names = await fs.readdir(inboxRoot).catch(() => [] as string[]);
  return names.filter((name) => name.startsWith(".part-") || name.startsWith(".stage-"));
}

async function publishedEntries(): Promise<string[]> {
  return fs.readdir(path.join(inboxRoot, "files")).catch(() => []);
}

/** A source that serves `firstBytes` (a chunk by default), then waits for the test before the rest. */
function heldSource(bytes: Uint8Array, firstBytes = BULK_CHUNK_BYTES) {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let reached!: () => void;
  const atGate = new Promise<void>((resolve) => {
    reached = resolve;
  });
  gates.push(release);
  const source: TransferSource = {
    size: bytes.byteLength,
    sha256: sha256Hex(bytes),
    read: async (offset, length) => {
      if (offset >= firstBytes) {
        reached();
        await gate;
      }
      return bytes.subarray(offset, offset + length);
    },
  };
  return { source, release, atGate };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  gates.push(resolve);
  return { promise, resolve };
}

/** How a promise ended, observed from the start so a rejection is never left unhandled. */
function outcomeOf(promise: Promise<unknown>): Promise<"resolved" | "rejected"> {
  return promise.then(
    () => "resolved",
    () => "rejected"
  );
}

describe("a folder sent to the host inbox", () => {
  it("is unpacked after its transfer commits and published whole, and done names its host path", async () => {
    const { client } = await setup();
    const folder = SMALL();
    const token = await readyToken(client, folder, "op-1");
    const sent = await send(client, token, bytesTransferSource(folder.archive));
    const done = await settled(client, "op-1");
    if (done.status !== "done") throw new Error(`Expected done, got ${JSON.stringify(done)}`);
    // The transfer says only that the archive arrived.
    expect(sent.path).not.toBe(done.hostPath);

    const [entry] = await publishedEntries();
    expect(done.hostPath).toBe(path.join(inboxRoot, "files", entry!, "Audit"));
    expect(await fs.readFile(path.join(done.hostPath, "README.md"), "utf8")).toBe("# Audit");
    expect(await fs.readFile(path.join(done.hostPath, "src", "app.ts"), "utf8")).toBe("export {};");
    expect((await fs.readdir(path.join(done.hostPath, "src", "empty"))).length).toBe(0);
    expect((await fs.stat(path.join(done.hostPath, "README.md"))).mode & 0o777).toBe(0o600);
    expect((await fs.stat(path.join(done.hostPath, "run.sh"))).mode & 0o777).toBe(0o700);
    expect(await inFlightLeftovers()).toEqual([]);
  });

  it("reports progress through the unpack, files done of the total declared", async () => {
    const start = deferred();
    const finish = deferred();
    const { client } = await setup({
      unpack: async (options) => {
        await start.promise;
        const result = await unpackFolderArchive(options);
        // Every file written, publication not yet begun.
        await finish.promise;
        return result;
      },
    });
    const folder = SMALL();
    const token = await readyToken(client, folder, "op-progress");
    expect(await status(client, "op-progress")).toEqual({ status: "receiving" });
    await send(client, token, bytesTransferSource(folder.archive));
    expect(await status(client, "op-progress")).toEqual({
      status: "unpacking",
      filesDone: 0,
      filesTotal: 3,
    });
    start.resolve();
    await until(async () => {
      const current = await status(client, "op-progress");
      return current.status === "unpacking" && current.filesDone === 3;
    });
    finish.resolve();
    expect((await settled(client, "op-progress")).status).toBe("done");
  });

  it("knows nothing of an operation it was never asked for", async () => {
    const { client } = await setup();
    expect(await status(client, "op-never")).toEqual({ status: "unknown" });
    expect(await cancel(client, "op-never")).toEqual({ status: "unknown" });
  });

  it("answers only views attached on that link", async () => {
    const { client } = await setup();
    await expect(
      client.call(FolderUploadLinkMethod.PREPARE, {
        ...payloadFor(SMALL(), "op-x"),
        endpointId: "view-9",
      })
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("refusing a folder at prepare", () => {
  it("refuses an endpoint that doesn't drive the project, holding nothing", async () => {
    const { client } = await setup({ driving: () => false });
    expect(await prepare(client, SMALL(), "op-1")).toEqual({
      status: "refused",
      reason: "not-driving",
    });
    expect(await status(client, "op-1")).toEqual({ status: "unknown" });
  });

  it.each([
    ["files", { fileCount: FOLDER_UPLOAD_MAX_FILES + 1 }],
    ["folders", { folderCount: FOLDER_UPLOAD_MAX_FOLDERS + 1 }],
    [
      "bytes",
      { totalBytes: FOLDER_UPLOAD_MAX_BYTES + 1, archiveBytes: FOLDER_UPLOAD_MAX_BYTES + 2 },
    ],
    ["archive-bytes", { archiveBytes: FOLDER_UPLOAD_MAX_ARCHIVE_BYTES + 1 }],
    ["name-bytes", { rootName: "é".repeat(128) }],
  ] as const)("refuses declared %s over the limit, naming it", async (limit, overrides) => {
    const { client } = await setup();
    const result = await prepare(client, SMALL(), "op-big", overrides);
    expect(result).toMatchObject({
      status: "refused",
      reason: "over-limits",
      problem: { kind: "limit", limit },
    });
    expect(await status(client, "op-big")).toEqual({ status: "unknown" });
  });

  it("refuses when the archive and its unpacked tree won't both fit", async () => {
    const folder = SMALL();
    const { client } = await setup({ freeBytes: folder.archive.length + folder.totalBytes - 1 });
    expect(await prepare(client, folder, "op-1")).toEqual({
      status: "refused",
      reason: "no-space",
    });
  });

  it("counts the room other folder uploads in flight hold", async () => {
    const folder = SMALL();
    const need = folder.archive.length + folder.totalBytes;
    const { client } = await setup({ freeBytes: need + Math.floor(need / 2) });
    expect((await prepare(client, folder, "op-1")).status).toBe("ready");
    expect(await prepare(client, folder, "op-2")).toEqual({
      status: "refused",
      reason: "no-space",
    });
    // Given back once the first is cancelled.
    expect(await cancel(client, "op-1")).toEqual({ status: "cancelled" });
    expect((await prepare(client, folder, "op-2")).status).toBe("ready");
  });

  it("counts the room a single-file upload in flight holds", async () => {
    const folder = SMALL();
    const need = folder.archive.length + folder.totalBytes;
    const { client, host, inbox, endpoint } = await setup({ freeBytes: need + 500 });
    const files = new HostUploadService({ rootsFor: async () => [], isDriving: () => true, inbox });
    files.attach(host, endpoint);
    const file = bytesTransferSource(new Uint8Array(1000).fill(1));
    const filePrepared = (await client.call(UploadLinkMethod.PREPARE, {
      endpointId: "view-7",
      name: "big.bin",
      size: file.size,
      sha256: file.sha256,
      opId: "op-file",
      destination: { kind: "inbox", bucket: "files" },
    })) as { status: string };
    expect(filePrepared.status).toBe("ready");
    expect(await prepare(client, folder, "op-folder")).toEqual({
      status: "refused",
      reason: "no-space",
    });
    // Its room comes back when the service that held it goes.
    files.dispose();
    expect((await prepare(client, folder, "op-folder")).status).toBe("ready");
  });

  describe("gives back the room a single-file upload held", () => {
    const fileSetup = async (options: { pendingTtlMs?: number } = {}) => {
      const folder = SMALL();
      const need = folder.archive.length + folder.totalBytes;
      const ctx = await setup({ freeBytes: need + 500 });
      const files = new HostUploadService({
        rootsFor: async () => [],
        isDriving: () => true,
        inbox: ctx.inbox,
        pendingTtlMs: options.pendingTtlMs,
      });
      services.push(files);
      files.attach(ctx.host, ctx.endpoint);
      const file = bytesTransferSource(new Uint8Array(1000).fill(1));
      const prepared = (await ctx.client.call(UploadLinkMethod.PREPARE, {
        endpointId: "view-7",
        name: "big.bin",
        size: file.size,
        sha256: file.sha256,
        opId: "op-file",
        destination: { kind: "inbox", bucket: "files" },
      })) as { status: string; token: string };
      expect(prepared.status).toBe("ready");
      return { ...ctx, files, folder, file, token: prepared.token };
    };

    it("once the file is placed", async () => {
      const { client, folder, file, token } = await fileSetup();
      await client.transfers.send(file, {
        name: "big.bin",
        destination: { kind: "path", path: `${UPLOAD_SINK_PREFIX}${token}` },
      });
      expect((await prepare(client, folder, "op-folder")).status).toBe("ready");
    });

    it("once its transfer fails", async () => {
      const { client, folder, file, token } = await fileSetup();
      const lying: TransferSource = { ...file, read: async (_o, length) => new Uint8Array(length) };
      await expect(
        client.transfers.send(lying, {
          name: "big.bin",
          destination: { kind: "path", path: `${UPLOAD_SINK_PREFIX}${token}` },
        })
      ).rejects.toBeTruthy();
      await until(async () => (await prepare(client, folder, "op-folder")).status === "ready");
    });

    it("once its unsent prepare expires, with nothing else asked of the file service", async () => {
      const { client, folder } = await fileSetup({ pendingTtlMs: 30 });
      await until(async () => (await prepare(client, folder, "op-folder")).status === "ready");
    });

    it("once its endpoint closes, on a link it was attached to again", async () => {
      const folder = SMALL();
      const need = folder.archive.length + folder.totalBytes;
      const { client, host, endpoint, service, inbox } = await setup({ freeBytes: need + 500 });
      const files = new HostUploadService({
        rootsFor: async () => [],
        isDriving: () => true,
        inbox,
      });
      services.push(files);
      files.attach(host, endpoint);
      // The same view rides a resumed link too, and prepares a file there.
      const next = await openSessionPair(socketDir);
      sessions.push(next.host, next.client);
      files.attach(next.host, endpoint);
      const file = bytesTransferSource(new Uint8Array(1000).fill(2));
      const prepared = (await next.client.call(UploadLinkMethod.PREPARE, {
        endpointId: "view-7",
        name: "late.bin",
        size: file.size,
        sha256: file.sha256,
        opId: "op-late",
        destination: { kind: "inbox", bucket: "files" },
      })) as { status: string };
      expect(prepared.status).toBe("ready");
      // Another view of the same Shell asks for the folder once this one has gone.
      service.attach(host, new FakeEndpoint("session-1:view-8", "view-8", endpoint.clientId));
      expect((await prepare(client, folder, "op-folder", { endpointId: "view-8" })).status).toBe(
        "refused"
      );
      endpoint.close();
      expect((await prepare(client, folder, "op-folder", { endpointId: "view-8" })).status).toBe(
        "ready"
      );
    });
  });

  it("refuses past the host's folder uploads under way, and admits again once one settles", async () => {
    const { client } = await setup({ maxActive: 1 });
    const folder = SMALL();
    expect((await prepare(client, folder, "op-1")).status).toBe("ready");
    expect(await prepare(client, folder, "op-2")).toEqual({ status: "refused", reason: "busy" });
    await cancel(client, "op-1");
    expect((await prepare(client, folder, "op-2")).status).toBe("ready");
  });

  it("refuses the same operation id for a different folder", async () => {
    const { client } = await setup();
    await readyToken(client, SMALL(), "op-shared");
    await expect(
      prepare(client, SMALL(), "op-shared", { fileCount: 4, archiveBytes: 9_999 })
    ).rejects.toMatchObject({ code: "VALIDATION" });
  });
});

describe("receiving the archive", () => {
  it("fails a transfer whose bytes don't match the prepared digest, and unpacks nothing", async () => {
    const unpack = vi.fn(unpackFolderArchive);
    const { client } = await setup({ unpack });
    const folder = SMALL();
    const token = await readyToken(client, folder, "op-1");
    const tampered = Buffer.from(folder.archive);
    tampered[40] = tampered[40]! ^ 0xff;
    // Announced as the prepared archive; the bytes that arrive aren't it.
    const lying: TransferSource = {
      size: folder.archive.length,
      sha256: sha256Hex(folder.archive),
      read: async (offset, length) => tampered.subarray(offset, offset + length),
    };
    await expect(send(client, token, lying)).rejects.toBeTruthy();
    expect(await settled(client, "op-1")).toEqual({
      status: "failed",
      reason: "transfer-failed",
    });
    expect(unpack).not.toHaveBeenCalled();
    expect(await inFlightLeftovers()).toEqual([]);
    expect(await publishedEntries()).toEqual([]);
  });

  it.each([
    ["another digest", (archive: Buffer) => ({ size: archive.length, sha256: "a".repeat(64) })],
    [
      "another size",
      (archive: Buffer) => ({ size: archive.length + 1, sha256: sha256Hex(archive) }),
    ],
  ])(
    "refuses a transfer announced with %s than was prepared, before storing any of it",
    async (_label, announce) => {
      const { client, inbox } = await setup();
      const createPart = vi.spyOn(inbox, "createPart");
      const folder = SMALL();
      const token = await readyToken(client, folder, "op-1");
      const announced = announce(folder.archive);
      const source: TransferSource = {
        ...announced,
        read: async (offset, length) =>
          Buffer.alloc(announced.size, folder.archive).subarray(offset, offset + length),
      };
      await expect(send(client, token, source)).rejects.toBeTruthy();
      expect(await status(client, "op-1")).toEqual({
        status: "failed",
        reason: "transfer-failed",
      });
      expect(createPart).not.toHaveBeenCalled();
      expect(await inFlightLeftovers()).toEqual([]);
    }
  );

  it("refuses a token it never issued", async () => {
    const { client } = await setup();
    await expect(
      send(client, "0".repeat(32), bytesTransferSource(SMALL().archive))
    ).rejects.toBeTruthy();
    expect(await inFlightLeftovers()).toEqual([]);
  });

  it("fails an admission whose archive never comes, giving its room back", async () => {
    const folder = SMALL();
    const need = folder.archive.length + folder.totalBytes;
    const { client } = await setup({ pendingTtlMs: 30, freeBytes: need });
    expect((await prepare(client, folder, "op-1")).status).toBe("ready");
    await until(async () => (await status(client, "op-1")).status === "failed");
    expect(await status(client, "op-1")).toEqual({ status: "failed", reason: "transfer-failed" });
    expect((await prepare(client, folder, "op-2")).status).toBe("ready");
  });
});

describe("an archive the host refuses once it has arrived", () => {
  it("fails a link inside the folder as an unsafe archive, leaving nothing behind", async () => {
    const { client } = await setup();
    const archive = forgeFolderArchive([
      { name: "Audit/" },
      { name: "Audit/escape", data: "/etc/passwd", mode: 0o120777 },
    ]);
    const folder = { archive, rootName: "Audit", fileCount: 1, folderCount: 0, totalBytes: 11 };
    expect(await upload(client, folder, "op-1")).toEqual({
      status: "failed",
      reason: "unsafe-archive",
    });
    expect(await inFlightLeftovers()).toEqual([]);
    expect(await publishedEntries()).toEqual([]);
  });

  it("fails names a case-insensitive disk would merge as a clash, naming the pair", async () => {
    const { client } = await setup();
    const folder = packFolder("Audit", { files: { "notes.txt": "a", "NOTES.txt": "b" } });
    expect(await upload(client, folder, "op-1")).toEqual({
      status: "failed",
      reason: "name-clash",
      problem: { kind: "clash", paths: ["Audit/notes.txt", "Audit/NOTES.txt"] },
    });
    expect(await inFlightLeftovers()).toEqual([]);
    expect(await publishedEntries()).toEqual([]);
  });

  it("fails an archive holding more than was declared", async () => {
    const { client } = await setup();
    const folder = packFolder("Audit", { files: { "a.txt": "a", "b.txt": "b" } });
    const result = await upload(client, { ...folder, fileCount: 1, totalBytes: 1 }, "op-1");
    expect(result).toEqual({ status: "failed", reason: "unsafe-archive" });
    expect(await publishedEntries()).toEqual([]);
  });
});

describe("a disk that fails the upload", () => {
  it.each([
    ["ENOSPC", "no-space"],
    ["EDQUOT", "no-space"],
    ["EIO", "write-failed"],
  ] as const)("names %s while unpacking as %s, leaving nothing behind", async (code, reason) => {
    const { client, inbox } = await setup();
    vi.spyOn(inbox, "createStaging").mockRejectedValueOnce(
      Object.assign(new Error("disk said no"), { code })
    );
    expect(await upload(client, SMALL(), "op-1")).toEqual({ status: "failed", reason });
    expect(await inFlightLeftovers()).toEqual([]);
    expect(await publishedEntries()).toEqual([]);
  });

  it("names a full disk while the archive is being stored", async () => {
    const { client, inbox } = await setup();
    vi.spyOn(inbox, "createPart").mockRejectedValueOnce(
      Object.assign(new Error("disk said no"), { code: "ENOSPC" })
    );
    const folder = SMALL();
    const token = await readyToken(client, folder, "op-1");
    await expect(send(client, token, bytesTransferSource(folder.archive))).rejects.toBeTruthy();
    expect(await status(client, "op-1")).toEqual({ status: "failed", reason: "no-space" });
  });
});

describe("cancelling a folder upload", () => {
  it("before its archive is sent, refusing the archive after", async () => {
    const { client } = await setup();
    const folder = SMALL();
    const token = await readyToken(client, folder, "op-1");
    expect(await cancel(client, "op-1")).toEqual({ status: "cancelled" });
    await expect(send(client, token, bytesTransferSource(folder.archive))).rejects.toBeTruthy();
    expect(await status(client, "op-1")).toEqual({ status: "cancelled" });
    expect(await prepare(client, folder, "op-1")).toEqual({ status: "cancelled" });
    expect(await inFlightLeftovers()).toEqual([]);
  });

  it("while the archive is arriving, leaving no part file behind", async () => {
    let received = 0;
    const { client } = await setup({ onHostReceived: (bytes) => (received = bytes) });
    const folder = packFolder("Audit", {
      files: { "big.bin": crypto.randomBytes(BULK_CHUNK_BYTES * 4) },
    });
    const token = await readyToken(client, folder, "op-1");
    const held = heldSource(folder.archive);
    const sending = outcomeOf(send(client, token, held.source));
    await held.atGate;
    await until(async () => received > 0);
    expect(await cancel(client, "op-1")).toEqual({ status: "cancelled" });
    expect(await inFlightLeftovers()).toEqual([]);
    held.release();
    expect(await sending).toBe("rejected");
    expect(await status(client, "op-1")).toEqual({ status: "cancelled" });
    expect(await publishedEntries()).toEqual([]);
  });

  it("while unpacking, removing the staging folder and what was written into it", async () => {
    const entered = deferred();
    const { client } = await setup({
      unpack: async (options) => {
        await fs.writeFile(path.join(options.stagingDir, "half.txt"), "half");
        entered.resolve();
        return new Promise((_, reject) => {
          options.signal!.addEventListener("abort", () => reject(options.signal!.reason), {
            once: true,
          });
        });
      },
    });
    const folder = SMALL();
    const token = await readyToken(client, folder, "op-1");
    await send(client, token, bytesTransferSource(folder.archive));
    await entered.promise;
    expect((await inFlightLeftovers()).some((name) => name.startsWith(".stage-"))).toBe(true);
    expect(await cancel(client, "op-1")).toEqual({ status: "cancelled" });
    expect(await inFlightLeftovers()).toEqual([]);
    expect(await status(client, "op-1")).toEqual({ status: "cancelled" });
    expect(await publishedEntries()).toEqual([]);
  });

  it("while publication waits its turn, so it never happens", async () => {
    const { client, inbox } = await setup();
    const queued = deferred();
    const go = deferred();
    const publishTree = inbox.publishTree.bind(inbox);
    vi.spyOn(inbox, "publishTree").mockImplementation(async (...args) => {
      queued.resolve();
      await go.promise;
      return publishTree(...args);
    });
    const folder = SMALL();
    const token = await readyToken(client, folder, "op-1");
    await send(client, token, bytesTransferSource(folder.archive));
    await queued.promise;
    const cancelling = cancel(client, "op-1");
    await until(async () => (await status(client, "op-1")).status !== "receiving");
    go.resolve();
    expect(await cancelling).toEqual({ status: "cancelled" });
    expect(await status(client, "op-1")).toEqual({ status: "cancelled" });
    expect(await publishedEntries()).toEqual([]);
    expect(await inFlightLeftovers()).toEqual([]);
  });

  it("answers done, with its path, when publication's rename had already begun", async () => {
    // The cancel's own wait is short: it must still not answer before the rename settles.
    const { client } = await setup({ cancelWaitMs: 10 });
    const renaming = deferred();
    const landed = deferred();
    const rename = fs.rename.bind(fs);
    vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
      if (!String(to).startsWith(path.join(inboxRoot, "files"))) return rename(from, to);
      renaming.resolve();
      await landed.promise;
      return rename(from, to);
    });
    const folder = SMALL();
    const token = await readyToken(client, folder, "op-1");
    await send(client, token, bytesTransferSource(folder.archive));
    await renaming.promise;
    const cancelling = cancel(client, "op-1");
    await new Promise((resolve) => setTimeout(resolve, 50));
    landed.resolve();
    const answer = await cancelling;
    expect(answer.status).toBe("done");
    expect(await settled(client, "op-1")).toEqual(answer);
    expect(await publishedEntries()).toHaveLength(1);
  });

  it("answers done when the folder was already published", async () => {
    const { client } = await setup();
    const done = await upload(client, SMALL(), "op-1");
    expect(done.status).toBe("done");
    expect(await cancel(client, "op-1")).toEqual(done);
    expect(await publishedEntries()).toHaveLength(1);
  });
});

describe("retries under the same operation id", () => {
  it("hands a prepare whose answer was lost a token again, and the folder lands once", async () => {
    const { client } = await setup();
    const folder = SMALL();
    const lost = await readyToken(client, folder, "op-1");
    const token = await readyToken(client, folder, "op-1");
    // The first answer's token was replaced: only one archive can ever be accepted.
    await expect(send(client, lost, bytesTransferSource(folder.archive))).rejects.toBeTruthy();
    await send(client, token, bytesTransferSource(folder.archive));
    expect((await settled(client, "op-1")).status).toBe("done");
    expect(await publishedEntries()).toHaveLength(1);
  });

  it("answers a prepare asked again while the archive is arriving with where it is, never a second token", async () => {
    let received = 0;
    const { client } = await setup({ onHostReceived: (bytes) => (received = bytes) });
    const folder = packFolder("Audit", {
      files: { "big.bin": crypto.randomBytes(BULK_CHUNK_BYTES * 4) },
    });
    const token = await readyToken(client, folder, "op-1");
    const held = heldSource(folder.archive);
    const sending = outcomeOf(send(client, token, held.source));
    await until(async () => received > 0);
    expect(await prepare(client, folder, "op-1")).toEqual({ status: "receiving" });
    expect(await status(client, "op-1")).toEqual({ status: "receiving" });
    held.release();
    expect(await sending).toBe("resolved");
    const done = await settled(client, "op-1");
    expect(done.status).toBe("done");
    expect(await prepare(client, folder, "op-1")).toEqual(done);
    expect(await publishedEntries()).toHaveLength(1);
  });

  it("hands a token again to a prepare asked while a transfer has begun with nothing in yet", async () => {
    const { client, relink } = await setup();
    const folder = SMALL();
    const stalled = heldSource(folder.archive, 0);
    const first = outcomeOf(send(client, await readyToken(client, folder, "op-1"), stalled.source));
    await until(async () => (await inFlightLeftovers()).length === 1);
    // The Shell gave up on that link without it closing, and asks again on a new one.
    const again = await relink();
    const token = await readyToken(again, folder, "op-1");
    await send(again, token, bytesTransferSource(folder.archive));
    expect((await settled(again, "op-1")).status).toBe("done");
    // The transfer it replaced can no longer land anything.
    stalled.release();
    expect(await first).toBe("rejected");
    expect(await publishedEntries()).toHaveLength(1);
    expect(await inFlightLeftovers()).toEqual([]);
  });

  it("keeps an admission whose link dropped after its transfer began but before any of it came", async () => {
    const { client, relink } = await setup();
    const folder = SMALL();
    const stalled = heldSource(folder.archive, 0);
    const first = outcomeOf(send(client, await readyToken(client, folder, "op-1"), stalled.source));
    await until(async () => (await inFlightLeftovers()).length === 1);
    client.close("network went away");
    expect(await first).toBe("rejected");
    const again = await relink();
    const token = await readyToken(again, folder, "op-1");
    await send(again, token, bytesTransferSource(folder.archive));
    expect((await settled(again, "op-1")).status).toBe("done");
    expect(await publishedEntries()).toHaveLength(1);
  });

  it("answers a prepare and a status from a new link with the same outcome, one copy on disk", async () => {
    const { client, relink } = await setup();
    const folder = SMALL();
    const done = await upload(client, folder, "op-1");
    expect(done.status).toBe("done");
    client.close("network went away");
    const again = await relink();
    expect(await prepare(again, folder, "op-1")).toEqual(done);
    expect(await status(again, "op-1")).toEqual(done);
    expect(await publishedEntries()).toHaveLength(1);
  });

  it("keeps unpacking when the link drops after the archive arrived, and the new link learns the outcome", async () => {
    const hold = deferred();
    const { client, relink } = await setup({
      unpack: async (options) => {
        await hold.promise;
        return unpackFolderArchive(options);
      },
    });
    const folder = SMALL();
    const token = await readyToken(client, folder, "op-1");
    await send(client, token, bytesTransferSource(folder.archive));
    client.close("network went away");
    const again = await relink();
    expect(await prepare(again, folder, "op-1")).toMatchObject({ status: "unpacking" });
    hold.resolve();
    const done = await settled(again, "op-1");
    expect(done.status).toBe("done");
    expect(await publishedEntries()).toHaveLength(1);
  });

  it("hands a token on the new link to an admission whose link dropped before the archive was sent", async () => {
    const { client, relink } = await setup();
    const folder = SMALL();
    const lost = await readyToken(client, folder, "op-1");
    client.close("network went away");
    const again = await relink();
    const token = await readyToken(again, folder, "op-1");
    expect(token).not.toBe(lost);
    await send(again, token, bytesTransferSource(folder.archive));
    expect((await settled(again, "op-1")).status).toBe("done");
  });

  it("keeps each Shell's ids apart", async () => {
    const { client, host, service } = await setup();
    service.attach(host, new FakeEndpoint("session-1:view-9", "view-9", "client-b"));
    await upload(client, SMALL(), "op-same");
    const other = FolderUploadStatusSchema.parse(
      await client.call(FolderUploadLinkMethod.STATUS, { endpointId: "view-9", opId: "op-same" })
    );
    expect(other).toEqual({ status: "unknown" });
  });

  it("forgets a settled operation after its time, never the folder it published", async () => {
    const { client } = await setup({ outcomeTtlMs: 60_000 });
    const done = await upload(client, SMALL(), "op-1");
    expect(done.status).toBe("done");
    expect(await status(client, "op-1")).toEqual(done);
    const now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now + 60_001);
    expect(await status(client, "op-1")).toEqual({ status: "unknown" });
    expect(await publishedEntries()).toHaveLength(1);
  });
});

describe("a drive-lease takeover", () => {
  it("stops an upload mid-unpack and removes what it staged", async () => {
    let lease = 1;
    const ref: { service?: HostFolderUploadService } = {};
    const seen: number[] = [];
    let abortedAtTakeover: boolean | null = null;
    const ctx = await setup({
      leaseId: () => lease,
      unpack: (options) =>
        unpackFolderArchive({
          ...options,
          onProgress: (progress) => {
            options.onProgress?.(progress);
            seen.push(progress.filesDone);
            if (progress.filesDone !== 1) return;
            lease = 2;
            ref.service!.onLeaseChanged("p1");
            abortedAtTakeover = options.signal!.aborted;
          },
        }),
    });
    ref.service = ctx.service;
    expect(await upload(ctx.client, SMALL(), "op-1")).toEqual({
      status: "failed",
      reason: "not-driving",
    });
    // Stopped by the takeover itself, with files still to go, not at publication.
    expect(abortedAtTakeover).toBe(true);
    expect(seen).toEqual([1]);
    expect(await inFlightLeftovers()).toEqual([]);
    expect(await publishedEntries()).toEqual([]);
  });

  it("stops an admission waiting for its archive, and refuses the archive", async () => {
    let lease = 1;
    const { client, service } = await setup({ leaseId: () => lease });
    const folder = SMALL();
    const token = await readyToken(client, folder, "op-1");
    lease = 2;
    service.onLeaseChanged("p1");
    expect(await status(client, "op-1")).toEqual({ status: "failed", reason: "not-driving" });
    await expect(send(client, token, bytesTransferSource(folder.archive))).rejects.toBeTruthy();
  });

  it("leaves uploads on other projects alone", async () => {
    const { client, service } = await setup();
    const folder = SMALL();
    const token = await readyToken(client, folder, "op-1");
    service.onLeaseChanged("p2");
    await send(client, token, bytesTransferSource(folder.archive));
    expect((await settled(client, "op-1")).status).toBe("done");
  });
});

describe("the transfer's commit deadline", () => {
  it("doesn't bound the unpack: a folder that outlasts it still finishes", async () => {
    const commitTimeoutMs = 300;
    const entered = deferred();
    const hold = deferred();
    const { client } = await setup({
      transfers: { commitTimeoutMs },
      unpack: async (options) => {
        entered.resolve();
        await hold.promise;
        return unpackFolderArchive(options);
      },
    });
    const folder = SMALL();
    const token = await readyToken(client, folder, "op-1");
    await send(client, token, bytesTransferSource(folder.archive));
    await entered.promise;
    await new Promise((resolve) => setTimeout(resolve, commitTimeoutMs * 2.5));
    expect(await status(client, "op-1")).toMatchObject({ status: "unpacking" });
    hold.resolve();
    const done = await settled(client, "op-1");
    expect(done.status).toBe("done");
    if (done.status === "done") {
      expect(await fs.readFile(path.join(done.hostPath, "README.md"), "utf8")).toBe("# Audit");
    }
  });
});

describe("disposing the service", () => {
  it("stops an unpack under way and removes its staging", async () => {
    const entered = deferred();
    const stopped = deferred();
    const { client, service } = await setup({
      unpack: async (options) => {
        entered.resolve();
        return new Promise((_, reject) => {
          options.signal!.addEventListener(
            "abort",
            () => {
              reject(options.signal!.reason);
              stopped.resolve();
            },
            { once: true }
          );
        });
      },
    });
    const folder = SMALL();
    const token = await readyToken(client, folder, "op-1");
    await send(client, token, bytesTransferSource(folder.archive));
    await entered.promise;
    service.dispose();
    await stopped.promise;
    await until(async () => (await inFlightLeftovers()).length === 0);
    expect(await publishedEntries()).toEqual([]);
  });
});
