import crypto from "node:crypto";
import fs from "node:fs/promises";
import { AppError } from "../../utils/errorTypes.js";
import { logWarn } from "../../utils/logger.js";
import { formatErrorMessage } from "../../../shared/utils/errorMessage.js";
import { BULK_CHUNK_BYTES, Lane } from "./frames.js";
import {
  BulkKind,
  type LinkMessage,
  type TransferAbortMessage,
  type TransferAckMessage,
  type TransferBeginMessage,
  type TransferReason,
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
 * injected sink. A final ACK carries the placed path or the error, as a
 * {@link TransferReason} code; the diagnostic stays in the local log.
 *
 * Both ends time a transfer out when it stops moving (no chunk or ack for
 * {@link DEFAULT_INACTIVITY_TIMEOUT_MS}) or when placing it takes longer than
 * {@link DEFAULT_COMMIT_TIMEOUT_MS}, so a wedged sink or a silent peer frees its
 * slot instead of holding it for the life of the session.
 *
 * Transfer ids are per sender. Clients use odd ids and hosts even ids so an
 * ABORT, which either side may send, always names one transfer unambiguously.
 */

export const TRANSFER_WINDOW_BYTES = 16 * BULK_CHUNK_BYTES;
const ACK_EVERY_BYTES = 4 * BULK_CHUNK_BYTES;
const DEFAULT_MAX_INCOMING = 8;
const DEFAULT_MAX_INCOMING_BYTES = 4 * 1024 * 1024 * 1024;
const MAX_RETRY_QUEUE = 4096;
export const DEFAULT_INACTIVITY_TIMEOUT_MS = 60_000;
export const DEFAULT_COMMIT_TIMEOUT_MS = 120_000;

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
  /** No chunk or ack progress for this long aborts the transfer. */
  inactivityTimeoutMs?: number;
  /** Time allowed from END to the placed file (or, sending, to its ack). */
  commitTimeoutMs?: number;
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
  timer: ReturnType<typeof setTimeout> | null;
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
  timer: ReturnType<typeof setTimeout> | null;
}

const PEER_REASON_MESSAGES: Record<TransferReason, string> = {
  cancelled: "The transfer was cancelled",
  "source-failed": "The sender could not read the file",
  "sink-failed": "The receiver could not save the file",
  "checksum-mismatch": "Checksum mismatch",
  "invalid-data": "The transfer data was invalid",
  timeout: "The transfer stalled and timed out",
  "too-large": "Transfer is too large",
  busy: "Too many transfers in progress",
  "not-accepted": "The other side does not accept transfers",
};

function transferError(
  code:
    | "CANCELLED"
    | "HOST_DISCONNECTED"
    | "INTERNAL"
    | "OUTCOME_UNKNOWN"
    | "PAYLOAD_TOO_LARGE"
    | "RATE_LIMITED"
    | "VALIDATION",
  message: string
) {
  return new AppError({ code, message });
}

function peerFailure(reason: TransferReason): AppError {
  const message = PEER_REASON_MESSAGES[reason];
  switch (reason) {
    case "cancelled":
      return transferError("CANCELLED", message);
    case "too-large":
      return transferError("PAYLOAD_TOO_LARGE", message);
    case "busy":
      return transferError("RATE_LIMITED", message);
    default:
      return transferError("INTERNAL", message);
  }
}

