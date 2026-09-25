import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  app: { isPackaged: true, on: vi.fn(), getPath: vi.fn(() => os.tmpdir()) },
}));

import { AppError } from "../../../utils/errorTypes.js";
import type { LinkSession } from "../../link/session.js";
import { bytesTransferSource, type TransferSource } from "../../link/transfer.js";
import { makeTempDir, openSessionPair, removeTempDir } from "../../link/__tests__/linkTestUtils.js";
import { ClientUploadTransport } from "../ClientUploadTransport.js";
import type { HostFileEndpoint } from "../HostFileService.js";
import { HostInbox } from "../hostInbox.js";
import { HostUploadService } from "../HostUploadService.js";
import { createHostUploadClient } from "../uploadClient.js";
import type { TransferDestination } from "../../../../shared/types/ipc/fileTransfer.js";
import { UPLOAD_SINK_PREFIX, UploadLinkMethod } from "../uploadLinkMethods.js";

const HOST = "studio-01";

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
}

let socketDir: string;
let project: string;
let outside: string;
let inboxRoot: string;
const sessions: LinkSession[] = [];

beforeEach(async () => {
  socketDir = await makeTempDir();
  project = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "up-proj-")));
  outside = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "up-out-")));
  const tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "up-inbox-")));
  inboxRoot = path.join(tmp, "daintree-inbox");
});

