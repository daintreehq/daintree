import { execFile } from "node:child_process";
import crypto from "node:crypto";
import type { BigIntStats } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import type { HostId } from "../../../shared/types/remoteHosts.js";
import { AppError } from "../../utils/errorTypes.js";
import type { TransferBeginMessage, TransferReason } from "../link/messages.js";
import type { LinkSession } from "../link/session.js";
import { DEFAULT_COMMIT_TIMEOUT_MS, type TransferSink } from "../link/transfer.js";
import { acceptClientBundleTransfer } from "../projects/bundleSinks.js";
import { copyInto, NEW_FILE_FLAGS } from "./exclusiveCopy.js";
import {
  DOWNLOAD_SINK_PREFIX,
  FileDownloadStartSchema,
  FileLinkMethod,
  FilePullResultSchema,
  FileResponseSchema,
  FileStreamClosedPayloadSchema,
  PREVIEW_PULL_DEPTH,
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
  /** Pulls to keep in flight on one preview body, when the host allows that many. */
  pullDepth?: number;
  downloadTimeoutMs?: number;
  /** How long a download whose link closed while it was being saved here has to finish saving. */
  commitTimeoutMs?: number;
}

export interface HostFileBody {
  /** The next slice of the body, in order; `done` once the host has sent all of it. */
  read(): Promise<{ bytes: Uint8Array; done: boolean }>;
  /** Stop reading: the host stops sending, and whatever is held for the body is dropped. */
  cancel(): void;
  /** Slice bytes held for this body now: arriving, or verified and waiting to be read. */
  readonly bufferedBytes: number;
  readonly peakBufferedBytes: number;
}

export interface OpenBodyOptions {
  /** The pulls the host accepts in flight on the stream, as its answer said; one when absent. */
  pullDepth?: number;
  /** The body's announced length, when there is one: no pull is made for bytes past it. */
  expectedBytes: number | null;
}