function logFailure(side: "send" | "receive", id: number, reason: TransferReason, err?: unknown) {
  logWarn("remote.transfer.failed", {
    side,
    transferId: id,
    reason,
    ...(err !== undefined ? { detail: formatErrorMessage(err, reason) } : {}),
  });
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
      const t: Outgoing = {
        id,
        source,
        begin,
        phase: "begin",
        sent: 0,
        acked: 0,
        stash: null,
        timer: null,
        onProgress: options.onProgress,
        resolve: (result) => {
          cleanup();
          resolve(result);
        },
        reject: (err) => {
          cleanup();
          reject(err);
        },
      };
      this.outgoing.set(id, t);
      this.armOutgoing(t);
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
    for (const [id, t] of [...this.outgoing]) {
      // Once END is out the receiver may have verified and placed the file
      // before the link dropped; only the missing ack is certain.
      this.finishOutgoing(
        id,
        t.phase === "wait"
          ? transferError(
              "OUTCOME_UNKNOWN",
              `Link closed after all data was sent; the file may have been saved: ${reason}`
            )
          : transferError("HOST_DISCONNECTED", `Link closed: ${reason}`)
      );
    }
    for (const [id, t] of [...this.incoming]) {
      this.incoming.delete(id);
      this.clearTimer(t);
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

  private clearTimer(t: { timer: ReturnType<typeof setTimeout> | null }): void {
    if (t.timer) clearTimeout(t.timer);
    t.timer = null;
  }

  private startTimer(
    t: { timer: ReturnType<typeof setTimeout> | null },
    ms: number,
    onFire: () => void
  ): void {
    this.clearTimer(t);
    t.timer = setTimeout(() => {
      t.timer = null;
      onFire();
    }, ms);
    t.timer.unref?.();
  }

  /** (Re)start the sender's clock: inactivity while sending, commit once END is out. */
  private armOutgoing(t: Outgoing): void {
    if (t.phase === "wait") {
      this.startTimer(t, this.options.commitTimeoutMs ?? DEFAULT_COMMIT_TIMEOUT_MS, () => {
        if (!this.active(t)) return;
        logFailure("send", t.id, "timeout");
        this.postControl({
          lane: Lane.BULK,
          kind: BulkKind.TRANSFER_ABORT,
          body: { transferId: t.id, reason: "timeout" },
        });
        this.finishOutgoing(
          t.id,
          transferError(
            "OUTCOME_UNKNOWN",
            "The other side did not confirm the transfer in time; the file may have been saved"
          )
        );
      });
      return;
    }
    this.startTimer(t, this.options.inactivityTimeoutMs ?? DEFAULT_INACTIVITY_TIMEOUT_MS, () => {
      if (!this.active(t)) return;
      this.failOutgoing(t, "timeout");
    });
  }

  /** (Re)start the receiver's clock: inactivity until END, then the commit budget. */
  private armIncoming(id: number, t: Incoming): void {
    if (t.failed) return;
    const ms = t.ended
      ? (this.options.commitTimeoutMs ?? DEFAULT_COMMIT_TIMEOUT_MS)
      : (this.options.inactivityTimeoutMs ?? DEFAULT_INACTIVITY_TIMEOUT_MS);
    this.startTimer(t, ms, () => {
      // A commit in progress is no longer abortable from the peer, but a sink
      // that never settles must not hold the slot for the rest of the session.
      t.committing = false;
      this.failIncoming(id, t, "timeout", true);
    });
  }

  private postControl(message: LinkMessage): void {
    if (this.closed) return;
    if (this.retry.length === 0) {
      let result: EnqueueResult;
      try {
        result = this.link.post(message);
      } catch {
        // Unsendable (should not happen with fixed reason codes); drop rather than wedge.
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
            if (this.active(t)) this.failOutgoing(t, "source-failed", err);
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
          this.failOutgoing(t, "source-failed", err);
          return;
        }
        if (!this.active(t)) return;
        if (chunk.byteLength !== length) {
          this.failOutgoing(
            t,
            "source-failed",
            new Error("The file changed while it was being sent")
          );
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
      this.armOutgoing(t);
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
      this.armOutgoing(t);
    }
  }

  /** Our own failure: the detail stays in the local error and log; the peer gets the code. */
  private failOutgoing(t: Outgoing, reason: TransferReason, err?: unknown): void {
    logFailure("send", t.id, reason, err);
    const message =
      err !== undefined
        ? formatErrorMessage(err, PEER_REASON_MESSAGES[reason])
        : PEER_REASON_MESSAGES[reason];
    this.finishOutgoing(t.id, transferError("INTERNAL", message));
    this.postControl({
      lane: Lane.BULK,
      kind: BulkKind.TRANSFER_ABORT,
      body: { transferId: t.id, reason },
    });
  }

  private finishOutgoing(id: number, outcome: Error | TransferResult): void {
    const t = this.outgoing.get(id);
    if (!t) return;
    this.outgoing.delete(id);
    this.clearTimer(t);
    void Promise.resolve(t.source.close?.()).catch(() => {});
    if (outcome instanceof Error) t.reject(outcome);
    else t.resolve(outcome);
  }

  private onAck(ack: TransferAckMessage): void {
    const t = this.outgoing.get(ack.transferId);
    if (!t) return;
    if (ack.error !== null) {
      this.finishOutgoing(t.id, peerFailure(ack.error));
      return;
    }
    if (ack.receivedBytes > t.sent) {
      this.link.protocolError("transfer ack beyond sent bytes");
      return;
    }
    if (ack.receivedBytes > t.acked) {
      t.acked = ack.receivedBytes;
      this.armOutgoing(t);
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
      this.finishOutgoing(abort.transferId, peerFailure(abort.reason));
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
    const refuse = (reason: TransferReason) =>
      this.postControl({
        lane: Lane.BULK,
        kind: BulkKind.TRANSFER_ACK,
        body: { transferId: id, receivedBytes: 0, path: null, error: reason },
      });
    const factory = this.sinkFactory;
    if (!factory) return refuse("not-accepted");
    if (this.incoming.size >= (this.options.maxIncoming ?? DEFAULT_MAX_INCOMING)) {
      return refuse("busy");
    }
    if (begin.size > (this.options.maxIncomingBytes ?? DEFAULT_MAX_INCOMING_BYTES)) {
      return refuse("too-large");
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
      timer: null,
    };
    this.incoming.set(id, t);
    this.armIncoming(id, t);
    t.chain = t.chain.catch((err: unknown) => this.failIncoming(id, t, "sink-failed", true, err));
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
      this.failIncoming(id, t, "invalid-data", true, new Error("More data than announced"));
      return;
    }
    if (t.received + chunk.byteLength - t.ackedTo > TRANSFER_WINDOW_BYTES) {
      this.failIncoming(
        id,
        t,
        "invalid-data",
        true,
        new Error("Sender exceeded the flow-control window")
      );
      return;
    }
    t.received += chunk.byteLength;
    t.hash.update(chunk);
    this.armIncoming(id, t);
    t.chain = t.chain.then(async () => {
      if (t.failed) return;
      try {
        await (await t.sink).write(chunk);
      } catch (err) {
        this.failIncoming(id, t, "sink-failed", true, err);
        return;
      }
      if (t.failed) return;
      t.written += chunk.byteLength;
      if (!t.ended) this.armIncoming(id, t);
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
      this.failIncoming(id, t, "invalid-data", true, new Error("Transfer ended early"));
      return;
    }
    this.armIncoming(id, t);
    const digest = t.hash.digest("hex");
    t.chain = t.chain.then(async () => {
      if (t.failed) return;
      if (digest !== t.begin.sha256) {
        this.failIncoming(id, t, "checksum-mismatch", true);
        return;
      }
      let placed: string;
      t.committing = true;
      try {
        placed = await (await t.sink).commit();
      } catch (err) {
        t.committing = false;
        this.failIncoming(id, t, "sink-failed", true, err);
        return;
      }
      // Timed out while placing: the peer has already been told it failed.
      if (t.failed) return;
      if (this.incoming.get(id) === t) this.incoming.delete(id);
      this.clearTimer(t);
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

  private failIncoming(
    id: number,
    t: Incoming,
    reason: TransferReason,
    notifyPeer: boolean,
    err?: unknown
  ): void {
    if (t.failed) return;
    t.failed = true;
    this.clearTimer(t);
    if (this.incoming.get(id) === t) this.incoming.delete(id);
    if (notifyPeer) logFailure("receive", id, reason, err);
    void t.sink.then((sink) => sink.abort(reason)).catch(() => {});
    if (notifyPeer) {
      this.postControl({
        lane: Lane.BULK,
        kind: BulkKind.TRANSFER_ACK,
        body: { transferId: id, receivedBytes: t.written, path: null, error: reason },
      });
    }
  }
}
