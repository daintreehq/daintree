import crypto from "node:crypto";
import fs from "node:fs/promises";
import { AppError } from "../../utils/errorTypes.js";
import { formatErrorMessage } from "../../../shared/utils/errorMessage.js";
import { BULK_CHUNK_BYTES, Lane } from "./frames.js";
import {
  BulkKind,
  type LinkMessage,
  type TransferAbortMessage,
  type TransferAckMessage,
  type TransferBeginMessage,
} from "./messages.js";
import type { EnqueueResult } from "./scheduler.js";
import { TransferBeginSchema } from "./schemas.js";

/**
 * Verified bulk transfer over the BULK lane.
 *
 * The sender announces size and sha256 in TRANSFER_BEGIN, streams chunks of at
 * most {@link BULK_CHUNK_BYTES}, and finishes with TRANSFER_END. Flow is
 * credit-based: the receiver's TRANSFER_ACK reports bytes it has handed to its
 * sink, and the sender never has more than {@link TRANSFER_WINDOW_BYTES}
 * unacknowledged, so a slow disk on the far side throttles the sender instead
 * of filling memory. The receiver hashes as it goes and only commits (moves
 * into place) when the digest matches; where the bytes land is decided by the
 * injected sink. A final ACK carries the placed path or the error.
 *
 * Transfer ids are per sender. Clients use odd ids and hosts even ids so an
 * ABORT, which either side may send, always names one transfer unambiguously.
 */

export const TRANSFER_WINDOW_BYTES = 16 * BULK_CHUNK_BYTES;
const ACK_EVERY_BYTES = 4 * BULK_CHUNK_BYTES;
const DEFAULT_MAX_INCOMING = 8;
const DEFAULT_MAX_INCOMING_BYTES = 4 * 1024 * 1024 * 1024;
const MAX_RETRY_QUEUE = 4096;

export interface TransferSource {
  size: number;
  /** Lowercase hex sha256 of the whole content. */
  sha256: string;
  read(offset: number, length: number): Promise<Uint8Array>;
  close?(): Promise<void> | void;
}

/** Receiver-side placement. Phases that own destinations implement this. */
export interface TransferSink {
  write(chunk: Uint8Array): Promise<void> | void;
  /** Called once the content is verified; returns the path the file now has. */
  commit(): Promise<string>;
  abort(reason: string): Promise<void> | void;
}

export type TransferSinkFactory = (
  begin: TransferBeginMessage
) => Promise<TransferSink> | TransferSink;

export interface TransferProgress {
  transferId: number;
  /** Bytes the receiver has confirmed. */
  bytes: number;
  totalBytes: number;
}

export interface SendTransferOptions {
  name: string;
  destination: TransferBeginMessage["destination"];
  onProgress?: (progress: TransferProgress) => void;
  signal?: AbortSignal;
}

export interface TransferResult {
  transferId: number;
  path: string;
  bytes: number;
}

export interface LinkTransfersOptions {
  maxIncoming?: number;
  maxIncomingBytes?: number;
  onIncomingProgress?: (begin: TransferBeginMessage, bytes: number) => void;
}

/** What the transfer layer needs from its session. */
export interface TransferLink {
  role: "host" | "client";
  post(message: LinkMessage): EnqueueResult;
  isOpen(): boolean;
  protocolError(reason: string): void;
}

