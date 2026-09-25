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

const HOST = "studio-01";

class FakeEndpoint implements HostFileEndpoint {
  readonly endpointId = "session-1:view-7";
  readonly clientEndpointId = "view-7";
  readonly clientId = "client-a";
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

async function setup(options: { driving?: () => boolean; freeBytes?: number | null } = {}) {
  const { host, client } = await openSessionPair(socketDir);
  sessions.push(host, client);
  const endpoint = new FakeEndpoint();
  const inbox = new HostInbox({ root: inboxRoot });
  const service = new HostUploadService({
    rootsFor: async (projectId) => (projectId === "p1" ? [project] : []),
    isDriving: () => options.driving?.() ?? true,
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
    extra: { signal?: AbortSignal; onProgress?: (sent: number, total: number) => void } = {}
  ) =>
    transport.upload(HOST, source, {
      webContentsId: 7,
      hostLabel: "studio-01",
      name,
      destination,
      ...extra,
    });
  return { host, client, service, transport, inbox, upload, endpoint };
}

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

    const replaced = await upload(bytesTransferSource(bytes("theirs")), "README.md", {
      kind: "worktree",
      directory: project,
      overwrite: true,
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
      upload(bytesTransferSource(bytes("x")), "dir.txt", {
        kind: "worktree",
        directory: project,
        overwrite: true,
      })
    ).rejects.toMatchObject({ code: "NOT_A_FILE" });
  });
});
