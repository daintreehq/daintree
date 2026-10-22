import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  app: { isPackaged: true, on: vi.fn(), getPath: vi.fn(() => os.tmpdir()) },
  webContents: { fromId: vi.fn(() => null), getAllWebContents: vi.fn(() => []) },
  BrowserWindow: { fromWebContents: vi.fn(() => null), getAllWindows: vi.fn(() => []) },
}));

import type { FileTransferEvent } from "../../../../shared/types/ipc/fileTransfer.js";
import type { TransferSource } from "../../link/transfer.js";
import type { UploadOptions } from "../ClientUploadTransport.js";
import { createHostUploadClient } from "../uploadClient.js";

let dir: string;

beforeEach(async () => {
  dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "upc-")));
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

function setup(
  options: {
    maxUploadBytes?: number;
    bound?: string | null;
    whenReachable?: (hostId: string, webContentsId: number) => Promise<boolean>;
    random?: () => number;
  } = {}
) {
  const events: FileTransferEvent[] = [];
  let release: (() => void) | null = null;
  const upload = vi.fn(async (_hostId: string, source: TransferSource, opts: UploadOptions) => {
    opts.onProgress?.(source.size, source.size);
    if (opts.name === "slow.bin") {
      await new Promise<void>((resolve, reject) => {
        release = resolve;
        opts.signal?.addEventListener("abort", () =>
          reject(Object.assign(new Error("cancelled"), { code: "CANCELLED" }))
        );
      });
    }
    return {
      hostPath: `/tmp/daintree-inbox/files/x/${opts.name}`,
      bytes: source.size,
      deduplicated: false,
    };
  });
  const client = createHostUploadClient({
    transport: options.whenReachable
      ? { upload, whenReachable: vi.fn(options.whenReachable) }
      : { upload },
    hostForView: () => (options.bound === undefined ? "studio-01" : options.bound),
    hostLabel: (hostId) => (hostId === "studio-01" ? "studio-01" : hostId),
    sendToView: (_id, event) => events.push(event),
    localLabel: "This Mac",
    maxUploadBytes: options.maxUploadBytes,
    random: options.random,
  });
  return { client, upload, events, release: () => release?.() };
}

const inbox = { kind: "inbox", bucket: "files" } as const;

/** A local file the person dropped in view 7. */
async function dropped(client: ReturnType<typeof setup>["client"], name: string, content?: string) {
  const file = path.join(dir, name);
  if (content !== undefined) await fs.writeFile(file, content);
  client.grantLocalSources(7, [file]);
  return file;
}

