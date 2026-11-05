import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  app: { isPackaged: true, on: vi.fn(), getPath: vi.fn(() => os.tmpdir()) },
  webContents: { fromId: vi.fn(() => null), getAllWebContents: vi.fn(() => []) },
  BrowserWindow: { fromWebContents: vi.fn(() => null), getAllWindows: vi.fn(() => []) },
}));

import type {
  FileTransferEvent,
  FolderUploadPhase,
  TransferDestination,
} from "../../../../shared/types/ipc/fileTransfer.js";
import { BULK_CHUNK_BYTES } from "../../link/frames.js";
import type { LinkSession } from "../../link/session.js";
import type { TransferSource } from "../../link/transfer.js";
import { makeTempDir, openSessionPair, removeTempDir } from "../../link/__tests__/linkTestUtils.js";
import { ClientUploadTransport } from "../ClientUploadTransport.js";
import { unpackFolderArchive } from "../folderArchiveUnpack.js";
import type { HostFileEndpoint } from "../HostFileService.js";
import { HostFolderUploadService } from "../HostFolderUploadService.js";
import { HostInbox } from "../hostInbox.js";
import { HostUploadService } from "../HostUploadService.js";
import { createHostUploadClient } from "../uploadClient.js";

const HOST = "studio-01";
const INBOX: TransferDestination = { kind: "inbox", bucket: "files" };

class FakeEndpoint implements HostFileEndpoint {
  constructor(
    readonly endpointId = "session-1:view-7",
    readonly clientEndpointId = "view-7",
    readonly clientId = "client-a"
  ) {}
  projectId: string | null = "p1";
  private readonly listeners = new Set<() => void>();
  isClosed() {
    return false;
  }
  onClose(cb: () => void) {
    this.listeners.add(cb);
    return { dispose: () => this.listeners.delete(cb) };
  }
}

let socketDir: string;
let tmp: string;
let inboxRoot: string;
let localDir: string;
let packDir: string;
const sessions: LinkSession[] = [];
const disposers: Array<() => void> = [];
/** Gates a test holds, let go at teardown even when an assertion failed first. */
const gates: Array<() => void> = [];

beforeEach(async () => {
  socketDir = await makeTempDir();
  tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "folder-send-")));
  inboxRoot = path.join(tmp, "daintree-inbox");
  localDir = path.join(tmp, "local");
  packDir = path.join(tmp, "packs");
});

