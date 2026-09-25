import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Lane } from "../frames.js";
import { BulkKind, type TransferBeginMessage } from "../messages.js";
import type { LinkSession } from "../session.js";
import {
  TRANSFER_WINDOW_BYTES,
  bytesTransferSource,
  fileTransferSource,
  type TransferProgress,
  type TransferSink,
} from "../transfer.js";
import { makeTempDir, openSessionPair, removeTempDir, waitFor } from "./linkTestUtils.js";

let dir: string;
const sessions: LinkSession[] = [];

beforeEach(async () => {
  dir = await makeTempDir();
});

afterEach(async () => {
  for (const s of sessions.splice(0)) s.close("test done");
  await removeTempDir(dir);
});

async function pair(
  hostOptions: Parameters<typeof openSessionPair>[1] = {},
  clientOptions: Parameters<typeof openSessionPair>[2] = {}
) {
  const p = await openSessionPair(dir, hostOptions, clientOptions);
  sessions.push(p.host, p.client);
  return p;
}

interface MemorySink extends TransferSink {
  begin: TransferBeginMessage;
  chunks: Uint8Array[];
  aborted: string | null;
  committed: boolean;
}

function memorySinks(
  options: { writeDelayMs?: number; onWrite?: (chunk: Uint8Array) => void } = {}
) {
  const sinks: MemorySink[] = [];
  const factory = (begin: TransferBeginMessage): MemorySink => {
    const sink: MemorySink = {
      begin,
      chunks: [],
      aborted: null,
      committed: false,
      async write(chunk) {
        if (options.writeDelayMs) await new Promise((r) => setTimeout(r, options.writeDelayMs));
        options.onWrite?.(chunk);
        sink.chunks.push(chunk);
      },
      async commit() {
        sink.committed = true;
        return `/inbox/${begin.name}`;
      },
      abort(reason) {
        sink.aborted = reason;
      },
    };
    sinks.push(sink);
    return sink;
  };
  return { sinks, factory };
}

function concat(chunks: Uint8Array[]): Buffer {
  return Buffer.concat(chunks.map((c) => Buffer.from(c)));
}