describe("uploading local files", () => {
  it("uploads a local file and reports progress under its operation id", async () => {
    const { client, upload, events } = setup();
    const file = await dropped(client, "invoice.pdf", "pdf");
    const result = await client.uploadLocalFile(7, {
      hostId: "studio-01",
      localPath: file,
      destination: inbox,
      opId: "op-1",
    });
    expect(result.hostPath).toBe("/tmp/daintree-inbox/files/x/invoice.pdf");
    expect(upload.mock.calls[0]![2]).toMatchObject({
      webContentsId: 7,
      opId: "op-1",
      name: "invoice.pdf",
    });
    expect(events).toContainEqual({
      type: "progress",
      opId: "op-1",
      transferredBytes: 3,
      totalBytes: 3,
    });
  });

  it("refuses a file above the hard cap before sending anything", async () => {
    const { client, upload } = setup({ maxUploadBytes: 2 });
    const file = await dropped(client, "big.bin", "four");
    await expect(
      client.uploadLocalFile(7, {
        hostId: "studio-01",
        localPath: file,
        destination: inbox,
        opId: "a",
      })
    ).rejects.toMatchObject({
      code: "PAYLOAD_TOO_LARGE",
      userMessage: "big.bin is too large to send to studio-01.",
    });
    expect(upload).not.toHaveBeenCalled();
  });

  it("names this machine when the local file can't be read", async () => {
    const { client, upload } = setup();
    await expect(
      client.uploadLocalFile(7, {
        hostId: "studio-01",
        localPath: await dropped(client, "missing.pdf"),
        destination: inbox,
        opId: "a",
      })
    ).rejects.toMatchObject({ userMessage: "Couldn't read missing.pdf on This Mac." });
    expect(upload).not.toHaveBeenCalled();
  });

  it("refuses folders", async () => {
    const { client } = setup();
    client.grantLocalSources(7, [dir]);
    await expect(
      client.uploadLocalFile(7, {
        hostId: "studio-01",
        localPath: dir,
        destination: inbox,
        opId: "a",
      })
    ).rejects.toMatchObject({ code: "UNSUPPORTED" });
  });

  it("refuses an upload to a host the view isn't attached to, naming both", async () => {
    const { client } = setup({ bound: "studio-02" });
    const file = path.join(dir, "a.txt");
    await fs.writeFile(file, "x");
    await expect(
      client.uploadLocalFile(7, {
        hostId: "studio-01",
        localPath: file,
        destination: inbox,
        opId: "a",
      })
    ).rejects.toMatchObject({ userMessage: "This window is on studio-02, not studio-01." });
  });

  it("cancels by operation id", async () => {
    const { client } = setup();
    const pending = client.uploadBytes(7, {
      hostId: "studio-01",
      bytes: new Uint8Array([1, 2]),
      name: "slow.bin",
      mimeType: null,
      destination: inbox,
      opId: "op-slow",
    });
    await vi.waitFor(() => expect(client.cancel("op-slow", 7)).toBe(true));
    await expect(pending).rejects.toMatchObject({ code: "CANCELLED" });
    expect(client.cancel("op-slow", 7)).toBe(false);
  });

  it("runs a pasted image under the window's operation id: progress follows it and cancel stops it", async () => {
    const { client, upload, events } = setup();
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
    await expect(client.uploadClipboardImage(7, "studio-01", png, "op-paste")).resolves.toBe(
      "/tmp/daintree-inbox/files/x/clipboard.png"
    );
    expect(upload.mock.calls[0]![2]).toMatchObject({
      opId: "op-paste",
      destination: { kind: "inbox", bucket: "clipboard" },
    });
    expect(events).toEqual([
      { type: "progress", opId: "op-paste", transferredBytes: 4, totalBytes: 4 },
    ]);
    expect(client.cancel("op-paste", 7)).toBe(false);
  });

  it("starts an upload cancelled when its view's cancel overtook it", async () => {
    const { client, upload } = setup();
    expect(client.cancel("op-early", 7)).toBe(false);
    await expect(
      client.uploadBytes(7, {
        hostId: "studio-01",
        bytes: new Uint8Array([1]),
        name: "a.bin",
        mimeType: null,
        destination: inbox,
        opId: "op-early",
      })
    ).rejects.toMatchObject({ code: "CANCELLED" });
    expect(upload).not.toHaveBeenCalled();

    // Another view's cancel for the id never stops this view's upload.
    expect(client.cancel("op-other", 8)).toBe(false);
    await expect(
      client.uploadBytes(7, {
        hostId: "studio-01",
        bytes: new Uint8Array([1]),
        name: "b.bin",
        mimeType: null,
        destination: inbox,
        opId: "op-other",
      })
    ).resolves.toMatchObject({ hostPath: "/tmp/daintree-inbox/files/x/b.bin" });
  });

  it("validates the destination", async () => {
    const { client } = setup();
    await expect(
      client.uploadBytes(7, {
        hostId: "studio-01",
        bytes: new Uint8Array([1]),
        name: "a",
        mimeType: null,
        destination: { kind: "worktree", directory: "relative/dir" },
        opId: "a",
      })
    ).rejects.toMatchObject({ code: "VALIDATION" });
  });
});