afterEach(async () => {
  for (const release of gates.splice(0)) release();
  vi.restoreAllMocks();
  for (const dispose of disposers.splice(0).reverse()) dispose();
  for (const session of sessions.splice(0)) session.close("test done");
  await removeTempDir(socketDir);
  await fs.rm(tmp, { recursive: true, force: true });
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  gates.push(resolve);
  return { promise, resolve };
}

interface SetupOptions {
  /** Leave the folder service out, as a host from before folder uploads has none. */
  folders?: boolean;
  unpack?: typeof unpackFolderArchive;
  /** Bytes the host's sink has taken for each transfer. */
  onHostReceived?: (bytes: number) => void;
}

async function setup(options: SetupOptions = {}) {
  const hostExtra = options.onHostReceived
    ? {
        transfers: {
          onIncomingProgress: (_begin: unknown, bytes: number) => options.onHostReceived!(bytes),
        },
      }
    : {};
  const open = async () => {
    const pair = await openSessionPair(socketDir, hostExtra, {});
    sessions.push(pair.host, pair.client);
    return pair;
  };
  const inbox = new HostInbox({
    root: inboxRoot,
    freeBytes: async () => null,
    freeSpaceMarginBytes: 0,
  });
  const files = new HostUploadService({
    rootsFor: async () => [],
    isDriving: () => true,
    leaseIdFor: () => 1,
    inbox,
    freeBytes: async () => null,
  });
  const folders =
    options.folders === false
      ? null
      : new HostFolderUploadService({
          isDriving: () => true,
          leaseIdFor: () => 1,
          inbox,
          unpack: options.unpack,
        });
  if (folders) disposers.push(() => folders.dispose());
  const transport = new ClientUploadTransport();
  let current: LinkSession;
  /** The view's endpoint on a new link, for the same Shell, as a reconnect brings it back. */
  const link = async (endpoint: FakeEndpoint) => {
    const { host, client } = await open();
    files.attach(host, endpoint);
    folders?.attach(host, endpoint);
    transport.noteEndpointOpened(HOST, { session: client, webContentsId: 7, endpointId: "view-7" });
    current = client;
  };
  await link(new FakeEndpoint());
  const events: FileTransferEvent[] = [];
  const listeners: Array<(event: FileTransferEvent) => void> = [];
  const uploads = createHostUploadClient({
    transport,
    hostForView: () => HOST,
    hostLabel: () => "studio-01",
    sendToView: (_webContentsId, event) => {
      events.push(event);
      for (const listener of listeners) listener(event);
    },
    localLabel: "This Mac",
    packDir,
    random: () => 0.1,
  });
  disposers.push(() => uploads.dispose());
  return {
    uploads,
    transport,
    folders,
    events,
    onEvent: (listener: (event: FileTransferEvent) => void) => listeners.push(listener),
    relink: () => link(new FakeEndpoint("session-2:view-7", "view-7", "client-a")),
    dropLink: () => current.close("network went away"),
  };
}

type Uploads = Awaited<ReturnType<typeof setup>>["uploads"];

/** A folder on this machine, dropped in view 7 and summarized; resolves to its handle. */
async function droppedFolder(
  uploads: Uploads,
  tree: { files: Record<string, string | Buffer>; folders?: string[] },
  name = "Audit"
): Promise<string> {
  const root = path.join(localDir, name);
  await fs.mkdir(root, { recursive: true });
  for (const folder of tree.folders ?? [])
    await fs.mkdir(path.join(root, folder), { recursive: true });
  for (const [file, data] of Object.entries(tree.files)) {
    await fs.mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await fs.writeFile(path.join(root, file), data);
  }
  uploads.grantLocalSources(7, [root]);
  const summary = await uploads.summarizeLocalFolder(7, {
    localPath: root,
    opId: `walk-${crypto.randomUUID()}`,
  });
  if (summary.status !== "ready")
    throw new Error(`Expected a ready summary, got ${summary.status}`);
  return summary.handle;
}

const SMALL = {
  folders: ["src/empty"],
  files: { "README.md": "# Audit", "src/app.ts": "export {};" },
};

/** Big enough that its archive takes several chunks on the link. */
const LARGE = () => ({ files: { "video.bin": crypto.randomBytes(4 * BULK_CHUNK_BYTES) } });

function sendFolder(
  uploads: Uploads,
  handle: string,
  opId = "op-folder",
  destination: TransferDestination = INBOX
) {
  return uploads.uploadLocalFolder(7, { hostId: HOST, handle, opId, destination });
}

/** The phases the view was told about, in order, each once however often it was reported. */
function phasesOf(events: FileTransferEvent[], opId = "op-folder"): FolderUploadPhase[] {
  const phases: FolderUploadPhase[] = [];
  for (const event of events) {
    if (event.type !== "folder-progress" || event.opId !== opId) continue;
    if (phases[phases.length - 1] !== event.phase) phases.push(event.phase);
  }
  return phases;
}

async function publishedEntries(): Promise<string[]> {
  return fs.readdir(path.join(inboxRoot, "files")).catch(() => []);
}

/** Part files and staging folders: what an upload under way holds in the inbox root. */
async function inFlightLeftovers(): Promise<string[]> {
  const names = await fs.readdir(inboxRoot).catch(() => [] as string[]);
  return names.filter((name) => name.startsWith(".part-") || name.startsWith(".stage-"));
}

async function packedArchives(): Promise<string[]> {
  return fs.readdir(packDir).catch(() => []);
}

/**
 * Wraps the client's archive sends: the first serves one chunk, then waits
 * for the test (`release`); the rest go straight through.
 */
function holdFirstSend(transport: ClientUploadTransport) {
  const original = transport.sendFolderArchive.bind(transport);
  const gate = deferred();
  const atGate = deferred();
  let sends = 0;
  const spy = vi
    .spyOn(transport, "sendFolderArchive")
    .mockImplementation(async (session, source, token, options) => {
      sends += 1;
      if (sends > 1) return original(session, source, token, options);
      const held: TransferSource = {
        size: source.size,
        sha256: source.sha256,
        read: async (offset, length) => {
          if (offset >= BULK_CHUNK_BYTES) {
            atGate.resolve();
            await gate.promise;
          }
          return source.read(offset, length);
        },
        close: () => source.close?.(),
      };
      return original(session, held, token, options);
    });
  return { spy, atGate: atGate.promise, release: gate.resolve };
}

/**
 * An unpack that writes the whole tree into staging, then waits for the test
 * (`release`) or a cancel before the host publishes it.
 */
function heldUnpack() {
  const entered = deferred();
  const gate = deferred();
  const unpack: typeof unpackFolderArchive = async (args) => {
    const result = await unpackFolderArchive(args);
    entered.resolve();
    await Promise.race([
      gate.promise,
      new Promise<void>((resolve) => {
        if (args.signal?.aborted) resolve();
        args.signal?.addEventListener("abort", () => resolve());
      }),
    ]);
    return result;
  };
  return { unpack, entered: entered.promise, release: gate.resolve };
}

/** Files the host has unpacked into staging and not yet published or discarded. */
async function stagedFiles(): Promise<string[]> {
  const names = await fs.readdir(inboxRoot, { recursive: true }).catch(() => [] as string[]);
  return names.filter((name) => name.startsWith(".stage-") && name.endsWith("app.ts"));
}

function errorCode(error: unknown): string | undefined {
  return (error as { code?: string } | null)?.code;
}

describe("sending a folder to its host", () => {
  it("packs, sends and unpacks it in that order, and answers with its host path", async () => {
    const { uploads, events } = await setup();
    const handle = await droppedFolder(uploads, SMALL);

    const result = await sendFolder(uploads, handle);

    expect(result.status).toBe("sent");
    if (result.status !== "sent") return;
    expect(path.basename(result.hostPath)).toBe("Audit");
    expect(await fs.readFile(path.join(result.hostPath, "src", "app.ts"), "utf8")).toBe(
      "export {};"
    );
    expect((await fs.stat(path.join(result.hostPath, "src", "empty"))).isDirectory()).toBe(true);
    expect(result.totals).toEqual({ fileCount: 2, folderCount: 2, totalBytes: 17 });
    expect(phasesOf(events)).toEqual(["packing", "sending", "unpacking"]);
    const last = events.at(-1);
    expect(last).toMatchObject({ type: "folder-progress", phase: "unpacking", filesDone: 2 });
    expect(await publishedEntries()).toHaveLength(1);
    expect(await inFlightLeftovers()).toEqual([]);
    expect(await packedArchives()).toEqual([]);
  });

  it("measures each phase in its own units", async () => {
    const { uploads, events } = await setup();
    const handle = await droppedFolder(uploads, LARGE());

    await sendFolder(uploads, handle, "op-measured");

    const progress = events.filter((event) => event.type === "folder-progress");
    expect(progress.every((event) => event.opId === "op-measured")).toBe(true);
    expect(phasesOf(events, "op-measured")).toEqual(["packing", "sending", "unpacking"]);
    const sending = progress.filter((event) => event.phase === "sending");
    expect(sending.at(-1)?.transferredBytes).toBe(sending.at(-1)?.totalBytes);
    for (const event of sending) {
      expect(event.filesDone).toBeNull();
      expect(event.totalBytes).toBeGreaterThan(4 * BULK_CHUNK_BYTES);
    }
    for (const event of progress.filter((e) => e.phase !== "sending")) {
      expect(event.totalBytes).toBe(4 * BULK_CHUNK_BYTES);
    }
    for (const event of progress.filter((e) => e.phase === "unpacking")) {
      expect(event.transferredBytes).toBeNull();
    }
  });

  it("answers what changed when the folder changed since its summary, sending nothing", async () => {
    const { uploads, folders } = await setup();
    const handle = await droppedFolder(uploads, SMALL);
    await fs.writeFile(path.join(localDir, "Audit", "src", "app.ts"), "export const changed = 1;");

    await expect(sendFolder(uploads, handle)).resolves.toEqual({
      status: "changed",
      path: "Audit/src/app.ts",
      change: "modified",
    });
    const records = (folders as unknown as { operations: Map<string, unknown> }).operations;
    expect(records.size).toBe(0);
    expect(await packedArchives()).toEqual([]);
  });

  it("shares one send between asks under the same id, and refuses the id for another folder", async () => {
    const { uploads, transport } = await setup();
    const prepares = vi.spyOn(transport, "prepareFolder");
    const handle = await droppedFolder(uploads, SMALL);
    const other = await droppedFolder(uploads, SMALL, "Other");

    const first = sendFolder(uploads, handle);
    const again = sendFolder(uploads, handle);
    await expect(sendFolder(uploads, other)).rejects.toMatchObject({ code: "VALIDATION" });
    await expect(
      uploads.uploadBytes(7, {
        hostId: HOST,
        bytes: new Uint8Array([1]),
        name: "a.bin",
        mimeType: null,
        destination: INBOX,
        opId: "op-folder",
      })
    ).rejects.toMatchObject({ code: "VALIDATION" });

    const [one, two] = await Promise.all([first, again]);
    expect(two).toEqual(one);
    expect(prepares).toHaveBeenCalledTimes(1);
    expect(await publishedEntries()).toHaveLength(1);
  });
});

describe("cancelling a folder send", () => {
  it("while packing, before the host hears of it", async () => {
    const { uploads, folders, onEvent } = await setup();
    const handle = await droppedFolder(uploads, SMALL);
    onEvent((event) => {
      if (event.type === "folder-progress" && event.phase === "packing") {
        uploads.cancel("op-folder", 7);
      }
    });

    await expect(sendFolder(uploads, handle)).rejects.toMatchObject({ code: "CANCELLED" });

    const records = (folders as unknown as { operations: Map<string, unknown> }).operations;
    expect(records.size).toBe(0);
    expect(await publishedEntries()).toEqual([]);
    expect(await packedArchives()).toEqual([]);
  });

  it("while the archive is on its way, leaving nothing on the host", async () => {
    let hostReceived = 0;
    const { uploads, transport, events } = await setup({
      onHostReceived: (bytes) => {
        hostReceived = bytes;
      },
    });
    const held = holdFirstSend(transport);
    const cancels = vi.spyOn(transport, "cancelFolder");
    const handle = await droppedFolder(uploads, LARGE());

    const sent = sendFolder(uploads, handle);
    await held.atGate;
    await vi.waitFor(() => expect(hostReceived).toBeGreaterThan(0));
    expect(phasesOf(events).at(-1)).toBe("sending");
    expect(uploads.cancel("op-folder", 7)).toBe(true);

    await expect(sent).rejects.toMatchObject({ code: "CANCELLED" });
    expect(cancels).toHaveBeenCalledWith(HOST, "op-folder", expect.anything());
    expect(await publishedEntries()).toEqual([]);
    expect(await inFlightLeftovers()).toEqual([]);
    expect(await packedArchives()).toEqual([]);
  });

  it("while the host unpacks it, removing what it staged", async () => {
    const held = heldUnpack();
    const { uploads, events } = await setup({ unpack: held.unpack });
    const handle = await droppedFolder(uploads, SMALL);

    const sent = sendFolder(uploads, handle);
    await held.entered;
    await vi.waitFor(() => expect(phasesOf(events).at(-1)).toBe("unpacking"));
    expect(await stagedFiles()).toHaveLength(1);
    expect(uploads.cancel("op-folder", 7)).toBe(true);

    await expect(sent).rejects.toMatchObject({ code: "CANCELLED" });
    expect(await publishedEntries()).toEqual([]);
    expect(await inFlightLeftovers()).toEqual([]);
    expect(await packedArchives()).toEqual([]);
  });

  it("that arrives before its send, which starts cancelled", async () => {
    const { uploads, folders } = await setup();
    const handle = await droppedFolder(uploads, SMALL);

    expect(uploads.cancel("op-folder", 7)).toBe(false);
    await expect(sendFolder(uploads, handle)).rejects.toMatchObject({ code: "CANCELLED" });

    const records = (folders as unknown as { operations: Map<string, unknown> }).operations;
    expect(records.size).toBe(0);
  });

  it("only from the view that started it", async () => {
    const held = heldUnpack();
    const { uploads } = await setup({ unpack: held.unpack });
    const handle = await droppedFolder(uploads, SMALL);

    const sent = sendFolder(uploads, handle);
    await held.entered;
    expect(uploads.cancel("op-folder", 8)).toBe(false);
    held.release();

    await expect(sent).resolves.toMatchObject({ status: "sent" });
  });
});

describe("a link that drops during a folder send", () => {
  it("mid-transfer: the same archive goes again once the host is back, and the folder lands once", async () => {
    let hostReceived = 0;
    const { uploads, transport, events, relink, dropLink } = await setup({
      onHostReceived: (bytes) => {
        hostReceived = bytes;
      },
    });
    const held = holdFirstSend(transport);
    const packs = vi.spyOn(uploads, "packFolder");
    const prepares = vi.spyOn(transport, "prepareFolder");
    const handle = await droppedFolder(uploads, LARGE());

    const sent = sendFolder(uploads, handle);
    await held.atGate;
    await vi.waitFor(() => expect(hostReceived).toBeGreaterThan(0));
    dropLink();
    await relink();

    const result = await sent;
    expect(result.status).toBe("sent");
    expect(packs).toHaveBeenCalledTimes(1);
    expect(held.spy).toHaveBeenCalledTimes(2);
    // Asked again under the view's id; the host recorded that archive as never
    // arriving whole, so it went again as an operation of its own.
    expect(prepares.mock.calls.map(([, request]) => request.opId)).toEqual([
      "op-folder",
      "op-folder",
      expect.stringMatching(/^resend-[0-9a-f]{32}$/),
    ]);
    expect(phasesOf(events)).toEqual(["packing", "sending", "unpacking"]);
    expect(await publishedEntries()).toHaveLength(1);
    expect(await inFlightLeftovers()).toEqual([]);
    expect(await packedArchives()).toEqual([]);
  });

  it("mid-unpack: the host's record answers once it is back, and nothing is sent again", async () => {
    const held = heldUnpack();
    const { uploads, transport, events, relink, dropLink } = await setup({
      unpack: held.unpack,
    });
    const sends = vi.spyOn(transport, "sendFolderArchive");
    const prepares = vi.spyOn(transport, "prepareFolder");
    const statusFailures: Array<string | undefined> = [];
    const askStatus = transport.folderStatus.bind(transport);
    vi.spyOn(transport, "folderStatus").mockImplementation(async (...args) => {
      try {
        return await askStatus(...args);
      } catch (error) {
        statusFailures.push(errorCode(error));
        throw error;
      }
    });
    const handle = await droppedFolder(uploads, SMALL);

    const sent = sendFolder(uploads, handle);
    await held.entered;
    expect(await stagedFiles()).toHaveLength(1);
    dropLink();
    await vi.waitFor(() => expect(statusFailures).toContain("HOST_DISCONNECTED"));
    await relink();
    held.release();

    const result = await sent;
    expect(result.status).toBe("sent");
    expect(sends).toHaveBeenCalledTimes(1);
    expect(prepares).toHaveBeenCalledTimes(1);
    expect(phasesOf(events)).toEqual(["packing", "sending", "unpacking"]);
    expect(await publishedEntries()).toHaveLength(1);
  });
});

describe("a host from before folder uploads", () => {
  it("is named as needing an update, while single files still go", async () => {
    const { uploads } = await setup({ folders: false });
    const handle = await droppedFolder(uploads, SMALL);

    await expect(sendFolder(uploads, handle)).rejects.toMatchObject({
      code: "UNSUPPORTED",
      userMessage: "Update Daintree on studio-01 to send folders.",
    });
    expect(await packedArchives()).toEqual([]);

    const file = await uploads.uploadBytes(7, {
      hostId: HOST,
      bytes: new TextEncoder().encode("notes"),
      name: "notes.txt",
      mimeType: null,
      destination: INBOX,
      opId: "op-file",
    });
    expect(await fs.readFile(file.hostPath, "utf8")).toBe("notes");
  });
});

describe("a folder's destination", () => {
  it("is refused when it names a worktree, before anything is packed or asked", async () => {
    const { uploads, folders } = await setup();
    const packs = vi.spyOn(uploads, "packFolder");
    const handle = await droppedFolder(uploads, SMALL);

    await expect(
      sendFolder(uploads, handle, "op-folder", { kind: "worktree", directory: "/srv/project/src" })
    ).rejects.toMatchObject({
      code: "VALIDATION",
      userMessage: expect.stringContaining("to send it to the inbox"),
    });
    await expect(
      sendFolder(uploads, handle, "op-clip", { kind: "inbox", bucket: "clipboard" })
    ).rejects.toMatchObject({ code: "VALIDATION" });

    const records = (folders as unknown as { operations: Map<string, unknown> }).operations;
    expect(records.size).toBe(0);
    expect(packs).not.toHaveBeenCalled();
  });
});
