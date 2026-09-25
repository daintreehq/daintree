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

function setup(options: { maxUploadBytes?: number; bound?: string | null } = {}) {
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
    transport: { upload },
    hostForView: () => (options.bound === undefined ? "studio-01" : options.bound),
    hostLabel: (hostId) => (hostId === "studio-01" ? "studio-01" : hostId),
    sendToView: (_id, event) => events.push(event),
    localLabel: "This Mac",
    maxUploadBytes: options.maxUploadBytes,
  });
  return { client, upload, events, release: () => release?.() };
}

const inbox = { kind: "inbox", bucket: "files" } as const;

describe("uploading local files", () => {
  it("uploads a local file and reports progress under its operation id", async () => {
    const { client, upload, events } = setup();
    const file = path.join(dir, "invoice.pdf");
    await fs.writeFile(file, "pdf");
    const result = await client.uploadLocalFile(7, {
      hostId: "studio-01",
      localPath: file,
      destination: inbox,
      opId: "op-1",
    });
    expect(result.hostPath).toBe("/tmp/daintree-inbox/files/x/invoice.pdf");
    expect(upload.mock.calls[0]![2]).toMatchObject({ webContentsId: 7, name: "invoice.pdf" });
    expect(events).toContainEqual({
      type: "progress",
      opId: "op-1",
      transferredBytes: 3,
      totalBytes: 3,
    });
  });

  it("refuses a file above the hard cap before sending anything", async () => {
    const { client, upload } = setup({ maxUploadBytes: 2 });
    const file = path.join(dir, "big.bin");
    await fs.writeFile(file, "four");
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
        localPath: path.join(dir, "missing.pdf"),
        destination: inbox,
        opId: "a",
      })
    ).rejects.toMatchObject({ userMessage: "Couldn't read missing.pdf on This Mac." });
    expect(upload).not.toHaveBeenCalled();
  });

  it("refuses folders", async () => {
    const { client } = setup();
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
    await vi.waitFor(() => expect(client.cancel("op-slow")).toBe(true));
    await expect(pending).rejects.toMatchObject({ code: "CANCELLED" });
    expect(client.cancel("op-slow")).toBe(false);
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