describe("local files a view may send", () => {
  it("refuses a local path nobody dropped, pasted or attached in that view", async () => {
    const { client, upload } = setup();
    const secret = path.join(dir, "id_ed25519");
    await fs.writeFile(secret, "private key");
    await expect(
      client.uploadLocalFile(7, {
        hostId: "studio-01",
        localPath: secret,
        destination: inbox,
        opId: "a",
      })
    ).rejects.toMatchObject({ code: "PERMISSION" });
    await expect(client.statLocalSource(7, secret)).rejects.toMatchObject({ code: "PERMISSION" });
    expect(upload).not.toHaveBeenCalled();
  });

  it("keeps each view's choices to itself", async () => {
    const { client, upload } = setup();
    const file = path.join(dir, "notes.txt");
    await fs.writeFile(file, "notes");
    client.grantLocalSources(8, [file]);
    await expect(
      client.uploadLocalFile(7, {
        hostId: "studio-01",
        localPath: file,
        destination: inbox,
        opId: "a",
      })
    ).rejects.toMatchObject({ code: "PERMISSION" });
    await expect(client.statLocalSource(8, file)).resolves.toEqual({ size: 5, isDirectory: false });
    expect(upload).not.toHaveBeenCalled();
  });

  it("records nothing for a view that isn't attached to a host", async () => {
    const { client } = setup({ bound: null });
    const file = path.join(dir, "notes.txt");
    await fs.writeFile(file, "notes");
    client.grantLocalSources(7, [file]);
    await expect(client.statLocalSource(7, file)).rejects.toMatchObject({ code: "PERMISSION" });
  });

  it("ignores anything but absolute paths", async () => {
    const { client } = setup();
    client.grantLocalSources(7, ["relative.txt", 42, null]);
    client.grantLocalSources(7, "not-a-list");
    await expect(client.statLocalSource(7, "relative.txt")).rejects.toMatchObject({
      code: "VALIDATION",
    });
  });

  it("lets a grant lapse", async () => {
    const { client } = setup();
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const file = await dropped(client, "old.txt", "x");
      vi.setSystemTime(Date.now() + 31 * 60_000);
      await expect(client.statLocalSource(7, file)).rejects.toMatchObject({ code: "PERMISSION" });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("operation ids", () => {
  const slow = (opId: string, name = "slow.bin") => ({
    hostId: "studio-01",
    bytes: new Uint8Array([1, 2]),
    name,
    mimeType: null,
    destination: inbox,
    opId,
  });

  it("refuses a second view's upload under the same id, and its cancel", async () => {
    const { client, upload, release } = setup();
    const mine = client.uploadBytes(7, slow("op-shared"));
    await vi.waitFor(() => expect(upload).toHaveBeenCalledTimes(1));
    await expect(client.uploadBytes(8, slow("op-shared"))).rejects.toMatchObject({
      code: "VALIDATION",
    });
    expect(client.cancel("op-shared", 8)).toBe(false);
    release();
    await expect(mine).resolves.toMatchObject({ hostPath: "/tmp/daintree-inbox/files/x/slow.bin" });
    expect(upload).toHaveBeenCalledTimes(1);
  });

  it("refuses the same id for a different file from the same view", async () => {
    const { client, release } = setup();
    const first = client.uploadBytes(7, slow("op-1"));
    await expect(client.uploadBytes(7, slow("op-1", "other.bin"))).rejects.toMatchObject({
      code: "VALIDATION",
    });
    release();
    await first;
  });

  it("refuses the same id for different bytes of the same length", async () => {
    const { client, release } = setup();
    const first = client.uploadBytes(7, slow("op-1"));
    await expect(
      client.uploadBytes(7, { ...slow("op-1"), bytes: new Uint8Array([9, 9]) })
    ).rejects.toMatchObject({ code: "VALIDATION" });
    release();
    await first;
  });

  it("shares the running upload when the same view repeats itself", async () => {
    const { client, upload, release } = setup();
    const first = client.uploadBytes(7, slow("op-1"));
    const second = client.uploadBytes(7, slow("op-1"));
    await vi.waitFor(() => expect(upload).toHaveBeenCalledTimes(1));
    release();
    expect(await second).toEqual(await first);
    expect(upload).toHaveBeenCalledTimes(1);
  });

  it("asks the host again under the same id when the answer was lost", async () => {
    const whenReachable = vi.fn(async () => true);
    const { client, upload } = setup({ whenReachable });
    upload.mockImplementationOnce(async () => {
      throw Object.assign(new Error("lost"), { code: "OUTCOME_UNKNOWN" });
    });
    const result = await client.uploadBytes(7, {
      hostId: "studio-01",
      bytes: new Uint8Array([1]),
      name: "a.bin",
      mimeType: null,
      destination: inbox,
      opId: "op-lost",
    });
    expect(result.hostPath).toBe("/tmp/daintree-inbox/files/x/a.bin");
    expect(upload).toHaveBeenCalledTimes(2);
    expect(upload.mock.calls.map(([, , opts]) => opts.opId)).toEqual(["op-lost", "op-lost"]);
  });

  it("reports the unknown outcome when the host doesn't come back", async () => {
    const { client, upload } = setup({ whenReachable: async () => false });
    upload.mockImplementationOnce(async () => {
      throw Object.assign(new Error("lost"), { code: "OUTCOME_UNKNOWN" });
    });
    await expect(
      client.uploadBytes(7, {
        hostId: "studio-01",
        bytes: new Uint8Array([1]),
        name: "a.bin",
        mimeType: null,
        destination: inbox,
        opId: "op-lost",
      })
    ).rejects.toMatchObject({ code: "OUTCOME_UNKNOWN" });
    expect(upload).toHaveBeenCalledTimes(1);
  });
});

describe("a busy or dropped host", () => {
  const send = (client: ReturnType<typeof setup>["client"], opId: string, name = `${opId}.bin`) =>
    client.uploadBytes(7, {
      hostId: "studio-01",
      bytes: new Uint8Array([1]),
      name,
      mimeType: null,
      destination: inbox,
      opId,
    });
  const failWith = (code: string) => async () => {
    throw Object.assign(new Error(code), { code });
  };

  /** Uploads that run until the test lets each one finish. */
  function heldUploads(upload: ReturnType<typeof setup>["upload"]) {
    const releases = new Map<string, () => void>();
    upload.mockImplementation(async (_hostId, source, opts) => {
      await new Promise<void>((resolve, reject) => {
        releases.set(opts.opId, resolve);
        opts.signal?.addEventListener("abort", () =>
          reject(Object.assign(new Error("cancelled"), { code: "CANCELLED" }))
        );
      });
      return { hostPath: `/tmp/${opts.name}`, bytes: source.size, deduplicated: false };
    });
    return {
      running: () => upload.mock.calls.map(([, , opts]) => opts.opId),
      finish: (opId: string) => releases.get(opId)?.(),
    };
  }

  it("sends a big drop a few at a time, starting each as another finishes", async () => {
    const { client, upload } = setup();
    const held = heldUploads(upload);
    const drop = Array.from({ length: 20 }, (_, index) => send(client, `op-${index}`));
    await vi.waitFor(() => expect(upload).toHaveBeenCalled());
    await new Promise((resolve) => setTimeout(resolve, 10));
    const started = held.running();
    expect(started.length).toBeGreaterThan(0);
    expect(started.length).toBeLessThan(8);

    held.finish(started[0]!);
    await vi.waitFor(() => expect(held.running()).toHaveLength(started.length + 1));
    for (let index = 0; index < 20; index++) {
      await vi.waitFor(() => expect(held.running()).toContain(`op-${index}`));
      held.finish(`op-${index}`);
    }
    const results = await Promise.all(drop);
    expect(results.map((result) => result.hostPath)).toEqual(
      Array.from({ length: 20 }, (_, index) => `/tmp/op-${index}.bin`)
    );
  });

  it("drops a queued upload that is cancelled before its turn, and its slot stays free", async () => {
    const { client, upload } = setup();
    const held = heldUploads(upload);
    const ahead = Array.from({ length: 20 }, (_, index) => send(client, `op-${index}`));
    await vi.waitFor(() => expect(upload).toHaveBeenCalled());
    const queued = send(client, "op-queued");
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(client.cancel("op-queued", 7)).toBe(true);
    await expect(queued).rejects.toMatchObject({ code: "CANCELLED" });

    for (let index = 0; index < 20; index++) {
      await vi.waitFor(() => expect(held.running()).toContain(`op-${index}`));
      held.finish(`op-${index}`);
    }
    await Promise.all(ahead);
    expect(held.running()).not.toContain("op-queued");
    const after = send(client, "op-after");
    await vi.waitFor(() => expect(held.running()).toContain("op-after"));
    held.finish("op-after");
    await expect(after).resolves.toMatchObject({ hostPath: "/tmp/op-after.bin" });
  });

  it("queues each host separately", async () => {
    const { upload } = setup();
    const held = heldUploads(upload);
    const hostFor = new Map<number, string>([
      [7, "studio-01"],
      [8, "studio-02"],
    ]);
    const multi = createHostUploadClient({
      transport: { upload },
      hostForView: (id) => hostFor.get(id) ?? null,
      hostLabel: (hostId) => hostId,
      sendToView: () => {},
      localLabel: "This Mac",
    });
    const toHost = (webContentsId: number, opId: string) =>
      multi.uploadBytes(webContentsId, {
        hostId: hostFor.get(webContentsId)!,
        bytes: new Uint8Array([1]),
        name: `${opId}.bin`,
        mimeType: null,
        destination: inbox,
        opId,
      });
    const first = Array.from({ length: 20 }, (_, index) => toHost(7, `a-${index}`));
    await vi.waitFor(() => expect(upload).toHaveBeenCalled());
    const second = toHost(8, "b-0");
    await vi.waitFor(() => expect(held.running()).toContain("b-0"));
    held.finish("b-0");
    await second;
    for (let index = 0; index < 20; index++) {
      await vi.waitFor(() => expect(held.running()).toContain(`a-${index}`));
      held.finish(`a-${index}`);
    }
    await Promise.all(first);
  });

  const bytesFor = (opId: string) => ({
    hostId: "studio-01",
    bytes: new Uint8Array([1]),
    name: `${opId}.bin`,
    mimeType: null,
    destination: inbox,
    opId,
  });

  it("stops a destroyed view's uploads, queued or running, and frees their slots", async () => {
    const { upload } = setup();
    const held = heldUploads(upload);
    const watchers = new Set<{ webContentsId: number; onGone: () => void }>();
    const uploads = createHostUploadClient({
      transport: { upload },
      hostForView: () => "studio-01",
      hostLabel: (hostId) => hostId,
      sendToView: () => {},
      localLabel: "This Mac",
      watchView: (webContentsId, onGone) => {
        const entry = { webContentsId, onGone };
        watchers.add(entry);
        return () => watchers.delete(entry);
      },
    });
    const drop = Array.from({ length: 20 }, (_, index) =>
      uploads.uploadBytes(7, bytesFor(`op-${index}`))
    );
    await vi.waitFor(() => expect(upload).toHaveBeenCalled());
    const other = uploads.uploadBytes(8, bytesFor("op-other"));
    for (const entry of [...watchers]) if (entry.webContentsId === 7) entry.onGone();

    const settled = await Promise.allSettled(drop);
    expect(settled.every((result) => result.status === "rejected")).toBe(true);
    await vi.waitFor(() => expect(held.running()).toContain("op-other"));
    held.finish("op-other");
    await expect(other).resolves.toMatchObject({ hostPath: "/tmp/op-other.bin" });
    expect(watchers.size).toBe(0);
  });

  it("drops a queued upload whose view left the host while it waited", async () => {
    const { upload } = setup();
    const held = heldUploads(upload);
    let bound: string | null = "studio-01";
    const uploads = createHostUploadClient({
      transport: { upload },
      hostForView: (webContentsId) => (webContentsId === 7 ? bound : "studio-01"),
      hostLabel: (hostId) => hostId,
      sendToView: () => {},
      localLabel: "This Mac",
      maxConcurrentPerHost: 1,
    });
    const ahead = uploads.uploadBytes(8, bytesFor("op-ahead"));
    await vi.waitFor(() => expect(held.running()).toContain("op-ahead"));
    const queued = uploads.uploadBytes(7, bytesFor("op-queued"));
    bound = null;
    held.finish("op-ahead");
    await ahead;
    await expect(queued).rejects.toMatchObject({ code: "VALIDATION" });
    expect(held.running()).not.toContain("op-queued");
  });

  it("asks a busy host again under the same id until it takes the file", async () => {
    const { client, upload } = setup({ random: () => 0 });
    upload
      .mockImplementationOnce(failWith("RATE_LIMITED"))
      .mockImplementationOnce(failWith("RATE_LIMITED"));
    await expect(send(client, "op-busy")).resolves.toMatchObject({
      hostPath: "/tmp/daintree-inbox/files/x/op-busy.bin",
    });
    expect(upload.mock.calls.map(([, , opts]) => opts.opId)).toEqual([
      "op-busy",
      "op-busy",
      "op-busy",
    ]);
  });

  it("reports the host busy when it never frees up", async () => {
    const { client, upload } = setup({ random: () => 0 });
    upload.mockImplementation(failWith("RATE_LIMITED"));
    await expect(send(client, "op-busy")).rejects.toMatchObject({ code: "RATE_LIMITED" });
    expect(upload.mock.calls.length).toBeGreaterThan(1);
    const calls = upload.mock.calls.length;
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(upload).toHaveBeenCalledTimes(calls);
  });

  it("stops waiting on a busy host when the upload is cancelled", async () => {
    const { client, upload } = setup({ random: () => 0.99 });
    upload.mockImplementation(failWith("RATE_LIMITED"));
    const pending = send(client, "op-busy");
    await vi.waitFor(() => expect(upload).toHaveBeenCalledTimes(1));
    expect(client.cancel("op-busy", 7)).toBe(true);
    await expect(pending).rejects.toBeTruthy();
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(upload).toHaveBeenCalledTimes(1);
  });

  it("resumes an upload its link cut off once the host is back, under the same id", async () => {
    const whenReachable = vi.fn(async () => true);
    const { client, upload } = setup({ whenReachable });
    upload.mockImplementationOnce(failWith("HOST_DISCONNECTED"));
    await expect(send(client, "op-cut")).resolves.toMatchObject({
      hostPath: "/tmp/daintree-inbox/files/x/op-cut.bin",
    });
    expect(whenReachable).toHaveBeenCalledWith(
      "studio-01",
      7,
      expect.any(Number),
      expect.any(AbortSignal)
    );
    expect(upload.mock.calls.map(([, , opts]) => opts.opId)).toEqual(["op-cut", "op-cut"]);
  });

  it("reports the disconnect when the host doesn't come back", async () => {
    const { client, upload } = setup({ whenReachable: async () => false });
    upload.mockImplementation(failWith("HOST_DISCONNECTED"));
    await expect(send(client, "op-cut")).rejects.toMatchObject({ code: "HOST_DISCONNECTED" });
    expect(upload).toHaveBeenCalledTimes(1);
  });

  it("gives up on a link that keeps dropping", async () => {
    const { client, upload } = setup({ whenReachable: async () => true });
    upload.mockImplementation(failWith("HOST_DISCONNECTED"));
    await expect(send(client, "op-cut")).rejects.toMatchObject({ code: "HOST_DISCONNECTED" });
    expect(upload.mock.calls.length).toBeGreaterThan(1);
    const calls = upload.mock.calls.length;
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(upload).toHaveBeenCalledTimes(calls);
  });
});
