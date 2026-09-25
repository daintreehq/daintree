import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { HostId } from "../../../shared/types/remoteHosts.js";
import { AppError } from "../../utils/errorTypes.js";
import type { TransferBeginMessage, TransferReason } from "../link/messages.js";
import type { LinkSession } from "../link/session.js";
import type { TransferSink } from "../link/transfer.js";
import {
  DOWNLOAD_SINK_PREFIX,
  FileDownloadStartSchema,
  FileLinkMethod,
  FilePullResultSchema,
  FileResponseSchema,
  PULL_MAX_BYTES,
  STREAM_SINK_PREFIX,
  type FileRequestPayload,
  type FileResponse,
} from "./linkMethods.js";

/**
 * The Shell half of reading host files: which session and endpoints to use
 * for a host, preview pulls with bounded concurrency, and downloads saved on
 * this machine. Every byte arrives as a bulk transfer the receiver verifies
 * against the sender's sha256 before it is used or placed.
 */

export interface ClientFileTransportOptions {
  /** Preview pulls in flight per host; the rest wait. Keeps previews off terminal traffic. */
  maxConcurrentPulls?: number;
  downloadTimeoutMs?: number;
}

export interface DownloadOptions {
  /** The view asking: the download runs under its own endpoint on the host, never another's. */
  webContentsId: number;
  destinationDir: string;
  onProgress?: (receivedBytes: number, totalBytes: number) => void;
  signal?: AbortSignal;
}

export interface DownloadOutcome {
  localPath: string;
  bytes: number;
}

interface HostLink {
  session: LinkSession | null;
  /** endpointId → the view it belongs to. */
  endpoints: Map<string, number>;
}

type SinkCreator = (begin: TransferBeginMessage) => Promise<TransferSink> | TransferSink;

const DEFAULT_MAX_CONCURRENT_PULLS = 4;
const DEFAULT_DOWNLOAD_TIMEOUT_MS = 5 * 60_000;
const PULL_RESULT_TIMEOUT_MS = 60_000;
const MAX_NAME_LENGTH = 200;
const MAX_UNIQUE_ATTEMPTS = 1_000;

function newToken(): string {
  return crypto.randomBytes(16).toString("hex");
}

function disconnected(hostId: HostId): AppError {
  return new AppError({
    code: "HOST_DISCONNECTED",
    message: `Host ${hostId} is not connected`,
    userMessage: "The host isn't connected.",
  });
}

function transferFailure(reason: TransferReason | string): AppError {
  if (reason === "cancelled") {
    return new AppError({ code: "CANCELLED", message: "Transfer cancelled" });
  }
  if (reason === "checksum-mismatch") {
    return new AppError({
      code: "INTERNAL",
      message: "The file failed its checksum",
      userMessage: "The download was corrupted in transit. Try again.",
    });
  }
  return new AppError({ code: "INTERNAL", message: `Transfer failed: ${reason}` });
}