interface SliceResult {
  bytes: Uint8Array;
  done: boolean;
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

/**
 * A file name made safe to create here: one path segment, no control
 * characters, and none of the formatting characters (bidi overrides, zero
 * widths) that can make `gpj.exe` read as `exe.jpg`.
 */
export function sanitizeDownloadName(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? "";
  let cleaned = base
    // eslint-disable-next-line no-control-regex -- stripping control characters is the point
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, "")
    .replace(/[\u061c\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]/g, "")
    .replace(/[<>:"|?*]/g, "_");
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

/**
 * macOS: tag a file that came from another machine the way a browser tags a
 * download, so Gatekeeper checks it before it first opens or runs. Best
 * effort: a volume without extended attributes, or an xattr that fails or
 * times out, still gets the file, untagged.
 */
async function markDownloaded(file: string): Promise<void> {
  if (process.platform !== "darwin") return;
  const stamp = Math.floor(Date.now() / 1000).toString(16);
  await new Promise<void>((resolve) => {
    execFile(
      "/usr/bin/xattr",
      ["-w", "com.apple.quarantine", `0081;${stamp};Daintree;`, file],
      { timeout: 5_000 },
      () => resolve()
    );
  });
}

/**
 * What link() answers on a filesystem without hard links (FAT, exFAT, some SMB
 * and FUSE mounts). Windows reports FAT and exFAT's ERROR_INVALID_FUNCTION as EISDIR.
 */
const LINK_UNSUPPORTED = new Set([
  "EPERM",
  "ENOTSUP",
  "EOPNOTSUPP",
  "ENOSYS",
  ...(process.platform === "win32" ? ["EISDIR"] : []),
]);

interface FileIdentity {
  dev: bigint;
  ino: bigint;
}

interface Placed extends FileIdentity {
  path: string;
}

/** Remove a placed file only while its name still holds the file this download created. */
async function removePlaced(placed: Placed): Promise<void> {
  try {
    const there = await fs.lstat(placed.path, { bigint: true });
    if (there.dev !== placed.dev || there.ino !== placed.ino) return;
    await fs.rm(placed.path, { force: true });
  } catch {
    // Gone already, or no longer ours to remove.
  }
}

/**
 * Copy the part file into a name created exclusively. Null when the name is
 * taken; a copy that fails or comes up short leaves nothing at the name.
 */
async function copyUnique(
  partPath: string,
  target: string,
  stopped: () => boolean
): Promise<Placed | null> {
  let out: Awaited<ReturnType<typeof fs.open>>;
  try {
    out = await fs.open(target, NEW_FILE_FLAGS, 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return null;
    throw error;
  }
  let placed: Placed | null = null;
  let complete = false;
  try {
    const created = await out.stat({ bigint: true });
    placed = { path: target, dev: created.dev, ino: created.ino };
    // Tagged while still empty: a link would have carried the part file's tag.
    await markDownloaded(target);
    const source = await fs.open(partPath, "r");
    try {
      complete = (await copyInto(source, out)) === (await source.stat()).size && !stopped();
    } finally {
      await source.close().catch(() => {});
    }
  } finally {
    await out.close().catch(() => {});
    // Without the created file's identity the name can't be proven ours: leave it.
    if (!complete && placed) await removePlaced(placed);
  }
  if (!complete) {
    throw new AppError({
      code: "INTERNAL",
      message: "The download was not copied into place completely",
      userMessage: "The download couldn't be saved completely. Try again.",
    });
  }
  return placed;
}

/** Move the finished part file to the first free name; never overwrites. */
async function placeUnique(
  partPath: string,
  part: FileIdentity,
  dir: string,
  name: string,
  stopped: () => boolean
): Promise<Placed> {
  let linkable = true;
  for (let attempt = 0; attempt < MAX_UNIQUE_ATTEMPTS; attempt++) {
    const target = path.join(dir, candidateName(name, attempt));
    if (linkable) {
      try {
        await fs.link(partPath, target);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "EEXIST") continue;
        if (!code || !LINK_UNSUPPORTED.has(code)) throw error;
        linkable = false;
      }
      if (linkable) {
        await fs.unlink(partPath).catch(() => {});
        // A hard link is the part file itself.
        return { path: target, ...part };
      }
    }
    const placed = await copyUnique(partPath, target, stopped);
    if (placed) {
      await fs.unlink(partPath).catch(() => {});
      return placed;
    }
  }
  throw new AppError({ code: "INTERNAL", message: "No free file name for the download" });
}

class Gate {
  private active = 0;
  private readonly waiting: Array<() => void> = [];

  constructor(private readonly limit: number) {}

  /** A slot, after the waiters in front; the returned function gives it back, once. */
  async acquire(): Promise<() => void> {
    if (this.active >= this.limit) {
      await new Promise<void>((resolve) => this.waiting.push(resolve));
    } else {
      this.active++;
    }
    return this.releaser();
  }

  /**
   * A slot for read-ahead, only while another stays free: read-ahead never
   * queues, and a slice read ahead keeps its slot until someone reads it, so
   * a body whose reader paused must not hold the slot a waiting read needs.
   */
  tryAcquireSpare(): (() => void) | null {
    if (this.active >= this.limit - 1) return null;
    this.active++;
    return this.releaser();
  }

  private releaser(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.waiting.shift();
      if (next) next();
      else this.active--;
    };
  }
}

interface SliceSlot {
  sequence: number;
  /** Its gate slot; null while it waits for one. */
  release: (() => void) | null;
  settled: boolean;
  dropped: boolean;
  /** Bytes its sink holds, counted until the slice is handed over or dropped. */
  heldBytes: number;
  result: Promise<SliceResult>;
}

interface PreviewBodyDeps {
  session: LinkSession | null;
  hostId: HostId;
  streamId: string;
  depth: number;
  expectedBytes: number | null;
  gate: Gate;
  pullSlice(
    session: LinkSession,
    sequence: number | null,
    onBegin: (size: number) => void
  ): Promise<SliceResult>;
  /** Tell the host to stop: its stream is closed and its transfers aborted. */
  cancelRemote(): void;
  /** The body no longer needs the transport to route anything to it. */
  forget(): void;
}

/**
 * One preview body, read slice by slice in order. With a depth above one, the
 * next slices are pulled while the first is still being acknowledged, but
 * only on spare gate slots, and each slice keeps its slot until it has been
 * handed over or dropped, so read-ahead counts against the per-host pull cap
 * like any other pull, and the last slot is always left for a read someone
 * is waiting on. Cancelling, the host closing the
 * stream, the link dropping or any slice failing drops every slice held at
 * once; nothing read ahead is handed over after that.
 */
class PreviewBody implements HostFileBody {
  private readonly slots: SliceSlot[] = [];
  private nextSequence = 0;
  private endSeen = false;
  private finished = false;
  private stopped: Error | null = null;
  /** Rejects the read waiting on the head slice, when the body stops first. */
  private interruptRead: ((error: Error) => void) | null = null;
  private readonly offClose: () => void;
  private held = 0;
  private peak = 0;

  constructor(private readonly deps: PreviewBodyDeps) {
    const session = deps.session;
    if (!session || !session.isOpen) {
      this.offClose = () => {};
      this.stop(disconnected(deps.hostId));
      return;
    }
    this.offClose = session.onClose(() => this.stop(disconnected(deps.hostId)));
  }

  get bufferedBytes(): number {
    return this.held;
  }

  get peakBufferedBytes(): number {
    return this.peak;
  }

  async read(): Promise<SliceResult> {
    if (this.stopped) throw this.stopped;
    if (this.finished) return { bytes: new Uint8Array(0), done: true };
    if (this.slots.length === 0) this.demand();
    const head = this.slots[0]!;
    // Not a race against one long-lived promise: each read's reaction would
    // stay on it, holding that read's slice, for the life of the body.
    const result = await new Promise<SliceResult>((resolve, reject) => {
      this.interruptRead = reject;
      head.result.then(resolve, reject);
    }).finally(() => {
      this.interruptRead = null;
    });
    if (this.stopped) throw this.stopped;
    this.slots.shift();
    this.handOver(head);
    if (result.done) this.finish();
    else this.readAhead();
    return result;
  }

  cancel(): void {
    if (this.finished || this.stopped) return;
    this.stop(transferFailure("cancelled"));
    this.deps.cancelRemote();
  }

  /** The host closed the stream (revoked, idle, failed): drop everything, ask nothing. */
  closedByHost(): void {
    if (this.finished) return;
    this.stop(new AppError({ code: "CANCELLED", message: "The host closed the preview stream" }));
  }

  /** The slice the reader is waiting on: it takes the next free slot, in turn. */
  private demand(): void {
    const slot = this.newSlot();
    slot.result = this.deps.gate.acquire().then((release) => {
      slot.release = release;
      if (this.stopped) {
        this.settle(slot);
        throw this.stopped;
      }
      const result = this.issue(slot);
      this.readAhead();
      return result;
    });
    slot.result.catch(() => {});
  }

  /** Pull ahead, up to the depth, while slots are free and the body may have more. */
  private readAhead(): void {
    if (this.deps.depth < 2) return;
    while (!this.stopped && !this.finished && !this.endSeen) {
      if (this.slots.length >= this.deps.depth) return;
      // Pulls go out in sequence: none behind one still waiting for its slot.
      if (this.slots.some((slot) => slot.release === null)) return;
      const expected = this.deps.expectedBytes;
      // One pull past the announced length learns that the body ended there.
      if (expected !== null && this.nextSequence * PULL_MAX_BYTES > expected) return;
      const release = this.deps.gate.tryAcquireSpare();
      if (!release) return;
      const slot = this.newSlot();
      slot.release = release;
      slot.result = this.issue(slot);
      slot.result.catch(() => {});
    }
  }

  private newSlot(): SliceSlot {
    const slot: SliceSlot = {
      sequence: this.nextSequence++,
      release: null,
      settled: false,
      dropped: false,
      heldBytes: 0,
      result: Promise.resolve({ bytes: new Uint8Array(0), done: true }),
    };
    this.slots.push(slot);
    return slot;
  }

  private issue(slot: SliceSlot): Promise<SliceResult> {
    const session = this.deps.session!;
    const sequence = this.deps.depth > 1 ? slot.sequence : null;
    return this.deps
      .pullSlice(session, sequence, (size) => {
        if (slot.dropped) return;
        slot.heldBytes = size;
        this.held += size;
        if (this.held > this.peak) this.peak = this.held;
      })
      .then(
        (result) => {
          this.settle(slot);
          if (result.done) this.endSeen = true;
          return result;
        },
        (error: unknown) => {
          this.settle(slot);
          const failure = error instanceof Error ? error : new Error(String(error));
          if (!this.finished && !this.stopped) {
            this.stop(failure);
            this.deps.cancelRemote();
          }
          throw failure;
        }
      );
  }

  /** The slot's pull is over on the host too: a dropped slice gives its slot back now. */
  private settle(slot: SliceSlot): void {
    slot.settled = true;
    if (slot.dropped) slot.release?.();
  }

  private handOver(slot: SliceSlot): void {
    this.held -= slot.heldBytes;
    slot.heldBytes = 0;
    slot.release?.();
  }

  private drop(slot: SliceSlot): void {
    slot.dropped = true;
    this.held -= slot.heldBytes;
    slot.heldBytes = 0;
    // A slot whose pull is still running keeps counting until the host is done with it.
    if (slot.settled) slot.release?.();
  }

  /** The body was read to its end: pulls made past it are dropped, and the host may let go. */
  private finish(): void {
    this.finished = true;
    for (const slot of this.slots.splice(0)) this.drop(slot);
    this.offClose();
    this.deps.forget();
    // With several pulls in flight the host keeps the stream until it hears this.
    if (this.deps.depth > 1) this.deps.cancelRemote();
  }

  private stop(error: Error): void {
    if (this.stopped) return;
    this.stopped = error;
    this.interruptRead?.(error);
    for (const slot of this.slots.splice(0)) this.drop(slot);
    this.offClose();
    this.deps.forget();
  }
}

export class ClientFileTransport {
  private readonly hosts = new Map<HostId, HostLink>();
  private readonly sinks = new Map<string, SinkCreator>();
  private readonly sinkSessions = new WeakSet<LinkSession>();
  private readonly gates = new Map<HostId, Gate>();
  /** Bodies read with several pulls in flight, by stream, so the host can close them. */
  private readonly bodies = new Map<string, { session: LinkSession; body: PreviewBody }>();
  private readonly openedListeners = new Set<() => void>();

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
    for (const listener of [...this.openedListeners]) listener();
  }

  noteEndpointClosed(hostId: HostId, info: { endpointId: string }): void {
    const link = this.hosts.get(hostId);
    if (!link) return;
    link.endpoints.delete(info.endpointId);
    if (link.endpoints.size === 0) this.hosts.delete(hostId);
  }

  /** Whether the view has an endpoint on an open link to the host right now. */
  isReachable(hostId: HostId, webContentsId: number): boolean {
    const session = this.hosts.get(hostId)?.session;
    return !!session?.isOpen && this.endpointFor(hostId, webContentsId) !== null;
  }

  /**
   * Resolves true once the view is reachable on the host again (a link that
   * dropped has come back), false after `timeoutMs` or on abort.
   */
  whenReachable(
    hostId: HostId,
    webContentsId: number,
    timeoutMs: number,
    signal?: AbortSignal
  ): Promise<boolean> {
    if (this.isReachable(hostId, webContentsId)) return Promise.resolve(true);
    if (signal?.aborted) return Promise.resolve(false);
    return new Promise((resolve) => {
      const finish = (reachable: boolean) => {
        clearTimeout(timer);
        this.openedListeners.delete(check);
        signal?.removeEventListener("abort", onAbort);
        resolve(reachable);
      };
      const check = () => {
        if (this.isReachable(hostId, webContentsId)) finish(true);
      };
      const onAbort = () => finish(false);
      const timer = setTimeout(() => finish(false), timeoutMs);
      timer.unref?.();
      this.openedListeners.add(check);
      signal?.addEventListener("abort", onAbort, { once: true });
    });
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
      if (!create) {
        // A repository bundle a host sends when a project is copied here.
        const bundle = acceptClientBundleTransfer(begin);
        if (bundle) return bundle;
        throw new Error("No transfer was requested for this destination");
      }
      this.sinks.delete(destination.path);
      return create(begin);
    });
    session.registerCallHandler(
      FileLinkMethod.STREAM_CLOSED,
      FileStreamClosedPayloadSchema,
      ({ streamId }) => {
        const entry = this.bodies.get(streamId);
        if (entry?.session === session) entry.body.closedByHost();
        return null;
      }
    );
  }

  private get pullDepth(): number {
    return Math.max(1, this.options.pullDepth ?? PREVIEW_PULL_DEPTH);
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
      ...(this.pullDepth > 1 ? { pullDepth: this.pullDepth } : {}),
    });
    return FileResponseSchema.parse(answer);
  }

  /** The person clicked a link to this host file in the view's terminal: let the view open it. */
  async grantClicked(hostId: HostId, hostPath: string, webContentsId: number): Promise<void> {
    const endpointId = this.endpointFor(hostId, webContentsId);
    if (endpointId === null) throw disconnected(hostId);
    await this.sessionFor(hostId).call(FileLinkMethod.GRANT_CLICKED, { endpointId, hostPath });
  }

  /**
   * Read a streamed body the host answered a preview with, pulling as many
   * slices at once as both the host's answer and this Shell allow.
   */
  openBody(hostId: HostId, streamId: string, options: OpenBodyOptions): HostFileBody {
    const session = this.hosts.get(hostId)?.session ?? null;
    const depth = Math.max(1, Math.min(options.pullDepth ?? 1, this.pullDepth));
    // Assigned after construction: a body opened with no live session stops,
    // and forgets itself, inside its constructor.
    let body: PreviewBody | null = null;
    body = new PreviewBody({
      session,
      hostId,
      streamId,
      depth,
      expectedBytes: options.expectedBytes,
      gate: this.gate(hostId),
      pullSlice: (pinned, sequence, onBegin) => this.pullSlice(pinned, streamId, sequence, onBegin),
      cancelRemote: () => {
        if (session?.isOpen) {
          // No deadline: a notice that settles unsent is dropped, and nothing sends it again.
          void session.call(FileLinkMethod.CANCEL, { streamId }, { timeoutMs: 0 }).catch(() => {});
        }
      },
      forget: () => {
        if (body && this.bodies.get(streamId)?.body === body) this.bodies.delete(streamId);
      },
    });
    if (depth > 1 && session?.isOpen) this.bodies.set(streamId, { session, body });
    return body;
  }

  /** One slice of a streamed body, on the session the stream was opened on. */
  private async pullSlice(
    session: LinkSession,
    streamId: string,
    sequence: number | null,
    onBegin: (size: number) => void
  ): Promise<SliceResult> {
    if (!session.isOpen) throw new AppError({ code: "HOST_DISCONNECTED", message: "Link closed" });
    const token = newToken();
    const destination = `${STREAM_SINK_PREFIX}${token}`;
    let settle!: { resolve: (bytes: Uint8Array) => void; reject: (error: Error) => void };
    const received = new Promise<Uint8Array>((resolve, reject) => {
      settle = { resolve, reject };
    });
    received.catch(() => {});
    this.sinks.set(destination, (begin) => {
      if (begin.size > PULL_MAX_BYTES) throw new Error("Slice larger than requested");
      // Written in place as it arrives: one copy of the slice, never two.
      const out = new Uint8Array(begin.size);
      let written = 0;
      onBegin(begin.size);
      return {
        write(chunk) {
          if (written + chunk.byteLength > out.byteLength) {
            throw new Error("Slice larger than announced");
          }
          out.set(chunk, written);
          written += chunk.byteLength;
        },
        async commit() {
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
        await session.call(FileLinkMethod.PULL, {
          streamId,
          token,
          maxBytes: PULL_MAX_BYTES,
          ...(sequence !== null ? { sequence } : {}),
        })
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
          () => reject(new AppError({ code: "INTERNAL", message: "Preview slice never arrived" })),
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
  }

  async cancelStream(hostId: HostId, streamId: string): Promise<void> {
    const session = this.hosts.get(hostId)?.session;
    if (!session?.isOpen) return;
    // No deadline: a notice that settles unsent is dropped, and nothing sends it again.
    await session.call(FileLinkMethod.CANCEL, { streamId }, { timeoutMs: 0 }).catch(() => {});
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
    /** Why the link closed, once it has: the reason the transfer layer aborts the sink with. */
    let closedWith: string | null = null;
    const createSink = async (begin: TransferBeginMessage): Promise<TransferSink> => {
      if (signal?.aborted) throw new Error("cancelled");
      await fs.mkdir(options.destinationDir, { recursive: true });
      // Named for the file that was asked for, never what the host calls it.
      const name = sanitizeDownloadName(path.posix.basename(hostPath));
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
      let aborted = false;
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
          try {
            let saved: BigIntStats;
            try {
              await handle.sync();
              saved = await handle.stat({ bigint: true });
            } finally {
              await close();
            }
            // Tagged before the last look at cancellation, so a cancel while
            // xattr runs is still honoured.
            await markDownloaded(partPath);
            // Cancelled after the last byte: never place it.
            if (signal?.aborted) throw new Error("cancelled");
            // The checksum covers what arrived, not what landed on disk.
            if (saved.size !== BigInt(written) || written !== begin.size) {
              throw new AppError({
                code: "INTERNAL",
                message: "The saved download is not the size that was sent",
                userMessage: "The download couldn't be saved completely. Try again.",
              });
            }
            // A copy can outlast the commit budget; the abort that follows must win.
            const stopped = () => aborted || !!signal?.aborted;
            const placed = await placeUnique(
              partPath,
              { dev: saved.dev, ino: saved.ino },
              options.destinationDir,
              name,
              stopped
            );
            // No await between this check and resolving: an abort can't slip in after it.
            if (stopped()) {
              await removePlaced(placed);
              throw new Error("cancelled");
            }
            settle.resolve({ localPath: placed.path, bytes: written });
          } catch (error) {
            await fs.rm(partPath, { force: true }).catch(() => {});
            // Settled here so a save that fails after the link dropped is
            // reported as itself, never as the drop that would retry it.
            settle.reject(error instanceof Error ? error : new Error(String(error)));
            throw error;
          }
          // The host learns only that it landed, never where.
          return "saved";
        },
        async abort(reason) {
          aborted = true;
          // Decided before cleanup: a link that closes while a failed transfer
          // is being cleaned up must not turn that failure into a retryable drop.
          const failure = signal?.aborted
            ? transferFailure("cancelled")
            : reason === closedWith
              ? disconnected(hostId)
              : transferFailure(reason);
          await close();
          await fs.rm(partPath, { force: true }).catch(() => {});
          settle.reject(failure);
        },
      };
    };
    let begun = false;
    let activeSink: TransferSink | null = null;
    this.sinks.set(destination, async (begin) => {
      begun = true;
      if (beginTimer) clearTimeout(beginTimer);
      try {
        activeSink = await createSink(begin);
        return activeSink;
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

    // Once the host has begun sending, the sink's own commit or abort decides
    // (the transfer layer ends every sink when its link closes), so a file
    // already being placed here is never reported as lost and fetched again.
    const offClose = session.onClose((info) => {
      closedWith = info.reason;
      if (!begun) {
        settle.reject(disconnected(hostId));
        return;
      }
      // With the link gone, the transfer layer no longer bounds the commit.
      const timer = setTimeout(() => {
        settle.reject(transferFailure("timeout"));
        void Promise.resolve(activeSink?.abort("timeout")).catch(() => {});
      }, this.options.commitTimeoutMs ?? DEFAULT_COMMIT_TIMEOUT_MS);
      timer.unref?.();
      void done.finally(() => clearTimeout(timer)).catch(() => {});
    });
    const onAbort = () => settle.reject(transferFailure("cancelled"));
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      const timeoutMs = this.options.downloadTimeoutMs ?? DEFAULT_DOWNLOAD_TIMEOUT_MS;
      let started: unknown;
      try {
        started = await session.call(
          FileLinkMethod.DOWNLOAD,
          { endpointId, hostPath, token },
          { timeoutMs, signal }
        );
      } catch (error) {
        // The link closed under the call: its answer is lost, and the close
        // decides. An answer the host did send (a refusal) still stands.
        const code = (error as { code?: unknown } | null)?.code;
        if (
          closedWith !== null &&
          !signal?.aborted &&
          (code === "OUTCOME_UNKNOWN" || code === "HOST_DISCONNECTED")
        ) {
          return await done;
        }
        throw error;
      }
      FileDownloadStartSchema.parse(started);
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