describe("bulk transfer", () => {
  it("moves a multi-MiB payload, verified by sha256, with progress", async () => {
    const { host, client } = await pair();
    const { sinks, factory } = memorySinks();
    host.transfers.setSinkFactory(factory);
    const payload = crypto.randomBytes(5 * 1024 * 1024 + 123);
    const progress: TransferProgress[] = [];
    const result = await client.transfers.send(bytesTransferSource(payload), {
      name: "data.bin",
      destination: { kind: "inbox", bucket: "files" },
      onProgress: (p) => progress.push(p),
    });
    expect(result).toMatchObject({ path: "/inbox/data.bin", bytes: payload.byteLength });
    expect(sinks).toHaveLength(1);
    expect(sinks[0]!.committed).toBe(true);
    expect(concat(sinks[0]!.chunks).equals(payload)).toBe(true);
    expect(sinks[0]!.chunks.every((c) => c.byteLength <= 64 * 1024)).toBe(true);
    expect(progress.length).toBeGreaterThan(1);
    const bytes = progress.map((p) => p.bytes);
    expect([...bytes].sort((a, b) => a - b)).toEqual(bytes);
    expect(bytes.at(-1)).toBe(payload.byteLength);
  });

  it("keeps unacknowledged bytes within the window against a slow receiver", async () => {
    const { host, client } = await pair();
    let received = 0;
    let written = 0;
    let maxOutstanding = 0;
    const { factory } = memorySinks({
      writeDelayMs: 1,
      onWrite: (chunk) => {
        written += chunk.byteLength;
      },
    });
    host.transfers.setSinkFactory(factory);
    const payload = crypto.randomBytes(3 * 1024 * 1024);
    const origHandle = host.transfers.handle.bind(host.transfers);
    host.transfers.handle = (message) => {
      if (message.kind === BulkKind.TRANSFER_CHUNK) {
        received += (message.body as Uint8Array).byteLength;
        maxOutstanding = Math.max(maxOutstanding, received - written);
      }
      origHandle(message);
    };
    await client.transfers.send(bytesTransferSource(payload), {
      name: "slow.bin",
      destination: { kind: "inbox", bucket: "files" },
    });
    expect(maxOutstanding).toBeLessThanOrEqual(TRANSFER_WINDOW_BYTES);
  });

  it("rejects content whose checksum does not match and discards it", async () => {
    const { host, client } = await pair();
    const { sinks, factory } = memorySinks();
    host.transfers.setSinkFactory(factory);
    const source = { ...bytesTransferSource(crypto.randomBytes(300_000)), sha256: "0".repeat(64) };
    await expect(
      client.transfers.send(source, {
        name: "bad.bin",
        destination: { kind: "inbox", bucket: "files" },
      })
    ).rejects.toThrow(/Checksum mismatch/);
    await waitFor(() => sinks[0]?.aborted !== null);
    expect(sinks[0]!.committed).toBe(false);
    expect(host.transfers.activeIncoming).toBe(0);
  });

  it("cancels mid-transfer from the sender and aborts the receiver's sink", async () => {
    const { host, client } = await pair();
    const { sinks, factory } = memorySinks({ writeDelayMs: 2 });
    host.transfers.setSinkFactory(factory);
    const ac = new AbortController();
    const send = client.transfers.send(bytesTransferSource(crypto.randomBytes(4 * 1024 * 1024)), {
      name: "cancel.bin",
      destination: { kind: "inbox", bucket: "files" },
      signal: ac.signal,
      onProgress: () => ac.abort(),
    });
    await expect(send).rejects.toMatchObject({ code: "CANCELLED" });
    await waitFor(() => sinks[0]?.aborted === "cancelled");
    expect(sinks[0]!.committed).toBe(false);
    expect(client.transfers.activeOutgoing).toBe(0);
  });

  it("fails fast when the other side accepts no transfers", async () => {
    const { client } = await pair();
    await expect(
      client.transfers.send(bytesTransferSource(new Uint8Array([1, 2, 3])), {
        name: "x",
        destination: { kind: "inbox", bucket: "clipboard" },
      })
    ).rejects.toThrow(/does not accept transfers/);
  });

  it("reports HOST_DISCONNECTED when the session drops mid-transfer", async () => {
    const { host, client } = await pair();
    const { sinks, factory } = memorySinks({ writeDelayMs: 2 });
    host.transfers.setSinkFactory(factory);
    const send = client.transfers.send(bytesTransferSource(crypto.randomBytes(4 * 1024 * 1024)), {
      name: "drop.bin",
      destination: { kind: "inbox", bucket: "files" },
      onProgress: () => host.close("gone"),
    });
    await expect(send).rejects.toMatchObject({ code: "HOST_DISCONNECTED" });
    await waitFor(() => sinks[0]?.aborted !== null);
  });

  it("sends an empty file and a file from disk", async () => {
    const { host, client } = await pair();
    const { sinks, factory } = memorySinks();
    host.transfers.setSinkFactory(factory);
    await expect(
      client.transfers.send(bytesTransferSource(new Uint8Array()), {
        name: "empty",
        destination: { kind: "inbox", bucket: "files" },
      })
    ).resolves.toMatchObject({ bytes: 0 });

    const file = path.join(dir, "f.bin");
    const content = crypto.randomBytes(200_000);
    await fs.writeFile(file, content);
    const source = await fileTransferSource(file);
    expect(source.sha256).toBe(crypto.createHash("sha256").update(content).digest("hex"));
    await client.transfers.send(source, {
      name: "f.bin",
      destination: { kind: "path", path: "/tmp/f.bin" },
    });
    expect(concat(sinks[1]!.chunks).equals(content)).toBe(true);
  });

  it("treats a second TRANSFER_END as a protocol violation", async () => {
    const { host, client } = await pair();
    host.transfers.setSinkFactory(() => ({
      write() {},
      commit: () => new Promise<string>((r) => setTimeout(() => r("/x"), 50)),
      abort() {},
    }));
    const bytes = new Uint8Array([1, 2, 3]);
    const closed = new Promise<{ reason: string }>((r) => host.onClose(r));
    client.post({
      lane: Lane.BULK,
      kind: BulkKind.TRANSFER_BEGIN,
      body: {
        transferId: 1,
        name: "x",
        size: 3,
        sha256: crypto.createHash("sha256").update(bytes).digest("hex"),
        destination: { kind: "inbox", bucket: "files" },
      },
    });
    client.post({ lane: Lane.BULK, kind: BulkKind.TRANSFER_CHUNK, body: bytes, streamId: 1 });
    client.post({ lane: Lane.BULK, kind: BulkKind.TRANSFER_END, body: { transferId: 1 } });
    client.post({ lane: Lane.BULK, kind: BulkKind.TRANSFER_END, body: { transferId: 1 } });
    expect((await closed).reason).toMatch(/duplicate transfer end/);
  });

  it("rejects a transfer description the receiver would refuse before sending it", async () => {
    const { client } = await pair();
    await expect(
      client.transfers.send(bytesTransferSource(new Uint8Array([1])), {
        name: "",
        destination: { kind: "inbox", bucket: "files" },
      })
    ).rejects.toMatchObject({ code: "VALIDATION" });
    expect(client.isOpen).toBe(true);
  });

  it("runs transfers in both directions at once without mixing them up", async () => {
    const { host, client } = await pair();
    const toHost = memorySinks();
    const toClient = memorySinks();
    host.transfers.setSinkFactory(toHost.factory);
    client.transfers.setSinkFactory(toClient.factory);
    const up = crypto.randomBytes(700_000);
    const down = crypto.randomBytes(900_000);
    await Promise.all([
      client.transfers.send(bytesTransferSource(up), {
        name: "up",
        destination: { kind: "inbox", bucket: "files" },
      }),
      host.transfers.send(bytesTransferSource(down), {
        name: "down",
        destination: { kind: "inbox", bucket: "files" },
      }),
    ]);
    expect(concat(toHost.sinks[0]!.chunks).equals(up)).toBe(true);
    expect(concat(toClient.sinks[0]!.chunks).equals(down)).toBe(true);
  });
  it("settles OUTCOME_UNKNOWN when the link drops after END but before the ack", async () => {
    const { host, client } = await pair();
    let committing = false;
    host.transfers.setSinkFactory(() => ({
      write() {},
      commit: () => {
        committing = true;
        return new Promise<string>(() => {});
      },
      abort() {},
    }));
    const send = client.transfers.send(bytesTransferSource(crypto.randomBytes(1000)), {
      name: "placed.bin",
      destination: { kind: "inbox", bucket: "files" },
    });
    await waitFor(() => committing);
    host.close("gone");
    await expect(send).rejects.toMatchObject({ code: "OUTCOME_UNKNOWN" });
  });

  it("sends a reason code, never the receiver's exception text", async () => {
    const { host, client } = await pair();
    host.transfers.setSinkFactory(() => ({
      write() {
        throw new Error("EACCES: open '/Users/alice/secret/inbox' token=ghp_abcdef123456");
      },
      commit: async () => "/x",
      abort() {},
    }));
    const err = await client.transfers
      .send(bytesTransferSource(crypto.randomBytes(1000)), {
        name: "x.bin",
        destination: { kind: "inbox", bucket: "files" },
      })
      .catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toBe("The receiver could not save the file");
    expect((err as Error).message).not.toMatch(/alice|ghp_/);
  });

  it("aborts the receiver with a reason code when the source fails", async () => {
    const { host, client } = await pair();
    const { sinks, factory } = memorySinks();
    host.transfers.setSinkFactory(factory);
    const source = {
      ...bytesTransferSource(crypto.randomBytes(1000)),
      read: async () => {
        throw new Error("ENOENT: '/Users/alice/private.txt'");
      },
    };
    await expect(
      client.transfers.send(source, {
        name: "gone.bin",
        destination: { kind: "inbox", bucket: "files" },
      })
    ).rejects.toThrow(/private\.txt/);
    await waitFor(() => sinks[0]?.aborted !== null && sinks[0]?.aborted !== undefined);
    expect(sinks[0]!.aborted).toBe("source-failed");
    expect(host.transfers.activeIncoming).toBe(0);
  });

  it("times out a transfer whose sink never finishes a write and frees the slot", async () => {
    const { host, client } = await pair({ transfers: { inactivityTimeoutMs: 100 } });
    let aborted: string | null = null;
    host.transfers.setSinkFactory(() => ({
      write: () => new Promise<void>(() => {}),
      commit: async () => "/x",
      abort(reason) {
        aborted = reason;
      },
    }));
    await expect(
      client.transfers.send(bytesTransferSource(crypto.randomBytes(2 * 1024 * 1024)), {
        name: "stuck.bin",
        destination: { kind: "inbox", bucket: "files" },
      })
    ).rejects.toThrow(/timed out/);
    expect(host.transfers.activeIncoming).toBe(0);
    expect(client.transfers.activeOutgoing).toBe(0);
    await waitFor(() => aborted === "timeout");
  });

  it("times out a commit that never settles on the receiving side", async () => {
    const { host, client } = await pair({ transfers: { commitTimeoutMs: 100 } });
    host.transfers.setSinkFactory(() => ({
      write() {},
      commit: () => new Promise<string>(() => {}),
      abort() {},
    }));
    await expect(
      client.transfers.send(bytesTransferSource(crypto.randomBytes(1000)), {
        name: "slow-commit.bin",
        destination: { kind: "inbox", bucket: "files" },
      })
    ).rejects.toThrow(/timed out/);
    expect(host.transfers.activeIncoming).toBe(0);
  });

  it("reports OUTCOME_UNKNOWN when the sender's commit wait runs out", async () => {
    const { host, client } = await pair({}, { transfers: { commitTimeoutMs: 100 } });
    host.transfers.setSinkFactory(() => ({
      write() {},
      commit: () => new Promise<string>(() => {}),
      abort() {},
    }));
    await expect(
      client.transfers.send(bytesTransferSource(crypto.randomBytes(1000)), {
        name: "unconfirmed.bin",
        destination: { kind: "inbox", bucket: "files" },
      })
    ).rejects.toMatchObject({ code: "OUTCOME_UNKNOWN" });
    expect(client.transfers.activeOutgoing).toBe(0);
  });
});