afterEach(async () => {
  for (const session of sessions.splice(0)) session.close("test done");
  await removeTempDir(socketDir);
  for (const dir of [project, outside, path.dirname(inboxRoot)]) {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

async function setup(
  options: {
    driving?: () => boolean;
    freeBytes?: number | null;
    leaseId?: () => number | null;
    rootsFor?: (projectId: string) => Promise<string[]>;
    outcomeTtlMs?: number;
  } = {}
) {
  const { host, client } = await openSessionPair(socketDir);
  sessions.push(host, client);
  const endpoint = new FakeEndpoint();
  const inbox = new HostInbox({ root: inboxRoot });
  const service = new HostUploadService({
    rootsFor: options.rootsFor ?? (async (projectId) => (projectId === "p1" ? [project] : [])),
    isDriving: () => options.driving?.() ?? true,
    outcomeTtlMs: options.outcomeTtlMs,
    leaseIdFor: () => (options.leaseId ? options.leaseId() : 1),
    inbox,
    freeBytes: async () => (options.freeBytes === undefined ? null : options.freeBytes),
  });
  service.attach(host, endpoint);
  const transport = new ClientUploadTransport();
  transport.noteEndpointOpened(HOST, { session: client, webContentsId: 7, endpointId: "view-7" });
  const upload = (
    source: TransferSource,
    name: string,
    destination: Parameters<ClientUploadTransport["upload"]>[2]["destination"] = {
      kind: "inbox",
      bucket: "files",
    },
    extra: {
      signal?: AbortSignal;
      onProgress?: (sent: number, total: number) => void;
      opId?: string;
      webContentsId?: number;
    } = {}
  ) =>
    transport.upload(HOST, source, {
      webContentsId: 7,
      opId: `op-${crypto.randomUUID()}`,
      hostLabel: "studio-01",
      name,
      destination,
      ...extra,
    });
  return { host, client, service, transport, inbox, upload, endpoint };
}

const TEXT = (value: string) => bytesTransferSource(bytes(value));

const PNG_HEAD = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const JPEG_HEAD = [0xff, 0xd8, 0xff, 0xe0];

function bytes(text: string, head: number[] = []): Uint8Array {
  return new Uint8Array([...head, ...Buffer.from(text)]);
}

async function listFilesBucket(): Promise<string[]> {
  return fs.readdir(path.join(inboxRoot, "files")).catch(() => []);
}

describe("uploads into the host inbox", () => {
  it("places a dropped file under files/<stamp>-<id>/<name>, owner-only", async () => {
    const { upload } = await setup();
    const content = bytes("invoice contents");
    const result = await upload(bytesTransferSource(content), "invoice-march.pdf");

    expect(result.deduplicated).toBe(false);
    expect(path.basename(result.hostPath)).toBe("invoice-march.pdf");
    const id = crypto.createHash("sha256").update(content).digest("hex").slice(0, 12);
    expect(path.basename(path.dirname(result.hostPath))).toMatch(
      new RegExp(`^\\d{8}-\\d{6}-${id}$`)
    );
    expect(path.dirname(path.dirname(result.hostPath))).toBe(path.join(inboxRoot, "files"));
    expect(Buffer.from(await fs.readFile(result.hostPath)).toString()).toBe("invoice contents");
    expect((await fs.stat(result.hostPath)).mode & 0o777).toBe(0o600);
    expect((await fs.stat(path.dirname(result.hostPath))).mode & 0o777).toBe(0o700);
    expect((await fs.stat(inboxRoot)).mode & 0o777).toBe(0o700);
    expect((await fs.readdir(inboxRoot)).filter((n) => n.startsWith(".part-"))).toEqual([]);
  });

  it("reuses the inbox file when the same bytes are dropped again", async () => {
    const { upload } = await setup();
    const content = bytes("same bytes");
    const first = await upload(bytesTransferSource(content), "notes.txt");
    const second = await upload(bytesTransferSource(content), "notes.txt");
    expect(second).toEqual({
      hostPath: first.hostPath,
      bytes: content.byteLength,
      deduplicated: true,
    });
    expect(await listFilesBucket()).toHaveLength(1);
  });

  it("does not reuse a file whose content changed on the host", async () => {
    const { upload } = await setup();
    const content = bytes("original");
    const first = await upload(bytesTransferSource(content), "notes.txt");
    await fs.writeFile(first.hostPath, "tampered");
    const second = await upload(bytesTransferSource(content), "notes.txt");
    expect(second.deduplicated).toBe(false);
    expect(second.hostPath).not.toBe(first.hostPath);
  });

  it("never trusts an image extension over the content", async () => {
    const { upload } = await setup();
    const jpeg = await upload(bytesTransferSource(bytes("jpeg data", JPEG_HEAD)), "shot.png");
    expect(path.basename(jpeg.hostPath)).toBe("shot.jpg");
    const text = await upload(bytesTransferSource(bytes("not an image")), "fake.png");
    expect(path.basename(text.hostPath)).toBe("fake.bin");
  });

  it("strips separators and control characters from the name", async () => {
    const { upload } = await setup();
    const result = await upload(bytesTransferSource(bytes("x")), "../..\\evil\u0007name.txt");
    expect(path.basename(result.hostPath)).toBe("evilname.txt");
    expect(path.dirname(path.dirname(result.hostPath))).toBe(path.join(inboxRoot, "files"));
  });

  it("names pasted images by timestamp and content in clipboard/", async () => {
    const { upload } = await setup();
    const result = await upload(bytesTransferSource(bytes("png", PNG_HEAD)), "clipboard.png", {
      kind: "inbox",
      bucket: "clipboard",
    });
    expect(path.dirname(result.hostPath)).toBe(path.join(inboxRoot, "clipboard"));
    expect(path.basename(result.hostPath)).toMatch(/^clipboard-\d{8}-\d{6}-[0-9a-f]{12}\.png$/);
  });

  it("refuses bytes that don't match the announced sha256, and places nothing", async () => {
    const { upload } = await setup();
    const real = bytes("the real bytes");
    const lie: TransferSource = {
      size: real.byteLength,
      sha256: crypto.createHash("sha256").update(bytes("other bytes!!!")).digest("hex"),
      read: async (offset, length) => real.subarray(offset, offset + length),
    };
    await expect(upload(lie, "a.txt")).rejects.toMatchObject({ code: "INTERNAL" });
    expect(await listFilesBucket()).toEqual([]);
    const deadline = Date.now() + 2_000;
    let parts = (await fs.readdir(inboxRoot)).filter((n) => n.startsWith(".part-"));
    while (parts.length > 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      parts = (await fs.readdir(inboxRoot)).filter((n) => n.startsWith(".part-"));
    }
    expect(parts).toEqual([]);
  });

  it("names the host when it is out of disk space", async () => {
    const { upload } = await setup({ freeBytes: 10 });
    await expect(upload(bytesTransferSource(bytes("x")), "a.txt")).rejects.toMatchObject({
      userMessage: "studio-01 is out of disk space.",
    });
  });

  it("refuses an endpoint that doesn't drive the project", async () => {
    const { upload } = await setup({ driving: () => false });
    await expect(upload(bytesTransferSource(bytes("x")), "a.txt")).rejects.toMatchObject({
      code: "DRIVEN_ELSEWHERE",
    });
  });

  it("stops when the upload is cancelled, leaving nothing behind", async () => {
    const { upload } = await setup();
    const controller = new AbortController();
    const big = new Uint8Array(8 * 1024 * 1024);
    const pending = upload(bytesTransferSource(big), "big.bin", undefined, {
      signal: controller.signal,
      onProgress: () => controller.abort(),
    });
    await expect(pending).rejects.toBeInstanceOf(AppError);
    await expect(pending).rejects.toMatchObject({ code: "CANCELLED" });
    const deadline = Date.now() + 2_000;
    let parts = (await fs.readdir(inboxRoot)).filter((n) => n.startsWith(".part-"));
    while (parts.length > 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      parts = (await fs.readdir(inboxRoot)).filter((n) => n.startsWith(".part-"));
    }
    expect(parts).toEqual([]);
    expect(await listFilesBucket()).toEqual([]);
  });

  it("names the host when it isn't connected", async () => {
    const { upload, client } = await setup();
    client.close("gone");
    await expect(upload(bytesTransferSource(bytes("x")), "a.txt")).rejects.toMatchObject({
      code: "HOST_DISCONNECTED",
      userMessage: "Not connected to studio-01.",
    });
  });
});

describe("Add to project", () => {
  it("writes into a folder of the project, ready to commit", async () => {
    const { upload } = await setup();
    await fs.mkdir(path.join(project, "docs"));
    const result = await upload(bytesTransferSource(bytes("spec")), "spec.md", {
      kind: "worktree",
      directory: path.join(project, "docs"),
    });
    expect(result).toEqual({
      hostPath: path.join(project, "docs", "spec.md"),
      bytes: 4,
      deduplicated: false,
    });
    expect(await fs.readFile(path.join(project, "docs", "spec.md"), "utf8")).toBe("spec");
    expect(await fs.readdir(path.join(project, "docs"))).toEqual(["spec.md"]);
  });

  it("never overwrites an existing file without confirmation", async () => {
    const { upload } = await setup();
    await fs.writeFile(path.join(project, "README.md"), "mine");
    const result = await upload(bytesTransferSource(bytes("theirs")), "README.md", {
      kind: "worktree",
      directory: project,
    });
    expect(result).toMatchObject({ conflict: true, hostPath: path.join(project, "README.md") });
    expect(await fs.readFile(path.join(project, "README.md"), "utf8")).toBe("mine");

    expect(result.replaceToken).toMatch(/^[0-9a-f]{32}$/);

    const replaced = await upload(bytesTransferSource(bytes("theirs")), "README.md", {
      kind: "worktree",
      directory: project,
      replaceToken: result.replaceToken!,
    });
    expect(replaced.conflict).toBeUndefined();
    expect(await fs.readFile(path.join(project, "README.md"), "utf8")).toBe("theirs");
    expect(await fs.readdir(project)).toEqual(["README.md"]);
  });

  it("refuses a folder outside the project, including through a symlink", async () => {
    const { upload } = await setup();
    await expect(
      upload(bytesTransferSource(bytes("x")), "a.txt", { kind: "worktree", directory: outside })
    ).rejects.toMatchObject({ code: "OUTSIDE_ROOT" });
    await fs.symlink(outside, path.join(project, "link"));
    await expect(
      upload(bytesTransferSource(bytes("x")), "a.txt", {
        kind: "worktree",
        directory: path.join(project, "link"),
      })
    ).rejects.toMatchObject({ code: "OUTSIDE_ROOT" });
    expect(await fs.readdir(outside)).toEqual([]);
  });

  it("won't replace something that isn't a file", async () => {
    const { upload } = await setup();
    await fs.mkdir(path.join(project, "dir.txt"));
    await expect(
      upload(bytesTransferSource(bytes("x")), "dir.txt", { kind: "worktree", directory: project })
    ).rejects.toMatchObject({ code: "NOT_A_FILE" });
  });
});

describe("replacing a project file", () => {
  async function conflictFor(
    upload: Awaited<ReturnType<typeof setup>>["upload"],
    content = "theirs"
  ): Promise<string> {
    const result = await upload(TEXT(content), "README.md", {
      kind: "worktree",
      directory: project,
    });
    expect(result.conflict).toBe(true);
    return result.replaceToken!;
  }

  it("ignores a wire `overwrite: true`: the clash is reported and nothing is replaced", async () => {
    const { client } = await setup();
    await fs.writeFile(path.join(project, "README.md"), "mine");
    const source = TEXT("theirs");
    const answer = await client.call(UploadLinkMethod.PREPARE, {
      endpointId: "view-7",
      name: "README.md",
      size: source.size,
      sha256: source.sha256,
      opId: "op-forged",
      destination: { kind: "worktree", directory: project, overwrite: true },
    });
    expect(answer).toMatchObject({ status: "conflict" });
    expect(await fs.readFile(path.join(project, "README.md"), "utf8")).toBe("mine");
  });

  it("spends the token on one replacement", async () => {
    const { upload } = await setup();
    await fs.writeFile(path.join(project, "README.md"), "mine");
    const token = await conflictFor(upload);
    await upload(TEXT("theirs"), "README.md", {
      kind: "worktree",
      directory: project,
      replaceToken: token,
    });
    const again = await upload(TEXT("third"), "README.md", {
      kind: "worktree",
      directory: project,
      replaceToken: token,
    });
    expect(again.conflict).toBe(true);
    expect(again.replaceToken).not.toBe(token);
    expect(await fs.readFile(path.join(project, "README.md"), "utf8")).toBe("theirs");
  });

  it("won't replace a file that changed after the clash was reported", async () => {
    const { upload } = await setup();
    await fs.writeFile(path.join(project, "README.md"), "mine");
    const token = await conflictFor(upload);
    await fs.writeFile(path.join(project, "README.md"), "mine, edited since");
    const retry = await upload(TEXT("theirs"), "README.md", {
      kind: "worktree",
      directory: project,
      replaceToken: token,
    });
    expect(retry.conflict).toBe(true);
    expect(await fs.readFile(path.join(project, "README.md"), "utf8")).toBe("mine, edited since");
  });

  it("won't take a token issued to another endpoint", async () => {
    const { upload, service, host, transport, client } = await setup();
    const other = new FakeEndpoint("session-1:view-8", "view-8", "client-a");
    service.attach(host, other);
    transport.noteEndpointOpened(HOST, { session: client, webContentsId: 8, endpointId: "view-8" });
    await fs.writeFile(path.join(project, "README.md"), "mine");
    const token = await conflictFor(upload);
    const stolen = await upload(
      TEXT("theirs"),
      "README.md",
      { kind: "worktree", directory: project, replaceToken: token },
      { webContentsId: 8 }
    );
    expect(stolen.conflict).toBe(true);
    expect(await fs.readFile(path.join(project, "README.md"), "utf8")).toBe("mine");
  });

  it("won't take a token for different bytes than the clash was reported for", async () => {
    const { upload } = await setup();
    await fs.writeFile(path.join(project, "README.md"), "mine");
    const token = await conflictFor(upload, "theirs");
    const swapped = await upload(TEXT("something else"), "README.md", {
      kind: "worktree",
      directory: project,
      replaceToken: token,
    });
    expect(swapped.conflict).toBe(true);
    expect(await fs.readFile(path.join(project, "README.md"), "utf8")).toBe("mine");
  });

  it("won't take a token across a drive-lease takeover", async () => {
    let lease = 1;
    const { upload } = await setup({ leaseId: () => lease });
    await fs.writeFile(path.join(project, "README.md"), "mine");
    const token = await conflictFor(upload);
    lease = 2;
    const retry = await upload(TEXT("theirs"), "README.md", {
      kind: "worktree",
      directory: project,
      replaceToken: token,
    });
    expect(retry.conflict).toBe(true);
    expect(await fs.readFile(path.join(project, "README.md"), "utf8")).toBe("mine");
  });
});

describe("placing under a confirmed replacement", () => {
  async function prepareReplace(client: LinkSession, token: string, opId: string) {
    const source = TEXT("theirs");
    const prepared = (await client.call(UploadLinkMethod.PREPARE, {
      endpointId: "view-7",
      name: "README.md",
      size: source.size,
      sha256: source.sha256,
      opId,
      destination: { kind: "worktree", directory: project, replaceToken: token },
    })) as { status: string; token: string };
    expect(prepared.status).toBe("ready");
    return { source, sinkToken: prepared.token };
  }

  it("fails closed when the confirmed file is gone by the time the bytes land", async () => {
    const { upload, client } = await setup();
    await fs.writeFile(path.join(project, "README.md"), "mine");
    const clash = await upload(TEXT("theirs"), "README.md", {
      kind: "worktree",
      directory: project,
    });
    const { source, sinkToken } = await prepareReplace(client, clash.replaceToken!, "op-gone");
    await fs.rm(path.join(project, "README.md"));
    await expect(
      client.transfers.send(source, {
        name: "README.md",
        destination: { kind: "path", path: `${UPLOAD_SINK_PREFIX}${sinkToken}` },
      })
    ).rejects.toBeTruthy();
    expect(await fs.readdir(project)).toEqual([]);
  });

  it("re-checks the drive lease just before replacing", async () => {
    let lease = 1;
    const { upload, client } = await setup({ leaseId: () => lease });
    await fs.writeFile(path.join(project, "README.md"), "mine");
    const clash = await upload(TEXT("theirs"), "README.md", {
      kind: "worktree",
      directory: project,
    });
    const { source, sinkToken } = await prepareReplace(client, clash.replaceToken!, "op-lease");
    lease = 2;
    await expect(
      client.transfers.send(source, {
        name: "README.md",
        destination: { kind: "path", path: `${UPLOAD_SINK_PREFIX}${sinkToken}` },
      })
    ).rejects.toBeTruthy();
    expect(await fs.readFile(path.join(project, "README.md"), "utf8")).toBe("mine");
    expect(await fs.readdir(project)).toEqual(["README.md"]);
  });

  it("never clobbers a file that appeared under the name while adding", async () => {
    const { client } = await setup();
    const source = TEXT("spec");
    const prepared = (await client.call(UploadLinkMethod.PREPARE, {
      endpointId: "view-7",
      name: "spec.md",
      size: source.size,
      sha256: source.sha256,
      opId: "op-race",
      destination: { kind: "worktree", directory: project },
    })) as { status: string; token: string };
    expect(prepared.status).toBe("ready");
    await fs.writeFile(path.join(project, "spec.md"), "someone else's");
    await expect(
      client.transfers.send(source, {
        name: "spec.md",
        destination: { kind: "path", path: `${UPLOAD_SINK_PREFIX}${prepared.token}` },
      })
    ).rejects.toBeTruthy();
    expect(await fs.readFile(path.join(project, "spec.md"), "utf8")).toBe("someone else's");
    expect(await fs.readdir(project)).toEqual(["spec.md"]);
  });
});

describe("a drive-lease takeover", () => {
  it("stops a new file from being published by the old driver", async () => {
    let lease = 1;
    const { upload } = await setup({ leaseId: () => lease });
    // The takeover lands while the bytes are being copied into the project.
    const open = fs.open.bind(fs);
    const spy = vi.spyOn(fs, "open").mockImplementation((async (
      ...args: Parameters<typeof fs.open>
    ) => {
      if (String(args[0]).includes(".daintree-upload-")) lease = 2;
      return open(...args);
    }) as typeof fs.open);
    try {
      await expect(
        upload(TEXT("spec"), "spec.md", { kind: "worktree", directory: project })
      ).rejects.toBeTruthy();
    } finally {
      spy.mockRestore();
    }
    expect(await fs.readdir(project)).toEqual([]);
  });

  it("refuses the bytes of an upload prepared before the takeover", async () => {
    let lease = 1;
    const { client } = await setup({ leaseId: () => lease });
    const source = TEXT("spec");
    const prepared = (await client.call(UploadLinkMethod.PREPARE, {
      endpointId: "view-7",
      name: "spec.md",
      size: source.size,
      sha256: source.sha256,
      opId: "op-before",
      destination: { kind: "worktree", directory: project },
    })) as { status: string; token: string };
    lease = 2;
    await expect(
      client.transfers.send(source, {
        name: "spec.md",
        destination: { kind: "path", path: `${UPLOAD_SINK_PREFIX}${prepared.token}` },
      })
    ).rejects.toBeTruthy();
    expect(await fs.readdir(project)).toEqual([]);
  });

  it("stops uploads in flight for that project when told of the takeover", async () => {
    let lease = 1;
    const { upload, service } = await setup({ leaseId: () => lease });
    const big = new Uint8Array(8 * 1024 * 1024);
    let stopped = false;
    await expect(
      upload(
        bytesTransferSource(big),
        "big.bin",
        { kind: "worktree", directory: project },
        {
          onProgress: () => {
            if (stopped) return;
            stopped = true;
            lease = 2;
            service.onLeaseChanged("p1");
          },
        }
      )
    ).rejects.toBeTruthy();
    expect(await fs.readdir(project)).toEqual([]);
  });
});

describe("operation records", () => {
  const records = (service: HostUploadService) =>
    (service as unknown as { operations: Map<string, unknown> }).operations;

  it("records nothing for a prepare whose link closed while it ran", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { client, host, service } = await setup({
      rootsFor: async () => {
        await gate;
        return [project];
      },
    });
    const source = TEXT("spec");
    const answer = client
      .call(UploadLinkMethod.PREPARE, {
        endpointId: "view-7",
        name: "spec.md",
        size: source.size,
        sha256: source.sha256,
        opId: "op-closing",
        destination: { kind: "worktree", directory: project },
      })
      .catch(() => null);
    await vi.waitFor(() => expect(records(service).size).toBe(1));
    host.close("gone");
    release();
    await answer;
    await vi.waitFor(() => expect(records(service).size).toBe(0));
  });

  it("keeps a placement's id while its transfer is still running", async () => {
    const { upload, service } = await setup({ outcomeTtlMs: 1 });
    const expire = () => (service as unknown as { expireOperations(): void }).expireOperations();
    let heldDuringTransfer: boolean | null = null;
    const realNow = Date.now.bind(Date);
    await upload(bytesTransferSource(new Uint8Array(4 * 1024 * 1024)), "big.bin", undefined, {
      opId: "op-long",
      onProgress: () => {
        if (heldDuringTransfer !== null) return;
        const spy = vi.spyOn(Date, "now").mockImplementation(() => realNow() + 60 * 60_000);
        try {
          expire();
        } finally {
          spy.mockRestore();
        }
        heldDuringTransfer = [...records(service).keys()].some((key) => key.endsWith("op-long"));
      },
    });
    expect(heldDuringTransfer).toBe(true);
  });

  it("frees an id whose prepare never finished", async () => {
    const { client, service } = await setup({
      outcomeTtlMs: 1,
      rootsFor: () => new Promise<string[]>(() => {}),
    });
    const source = TEXT("spec");
    void client
      .call(UploadLinkMethod.PREPARE, {
        endpointId: "view-7",
        name: "spec.md",
        size: source.size,
        sha256: source.sha256,
        opId: "op-stuck",
        destination: { kind: "worktree", directory: project },
      })
      .catch(() => null);
    await vi.waitFor(() => expect(records(service).size).toBe(1));
    await new Promise((resolve) => setTimeout(resolve, 5));
    (service as unknown as { expireOperations(): void }).expireOperations();
    expect(records(service).size).toBe(0);
  });

  it("expires an operation that was prepared and then abandoned", async () => {
    const { client, service } = await setup({ outcomeTtlMs: 1 });
    const prepare = (opId: string, content: string) => {
      const source = TEXT(content);
      return client.call(UploadLinkMethod.PREPARE, {
        endpointId: "view-7",
        name: `${opId}.txt`,
        size: source.size,
        sha256: source.sha256,
        opId,
        destination: { kind: "inbox", bucket: "files" },
      });
    };
    await prepare("op-abandoned", "one");
    await new Promise((resolve) => setTimeout(resolve, 5));
    await prepare("op-next", "two");
    expect([...records(service).keys()].some((key) => key.endsWith("op-abandoned"))).toBe(false);
  });
});

describe("operation ids", () => {
  it("lets only one of two concurrent prepares claim an id", async () => {
    const { client } = await setup();
    const prepare = (content: string) => {
      const source = TEXT(content);
      return client.call(UploadLinkMethod.PREPARE, {
        endpointId: "view-7",
        name: "a.txt",
        size: source.size,
        sha256: source.sha256,
        opId: "op-twice",
        destination: { kind: "inbox", bucket: "files" },
      });
    };
    const answers = await Promise.allSettled([prepare("one"), prepare("two")]);
    const ready = answers.filter(
      (answer) =>
        answer.status === "fulfilled" && (answer.value as { status: string }).status === "ready"
    );
    expect(ready).toHaveLength(1);
  });

  it("recovers a replacement whose acknowledgement was lost, without replacing again", async () => {
    const { transport, client } = await setup();
    await fs.writeFile(path.join(project, "README.md"), "mine");
    const uploads = createHostUploadClient({
      transport,
      hostForView: () => HOST,
      hostLabel: () => "studio-01",
      sendToView: () => {},
      localLabel: "This Mac",
    });
    const send = (destination: TransferDestination, opId: string) =>
      uploads.uploadBytes(7, {
        hostId: HOST,
        bytes: bytes("theirs"),
        name: "README.md",
        mimeType: null,
        destination,
        opId,
      });
    const clash = await send({ kind: "worktree", directory: project }, "op-ask");
    // The file lands, then the answer is lost on the way back; meanwhile the
    // user edits the file on the host.
    const realSend = client.transfers.send.bind(client.transfers);
    const sendSpy = vi
      .spyOn(client.transfers, "send")
      .mockImplementationOnce(async (...args: Parameters<typeof realSend>) => {
        await realSend(...args);
        await fs.writeFile(path.join(project, "README.md"), "newer edits");
        throw new AppError({ code: "OUTCOME_UNKNOWN", message: "ack lost" });
      });
    const result = await send(
      { kind: "worktree", directory: project, replaceToken: clash.replaceToken! },
      "op-replace"
    );
    expect(result).toEqual({
      hostPath: path.join(project, "README.md"),
      bytes: 6,
      deduplicated: false,
    });
    expect(sendSpy).toHaveBeenCalledTimes(1);
    expect(await fs.readFile(path.join(project, "README.md"), "utf8")).toBe("newer edits");
  });

  it("answers a retry after a lost acknowledgement from the record, never replacing twice", async () => {
    const { upload } = await setup();
    await fs.writeFile(path.join(project, "README.md"), "mine");
    const first = await upload(TEXT("theirs"), "README.md", {
      kind: "worktree",
      directory: project,
    });
    const destination = {
      kind: "worktree" as const,
      directory: project,
      replaceToken: first.replaceToken!,
    };
    const placed = await upload(TEXT("theirs"), "README.md", destination, { opId: "op-replace" });
    expect(placed.hostPath).toBe(path.join(project, "README.md"));
    // The user keeps editing; then the Shell, which never saw the answer, asks again.
    await fs.writeFile(path.join(project, "README.md"), "newer edits");
    const retried = await upload(TEXT("theirs"), "README.md", destination, { opId: "op-replace" });
    expect(retried).toEqual({ hostPath: placed.hostPath, bytes: 6, deduplicated: false });
    expect(await fs.readFile(path.join(project, "README.md"), "utf8")).toBe("newer edits");
  });

  it("answers a retry of an add without adding it again", async () => {
    const { upload } = await setup();
    const placed = await upload(
      TEXT("spec"),
      "spec.md",
      { kind: "worktree", directory: project },
      {
        opId: "op-add",
      }
    );
    await fs.rm(placed.hostPath);
    const retried = await upload(
      TEXT("spec"),
      "spec.md",
      { kind: "worktree", directory: project },
      {
        opId: "op-add",
      }
    );
    expect(retried.hostPath).toBe(placed.hostPath);
    expect(await fs.readdir(project)).toEqual([]);
  });

  it("refuses the same id for a different upload", async () => {
    const { upload } = await setup();
    await upload(TEXT("one"), "a.txt", undefined, { opId: "op-shared" });
    await expect(
      upload(TEXT("two"), "a.txt", undefined, { opId: "op-shared" })
    ).rejects.toMatchObject({ code: "VALIDATION" });
  });

  it("keeps each Shell's ids apart", async () => {
    const { upload, service, host, transport, client } = await setup();
    const other = new FakeEndpoint("session-1:view-9", "view-9", "client-b");
    service.attach(host, other);
    transport.noteEndpointOpened(HOST, { session: client, webContentsId: 9, endpointId: "view-9" });
    await upload(TEXT("one"), "a.txt", undefined, { opId: "op-same" });
    const second = await upload(TEXT("two"), "b.txt", undefined, {
      opId: "op-same",
      webContentsId: 9,
    });
    expect(path.basename(second.hostPath)).toBe("b.txt");
  });
});

describe("an ancestor folder swapped for a symlink", () => {
  async function prepareDocs() {
    await fs.mkdir(path.join(project, "a", "docs"), { recursive: true });
    await fs.mkdir(path.join(outside, "a", "docs"), { recursive: true });
  }

  async function swapAncestor() {
    await fs.rename(path.join(project, "a"), path.join(project, "a-moved"));
    await fs.symlink(path.join(outside, "a"), path.join(project, "a"));
  }

  it("never opens the destination by path after resolving it", async () => {
    const { upload } = await setup();
    await prepareDocs();
    // The swap lands the instant anything resolves a path during placement:
    // exactly the window between a realpath() and an open by path.
    const realpath = fs.realpath.bind(fs);
    let armed = false;
    const spy = vi.spyOn(fs, "realpath").mockImplementation((async (
      ...args: Parameters<typeof fs.realpath>
    ) => {
      const resolved = await realpath(...args);
      if (armed) {
        armed = false;
        await swapAncestor();
      }
      return resolved;
    }) as typeof fs.realpath);
    try {
      const source = TEXT("spec");
      const originalRead = source.read.bind(source);
      source.read = async (offset, length) => {
        // The bytes are on their way: arm the swap for the placement step.
        armed = true;
        return originalRead(offset, length);
      };
      await upload(source, "spec.md", {
        kind: "worktree",
        directory: path.join(project, "a", "docs"),
      }).catch(() => null);
    } finally {
      spy.mockRestore();
    }
    expect(await fs.readdir(path.join(outside, "a", "docs"))).toEqual([]);
  });

  it("refuses to place into a folder whose ancestor was swapped after the prepare", async () => {
    const { client } = await setup();
    await prepareDocs();
    const source = TEXT("spec");
    const prepared = (await client.call(UploadLinkMethod.PREPARE, {
      endpointId: "view-7",
      name: "spec.md",
      size: source.size,
      sha256: source.sha256,
      opId: "op-swap",
      destination: { kind: "worktree", directory: path.join(project, "a", "docs") },
    })) as { status: string; token: string };
    expect(prepared.status).toBe("ready");
    await swapAncestor();
    await expect(
      client.transfers.send(source, {
        name: "spec.md",
        destination: { kind: "path", path: `${UPLOAD_SINK_PREFIX}${prepared.token}` },
      })
    ).rejects.toBeTruthy();
    expect(await fs.readdir(path.join(outside, "a", "docs"))).toEqual([]);
    expect(await fs.readdir(path.join(project, "a-moved", "docs"))).toEqual([]);
  });

  it("refuses a prepare through a swapped ancestor", async () => {
    const { upload } = await setup();
    await prepareDocs();
    await swapAncestor();
    await expect(
      upload(TEXT("spec"), "spec.md", {
        kind: "worktree",
        directory: path.join(project, "a", "docs"),
      })
    ).rejects.toMatchObject({ code: "OUTSIDE_ROOT" });
    expect(await fs.readdir(path.join(outside, "a", "docs"))).toEqual([]);
  });
});