export function sha256Hex(bytes: Uint8Array): string {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

export function bytesTransferSource(bytes: Uint8Array): TransferSource {
  return {
    size: bytes.byteLength,
    sha256: sha256Hex(bytes),
    read: async (offset, length) => bytes.subarray(offset, offset + length),
  };
}

/** Hash the file up front, then serve reads from one open handle. */
export async function fileTransferSource(filePath: string): Promise<TransferSource> {
  const handle = await fs.open(filePath, "r");
  try {
    const { size } = await handle.stat();
    const hash = crypto.createHash("sha256");
    const buf = Buffer.allocUnsafe(BULK_CHUNK_BYTES);
    for (let offset = 0; offset < size;) {
      const { bytesRead } = await handle.read(buf, 0, buf.byteLength, offset);
      if (bytesRead === 0) break;
      hash.update(buf.subarray(0, bytesRead));
      offset += bytesRead;
    }
    return {
      size,
      sha256: hash.digest("hex"),
      read: async (offset, length) => {
        const out = Buffer.alloc(length);
        let got = 0;
        while (got < length) {
          const { bytesRead } = await handle.read(out, got, length - got, offset + got);
          if (bytesRead === 0) break;
          got += bytesRead;
        }
        return out.subarray(0, got);
      },
      close: () => handle.close(),
    };
  } catch (err) {
    await handle.close().catch(() => {});
    throw err;
  }
}

interface Outgoing {
  id: number;
  source: TransferSource;
  begin: TransferBeginMessage;
  phase: "begin" | "data" | "end" | "wait";
  sent: number;
  acked: number;
  stash: Uint8Array | null;
  onProgress?: (progress: TransferProgress) => void;
  resolve: (result: TransferResult) => void;
  reject: (err: Error) => void;
}

interface Incoming {
  begin: TransferBeginMessage;
  hash: crypto.Hash;
  received: number;
  written: number;
  ackedTo: number;
  sink: Promise<TransferSink>;
  chain: Promise<void>;
  failed: boolean;
  ended: boolean;
  /** Once the sink is placing the file, the outcome belongs to the commit; aborts are ignored. */
  committing: boolean;
}

const MAX_REASON_LENGTH = 1024;

function clip(reason: string): string {
  return reason.length > MAX_REASON_LENGTH ? reason.slice(0, MAX_REASON_LENGTH) : reason;
}

function transferError(
  code: "CANCELLED" | "HOST_DISCONNECTED" | "INTERNAL" | "OUTCOME_UNKNOWN" | "VALIDATION",
  message: string
) {
  return new AppError({ code, message });
}

export class LinkTransfers {
  private readonly outgoing = new Map<number, Outgoing>();
  private readonly incoming = new Map<number, Incoming>();
  private readonly retry: LinkMessage[] = [];
  private sinkFactory: TransferSinkFactory | null = null;
  private nextId: number;
  private bulkPaused = false;
  private pumping = false;
  private pumpAgain = false;
  private closed = false;

  constructor(
    private readonly link: TransferLink,
    private readonly options: LinkTransfersOptions = {}
  ) {
    this.nextId = link.role === "client" ? 1 : 2;
  }

  setSinkFactory(factory: TransferSinkFactory | null): void {
    this.sinkFactory = factory;
  }

  get activeOutgoing(): number {
    return this.outgoing.size;
  }

  get activeIncoming(): number {
    return this.incoming.size;
  }

  send(source: TransferSource, options: SendTransferOptions): Promise<TransferResult> {
    if (this.closed || !this.link.isOpen()) {
      return Promise.reject(transferError("HOST_DISCONNECTED", "Link is not open"));
    }
    if (options.signal?.aborted) {
      return Promise.reject(transferError("CANCELLED", "Transfer cancelled"));
    }
    const id = this.allocateId();
    const begin: TransferBeginMessage = {
      transferId: id,
      name: options.name,
      size: source.size,
      sha256: source.sha256,
      destination: options.destination,
    };
    // A BEGIN the receiver would reject as malformed would end the whole session.
    if (!TransferBeginSchema.safeParse(begin).success) {
      return Promise.reject(transferError("VALIDATION", "Invalid transfer description"));
    }
    return new Promise<TransferResult>((resolve, reject) => {
      const onAbort = () => {
        const t = this.outgoing.get(id);
        if (!t) return;
        this.postControl({
          lane: Lane.BULK,
          kind: BulkKind.TRANSFER_ABORT,
          body: { transferId: id, reason: "cancelled" },
        });
        // After END the receiver may already be placing the file.
        this.finishOutgoing(
          id,
          t.phase === "wait"
            ? transferError(
                "OUTCOME_UNKNOWN",
                "Transfer cancelled after all data was sent; the file may have been saved"
              )
            : transferError("CANCELLED", "Transfer cancelled")
        );
      };
      const cleanup = () => options.signal?.removeEventListener("abort", onAbort);
      this.outgoing.set(id, {
        id,
        source,
        begin,
        phase: "begin",
        sent: 0,
        acked: 0,
        stash: null,
        onProgress: options.onProgress,
        resolve: (result) => {
          cleanup();
          resolve(result);
        },
        reject: (err) => {
          cleanup();
          reject(err);
        },
      });
      options.signal?.addEventListener("abort", onAbort, { once: true });
      this.schedulePump();
    });
  }

  /** Session hook: a BULK message from the peer (already schema-validated). */
  handle(message: LinkMessage): void {
    if (this.closed || message.lane !== Lane.BULK) return;
    switch (message.kind) {
      case BulkKind.TRANSFER_BEGIN:
        this.onBegin(message.body);
        return;
      case BulkKind.TRANSFER_CHUNK:
        this.onChunk(message.streamId, message.body);
        return;
      case BulkKind.TRANSFER_END:
        this.onEnd(message.body.transferId);
        return;
      case BulkKind.TRANSFER_ABORT:
        this.onAbort(message.body);
        return;
      case BulkKind.TRANSFER_ACK:
        this.onAck(message.body);
        return;
    }
  }

  /** Session hook: a write pass finished; refused frames can be retried. */
  onWritable(): void {
    if (this.retry.length > 0 || this.outgoing.size > 0) this.schedulePump();
  }

  /** Session hook: the BULK lane fell back below half its high-water mark. */
  onBulkDrain(): void {
    this.bulkPaused = false;
    this.schedulePump();
  }

  /** Session hook: the session ended. */
  closeAll(reason: string): void {
    if (this.closed) return;
    this.closed = true;
    this.retry.length = 0;
    for (const id of [...this.outgoing.keys()]) {
      this.finishOutgoing(id, transferError("HOST_DISCONNECTED", `Link closed: ${reason}`));
    }
    for (const [id, t] of [...this.incoming]) {
      this.incoming.delete(id);
      if (t.committing) continue;
      t.failed = true;
      void t.sink.then((sink) => sink.abort(reason)).catch(() => {});
    }
  }

  private allocateId(): number {
    for (;;) {
      const id = this.nextId;
      this.nextId = id + 2 > 0xffffffff ? (this.link.role === "client" ? 1 : 2) : id + 2;
      if (!this.outgoing.has(id)) return id;
    }
  }

  private isOwnId(id: number): boolean {
    return (id % 2 === 1) === (this.link.role === "client");
  }

  private postControl(message: LinkMessage): void {
    if (this.closed) return;
    if (this.retry.length === 0) {
      let result: EnqueueResult;
      try {
        result = this.link.post(message);
      } catch {
        // Unsendable (should not happen with clipped reasons); drop rather than wedge.
        return;
      }
      if (result !== "refused") return;
    }
    if (this.retry.length >= MAX_RETRY_QUEUE) {
      this.link.protocolError("transfer control backlog");
      return;
    }
    this.retry.push(message);
    this.schedulePump();
  }

  private flushRetry(): boolean {
    while (this.retry.length > 0) {
      if (this.link.post(this.retry[0]!) === "refused") return false;
      this.retry.shift();
    }
    return true;
  }

  private schedulePump(): void {
    if (this.pumping) {
      this.pumpAgain = true;
      return;
    }
    void this.pump();
  }

  private async pump(): Promise<void> {
    this.pumping = true;
    try {
      do {
        this.pumpAgain = false;
        if (this.closed || !this.link.isOpen()) return;
        if (!this.flushRetry()) return;
        for (const t of [...this.outgoing.values()]) {
          try {
            await this.pumpOne(t);
          } catch (err) {
            if (this.active(t)) this.failOutgoing(t, formatErrorMessage(err, "Could not send"));
          }
          if (this.closed) return;
        }
      } while (this.pumpAgain);
    } finally {
      this.pumping = false;
    }
  }

  private active(t: Outgoing): boolean {
    return this.outgoing.get(t.id) === t;
  }

  private async pumpOne(t: Outgoing): Promise<void> {
    if (t.phase === "begin") {
      if (
        this.link.post({ lane: Lane.BULK, kind: BulkKind.TRANSFER_BEGIN, body: t.begin }) ===
        "refused"
      ) {
        return;
      }
      t.phase = "data";
    }
    const size = t.source.size;
    while (t.phase === "data" && t.sent < size && !this.bulkPaused) {
      const length = Math.min(BULK_CHUNK_BYTES, size - t.sent);
      if (t.sent + length - t.acked > TRANSFER_WINDOW_BYTES) return;
      let chunk = t.stash;
      if (!chunk) {
        try {
          chunk = await t.source.read(t.sent, length);
        } catch (err) {
          this.failOutgoing(t, formatErrorMessage(err, "Could not read the file"));
          return;
        }
        if (!this.active(t)) return;
        if (chunk.byteLength !== length) {
          this.failOutgoing(t, "The file changed while it was being sent");
          return;
        }
      }
      const result = this.link.post({
        lane: Lane.BULK,
        kind: BulkKind.TRANSFER_CHUNK,
        body: chunk,
        streamId: t.id,
      });
      if (result === "refused") {
        t.stash = chunk;
        return;
      }
      t.stash = null;
      t.sent += length;
      if (result === "over-high-water") this.bulkPaused = true;
    }
    if (t.phase === "data" && t.sent === size) {
      const result = this.link.post({
        lane: Lane.BULK,
        kind: BulkKind.TRANSFER_END,
        body: { transferId: t.id },
      });
      if (result === "refused") return;
      t.phase = "wait";
    }
  }

  private failOutgoing(t: Outgoing, reason: string): void {
    this.finishOutgoing(t.id, transferError("INTERNAL", reason));
    this.postControl({
      lane: Lane.BULK,
      kind: BulkKind.TRANSFER_ABORT,
      body: { transferId: t.id, reason: clip(reason) },
    });
  }

  private finishOutgoing(id: number, outcome: Error | TransferResult): void {
    const t = this.outgoing.get(id);
    if (!t) return;
    this.outgoing.delete(id);
    void Promise.resolve(t.source.close?.()).catch(() => {});
    if (outcome instanceof Error) t.reject(outcome);
    else t.resolve(outcome);
  }

  private onAck(ack: TransferAckMessage): void {
    const t = this.outgoing.get(ack.transferId);
    if (!t) return;
    if (ack.error !== null) {
      this.finishOutgoing(t.id, transferError("INTERNAL", `Receiver failed: ${ack.error}`));
      return;
    }
    if (ack.receivedBytes > t.sent) {
      this.link.protocolError("transfer ack beyond sent bytes");
      return;
    }
    if (ack.receivedBytes > t.acked) {
      t.acked = ack.receivedBytes;
      try {
        t.onProgress?.({ transferId: t.id, bytes: t.acked, totalBytes: t.source.size });
      } catch {
        // Progress is advisory.
      }
    }
    if (ack.path !== null) {
      if (t.phase !== "wait" || t.acked !== t.source.size) {
        this.link.protocolError("transfer completed before all bytes arrived");
        return;
      }
      this.finishOutgoing(t.id, { transferId: t.id, path: ack.path, bytes: t.source.size });
      return;
    }
    this.schedulePump();
  }

  private onAbort(abort: TransferAbortMessage): void {
    if (this.isOwnId(abort.transferId)) {
      this.finishOutgoing(
        abort.transferId,
        transferError("INTERNAL", `Receiver aborted: ${abort.reason}`)
      );
      return;
    }
    const t = this.incoming.get(abort.transferId);
    if (t && !t.committing) this.failIncoming(abort.transferId, t, abort.reason, false);
  }

  private onBegin(begin: TransferBeginMessage): void {
    const id = begin.transferId;
    if (this.isOwnId(id) || this.incoming.has(id)) {
      this.link.protocolError("bad transfer id");
      return;
    }
    const refuse = (reason: string) =>
      this.postControl({
        lane: Lane.BULK,
        kind: BulkKind.TRANSFER_ACK,
        body: { transferId: id, receivedBytes: 0, path: null, error: clip(reason) },
      });
    const factory = this.sinkFactory;
    if (!factory) return refuse("This side does not accept transfers");
    if (this.incoming.size >= (this.options.maxIncoming ?? DEFAULT_MAX_INCOMING)) {
      return refuse("Too many transfers in progress");
    }
    if (begin.size > (this.options.maxIncomingBytes ?? DEFAULT_MAX_INCOMING_BYTES)) {
      return refuse("Transfer is too large");
    }
    const sink = Promise.resolve().then(() => factory(begin));
    const t: Incoming = {
      begin,
      hash: crypto.createHash("sha256"),
      received: 0,
      written: 0,
      ackedTo: 0,
      sink,
      chain: sink.then(() => {}),
      failed: false,
      ended: false,
      committing: false,
    };
    this.incoming.set(id, t);
    t.chain = t.chain.catch((err: unknown) =>
      this.failIncoming(id, t, formatErrorMessage(err, "Could not accept the transfer"), true)
    );
  }

  private onChunk(id: number, chunk: Uint8Array): void {
    const t = this.incoming.get(id);
    // Chunks already in flight when a transfer failed or was aborted are dropped.
    if (!t || t.failed) return;
    if (t.ended) {
      this.link.protocolError("transfer data after end");
      return;
    }
    if (t.received + chunk.byteLength > t.begin.size) {
      this.failIncoming(id, t, "More data than announced", true);
      return;
    }
    if (t.received + chunk.byteLength - t.ackedTo > TRANSFER_WINDOW_BYTES) {
      this.failIncoming(id, t, "Sender exceeded the flow-control window", true);
      return;
    }
    t.received += chunk.byteLength;
    t.hash.update(chunk);
    t.chain = t.chain.then(async () => {
      if (t.failed) return;
      try {
        await (await t.sink).write(chunk);
      } catch (err) {
        this.failIncoming(id, t, formatErrorMessage(err, "Could not write the file"), true);
        return;
      }
      t.written += chunk.byteLength;
      try {
        this.options.onIncomingProgress?.(t.begin, t.written);
      } catch {
        // Progress is advisory.
      }
      if (t.written - t.ackedTo >= ACK_EVERY_BYTES) this.ack(t, null);
    });
  }

  private onEnd(id: number): void {
    const t = this.incoming.get(id);
    if (!t || t.failed) return;
    if (t.ended) {
      this.link.protocolError("duplicate transfer end");
      return;
    }
    t.ended = true;
    if (t.received !== t.begin.size) {
      this.failIncoming(id, t, "Transfer ended early", true);
      return;
    }
    const digest = t.hash.digest("hex");
    t.chain = t.chain.then(async () => {
      if (t.failed) return;
      if (digest !== t.begin.sha256) {
        this.failIncoming(id, t, "Checksum mismatch", true);
        return;
      }
      let placed: string;
      t.committing = true;
      try {
        placed = await (await t.sink).commit();
      } catch (err) {
        t.committing = false;
        this.failIncoming(id, t, formatErrorMessage(err, "Could not save the file"), true);
        return;
      }
      if (this.incoming.get(id) === t) this.incoming.delete(id);
      this.ack(t, placed);
    });
  }

  private ack(t: Incoming, placedPath: string | null): void {
    t.ackedTo = t.written;
    this.postControl({
      lane: Lane.BULK,
      kind: BulkKind.TRANSFER_ACK,
      body: {
        transferId: t.begin.transferId,
        receivedBytes: t.written,
        path: placedPath,
        error: null,
      },
    });
  }

  private failIncoming(id: number, t: Incoming, reason: string, notifyPeer: boolean): void {
    if (t.failed) return;
    t.failed = true;
    if (this.incoming.get(id) === t) this.incoming.delete(id);
    void t.sink.then((sink) => sink.abort(reason)).catch(() => {});
    if (notifyPeer) {
      this.postControl({
        lane: Lane.BULK,
        kind: BulkKind.TRANSFER_ACK,
        body: { transferId: id, receivedBytes: t.written, path: null, error: clip(reason) },
      });
    }
  }
}