/** A file name from the host, made safe to create here. */
export function sanitizeDownloadName(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? "";
  // eslint-disable-next-line no-control-regex -- stripping control characters is the point
  let cleaned = base.replace(/[\u0000-\u001f\u007f]/g, "").replace(/[<>:"|?*]/g, "_");
  cleaned = cleaned.replace(/^\.+/, "").trim();
  if (cleaned.length > MAX_NAME_LENGTH) {
    const ext = path.extname(cleaned).slice(0, 20);
    cleaned = cleaned.slice(0, MAX_NAME_LENGTH - ext.length) + ext;
  }
  return cleaned || "download";
}

function candidateName(name: string, attempt: number): string {
  if (attempt === 0) return name;
  const ext = path.extname(name);
  return `${name.slice(0, name.length - ext.length)} (${attempt})${ext}`;
}

/** Move the finished part file to the first free name; never overwrites. */
async function placeUnique(partPath: string, dir: string, name: string): Promise<string> {
  for (let attempt = 0; attempt < MAX_UNIQUE_ATTEMPTS; attempt++) {
    const target = path.join(dir, candidateName(name, attempt));
    try {
      await fs.link(partPath, target);
      await fs.unlink(partPath).catch(() => {});
      return target;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") continue;
      throw error;
    }
  }
  throw new AppError({ code: "INTERNAL", message: "No free file name for the download" });
}

class Gate {
  private active = 0;
  private readonly waiting: Array<() => void> = [];

  constructor(private readonly limit: number) {}

  async run<T>(work: () => Promise<T>): Promise<T> {
    if (this.active >= this.limit) {
      await new Promise<void>((resolve) => this.waiting.push(resolve));
    } else {
      this.active++;
    }
    try {
      return await work();
    } finally {
      const next = this.waiting.shift();
      if (next) next();
      else this.active--;
    }
  }
}

export class ClientFileTransport {
  private readonly hosts = new Map<HostId, HostLink>();
  private readonly sinks = new Map<string, SinkCreator>();
  private readonly sinkSessions = new WeakSet<LinkSession>();
  private readonly gates = new Map<HostId, Gate>();

  constructor(private readonly options: ClientFileTransportOptions = {}) {}

  /** A view's endpoint is live on `session` (opened, or carried over by a resume). */
  noteEndpointOpened(
    hostId: HostId,
    info: { session: LinkSession; webContentsId: number; endpointId: string }
  ): void {
    let link = this.hosts.get(hostId);
    if (!link) {
      link = { session: null, endpoints: new Map() };
      this.hosts.set(hostId, link);
    }
    link.session = info.session;
    link.endpoints.set(info.endpointId, info.webContentsId);
    this.acceptTransfers(info.session);
  }

  noteEndpointClosed(hostId: HostId, info: { endpointId: string }): void {
    const link = this.hosts.get(hostId);
    if (!link) return;
    link.endpoints.delete(info.endpointId);
    if (link.endpoints.size === 0) this.hosts.delete(hostId);
  }

  /**
   * The asking view's own endpoint on the host (its newest, after a rebind),
   * or null. Never another view's: the host authorizes a file call against
   * exactly this endpoint's project and lease.
   */
  endpointFor(hostId: HostId, webContentsId: number): string | null {
    const link = this.hosts.get(hostId);
    if (!link) return null;
    let found: string | null = null;
    for (const [endpointId, owner] of link.endpoints) {
      if (owner === webContentsId) found = endpointId;
    }
    return found;
  }

  private sessionFor(hostId: HostId): LinkSession {
    const session = this.hosts.get(hostId)?.session;
    if (!session || !session.isOpen) throw disconnected(hostId);
    return session;
  }

  private gate(hostId: HostId): Gate {
    let gate = this.gates.get(hostId);
    if (!gate) {
      gate = new Gate(this.options.maxConcurrentPulls ?? DEFAULT_MAX_CONCURRENT_PULLS);
      this.gates.set(hostId, gate);
    }
    return gate;
  }

  /**
   * Transfers from a host land only where this Shell asked for them: a
   * destination naming a token nobody minted is refused.
   */
  private acceptTransfers(session: LinkSession): void {
    if (this.sinkSessions.has(session)) return;
    this.sinkSessions.add(session);
    session.transfers.setSinkFactory((begin) => {
      const destination = begin.destination;
      if (destination.kind !== "path") throw new Error("Unexpected transfer destination");
      const create = this.sinks.get(destination.path);
      if (!create) throw new Error("No transfer was requested for this destination");
      this.sinks.delete(destination.path);
      return create(begin);
    });
  }

  async request(
    hostId: HostId,
    payload: Omit<FileRequestPayload, "endpointId">,
    webContentsId: number
  ): Promise<FileResponse> {
    const endpointId = this.endpointFor(hostId, webContentsId);
    if (endpointId === null) throw disconnected(hostId);
    const answer = await this.sessionFor(hostId).call(FileLinkMethod.REQUEST, {
      ...payload,
      endpointId,
    });
    return FileResponseSchema.parse(answer);
  }

  /** The next slice of a streamed body; `done` once the host has sent it all. */
  pull(
    hostId: HostId,
    streamId: string,
    maxBytes = PULL_MAX_BYTES
  ): Promise<{ bytes: Uint8Array; done: boolean }> {
    return this.gate(hostId).run(async () => {
      const session = this.sessionFor(hostId);
      const token = newToken();
      const destination = `${STREAM_SINK_PREFIX}${token}`;
      let settle!: { resolve: (bytes: Uint8Array) => void; reject: (error: Error) => void };
      const received = new Promise<Uint8Array>((resolve, reject) => {
        settle = { resolve, reject };
      });
      received.catch(() => {});
      this.sinks.set(destination, (begin) => {
        if (begin.size > maxBytes) throw new Error("Slice larger than requested");
        const chunks: Uint8Array[] = [];
        let total = 0;
        return {
          write(chunk) {
            total += chunk.byteLength;
            chunks.push(chunk);
          },
          async commit() {
            const out = new Uint8Array(total);
            let offset = 0;
            for (const chunk of chunks) {
              out.set(chunk, offset);
              offset += chunk.byteLength;
            }
            settle.resolve(out);
            return "received";
          },
          abort(reason) {
            settle.reject(transferFailure(reason));
          },
        };
      });
      let result;
      try {
        result = FilePullResultSchema.parse(
          await session.call(FileLinkMethod.PULL, { streamId, token, maxBytes })
        );
      } catch (error) {
        this.sinks.delete(destination);
        throw error;
      }
      if (result.bytes === 0) {
        this.sinks.delete(destination);
        return { bytes: new Uint8Array(0), done: result.done };
      }
      // The host answers only once its transfer was acknowledged, so the bytes are here.
      const bytes = await Promise.race([
        received,
        new Promise<never>((_, reject) => {
          const timer = setTimeout(
            () =>
              reject(new AppError({ code: "INTERNAL", message: "Preview slice never arrived" })),
            PULL_RESULT_TIMEOUT_MS
          );
          timer.unref?.();
          void received.finally(() => clearTimeout(timer)).catch(() => {});
        }),
      ]).finally(() => this.sinks.delete(destination));
      if (bytes.byteLength !== result.bytes) {
        throw new AppError({ code: "INTERNAL", message: "Preview slice size mismatch" });
      }
      return { bytes, done: result.done };
    });
  }

  async cancelStream(hostId: HostId, streamId: string): Promise<void> {
    const session = this.hosts.get(hostId)?.session;
    if (!session?.isOpen) return;
    await session.call(FileLinkMethod.CANCEL, { streamId }).catch(() => {});
  }

  /** Save a host file into `destinationDir` here, under a name that doesn't overwrite anything. */
  async download(
    hostId: HostId,
    hostPath: string,
    options: DownloadOptions
  ): Promise<DownloadOutcome> {
    const { signal } = options;
    if (signal?.aborted) throw new AppError({ code: "CANCELLED", message: "Download cancelled" });
    const session = this.sessionFor(hostId);
    const endpointId = this.endpointFor(hostId, options.webContentsId);
    if (endpointId === null) throw disconnected(hostId);

    const token = newToken();
    const destination = `${DOWNLOAD_SINK_PREFIX}${token}`;
    let settle!: { resolve: (outcome: DownloadOutcome) => void; reject: (error: Error) => void };
    const done = new Promise<DownloadOutcome>((resolve, reject) => {
      settle = { resolve, reject };
    });
    done.catch(() => {});

    let beginTimer: ReturnType<typeof setTimeout> | null = null;
    const createSink = async (begin: TransferBeginMessage): Promise<TransferSink> => {
      if (signal?.aborted) throw new Error("cancelled");
      await fs.mkdir(options.destinationDir, { recursive: true });
      const name = sanitizeDownloadName(begin.name);
      const partPath = path.join(options.destinationDir, `.${newToken()}.daintree-part`);
      const handle = await fs.open(
        partPath,
        fs.constants.O_WRONLY |
          fs.constants.O_CREAT |
          fs.constants.O_EXCL |
          fs.constants.O_NOFOLLOW,
        0o600
      );
      let written = 0;
      let closed = false;
      const close = async () => {
        if (closed) return;
        closed = true;
        await handle.close().catch(() => {});
      };
      return {
        async write(chunk) {
          if (signal?.aborted) throw new Error("cancelled");
          // A write may take fewer bytes than offered; count only what reached the file.
          for (let offset = 0; offset < chunk.byteLength;) {
            const { bytesWritten } = await handle.write(
              chunk,
              offset,
              chunk.byteLength - offset,
              written
            );
            if (bytesWritten <= 0) throw new Error("The download could not be written");
            offset += bytesWritten;
            written += bytesWritten;
          }
          try {
            options.onProgress?.(written, begin.size);
          } catch {
            // Progress is advisory.
          }
        },
        async commit() {
          let savedBytes: number;
          try {
            await handle.sync();
            savedBytes = (await handle.stat()).size;
          } finally {
            await close();
          }
          // Cancelled after the last byte: never place it.
          if (signal?.aborted) throw new Error("cancelled");
          try {
            // The checksum covers what arrived, not what landed on disk.
            if (savedBytes !== written || written !== begin.size) {
              throw new AppError({
                code: "INTERNAL",
                message: "The saved download is not the size that was sent",
                userMessage: "The download couldn't be saved completely. Try again.",
              });
            }
            const localPath = await placeUnique(partPath, options.destinationDir, name);
            settle.resolve({ localPath, bytes: written });
          } catch (error) {
            await fs.rm(partPath, { force: true }).catch(() => {});
            settle.reject(error instanceof Error ? error : new Error(String(error)));
            throw error;
          }
          // The host learns only that it landed, never where.
          return "saved";
        },
        async abort(reason) {
          await close();
          await fs.rm(partPath, { force: true }).catch(() => {});
          settle.reject(signal?.aborted ? transferFailure("cancelled") : transferFailure(reason));
        },
      };
    };
    this.sinks.set(destination, async (begin) => {
      if (beginTimer) clearTimeout(beginTimer);
      try {
        return await createSink(begin);
      } catch (error) {
        // The transfer layer only tells the host; the caller must hear it too.
        settle.reject(
          signal?.aborted
            ? transferFailure("cancelled")
            : new AppError({ code: "INTERNAL", message: "Couldn't save the download here" })
        );
        throw error;
      }
    });

    const offClose = session.onClose(() => settle.reject(disconnected(hostId)));
    const onAbort = () => settle.reject(transferFailure("cancelled"));
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      const timeoutMs = this.options.downloadTimeoutMs ?? DEFAULT_DOWNLOAD_TIMEOUT_MS;
      FileDownloadStartSchema.parse(
        await session.call(
          FileLinkMethod.DOWNLOAD,
          { endpointId, hostPath, token },
          { timeoutMs, signal }
        )
      );
      // The host has started sending; a transfer that never begins must not hang the download.
      if (this.sinks.has(destination)) {
        beginTimer = setTimeout(
          () =>
            settle.reject(
              new AppError({ code: "INTERNAL", message: "The host never sent the file" })
            ),
          timeoutMs
        );
        beginTimer.unref?.();
      }
      return await done;
    } finally {
      if (beginTimer) clearTimeout(beginTimer);
      this.sinks.delete(destination);
      offClose();
      signal?.removeEventListener("abort", onAbort);
    }
  }
}
