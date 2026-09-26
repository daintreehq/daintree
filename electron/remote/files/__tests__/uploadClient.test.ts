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
