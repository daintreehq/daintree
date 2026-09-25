import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { ClientEndpoint } from "../../ipc/endpoint.js";
import {
  buildContainedFileUrl,
  buildDaintreeFileErrorHeaders,
  resolveContainedRealPath,
  serveContainedFileRequest,
  type ContainedFileScheme,
} from "../../setup/protocols.js";
import { AppError } from "../../utils/errorTypes.js";
import { logWarn } from "../../utils/logger.js";
import type { LinkSession } from "../link/session.js";
import { BULK_CHUNK_BYTES } from "../link/frames.js";
import { bytesTransferSource, type TransferSource } from "../link/transfer.js";
import {
  DOWNLOAD_SINK_PREFIX,
  FileCancelPayloadSchema,
  FileDownloadPayloadSchema,
  FileLinkMethod,
  FilePullPayloadSchema,
  FileRequestPayloadSchema,
  PULL_MAX_BYTES,
  STREAM_SINK_PREFIX,
  type FileDownloadPayload,
  type FileDownloadStart,
  type FilePullPayload,
  type FilePullResult,
  type FileRequestPayload,
  type FileResponse,
} from "./linkMethods.js";

/**
 * The host half of a remote window's file previews and downloads.
 *
 * A preview request is answered by the very handler that serves this
 * machine's own views ({@link serveContainedFileRequest}), so path shape,
 * realpath containment, symlink and size rules, MIME gates and Range handling
 * are the local ones, run here against this machine's files. On top of that,
 * the caller-supplied root must lie inside the project the asking endpoint is
 * attached to (its folder or one of its git worktrees); a Shell can't name an
 * arbitrary root the way a local view can.
 *
 * Streams and downloads belong to the endpoint that opened them and are
 * revoked when it closes, moves to another project, or stops driving it.
 */

export type HostFileEndpoint = Pick<
  ClientEndpoint,
  "endpointId" | "clientId" | "projectId" | "isClosed" | "onClose"
> & { readonly clientEndpointId: string };

export interface HostFileServiceOptions {
  /** Folders a project's previews may be rooted in. */
  rootsFor(projectId: string): Promise<string[]>;
  /**
   * A download outside the project's folders the project may still take (a
   * bundle generated for it). Returns the canonical path when granted.
   */
  grantDownload?(projectId: string, candidate: string): Promise<string | null>;
  isDriving(projectId: string, endpoint: HostFileEndpoint): boolean;
  serve?(scheme: ContainedFileScheme, request: Request): Promise<Response>;
  maxStreamsPerSession?: number;
  maxConcurrentPulls?: number;
  /** A stream nobody pulls for this long is closed. */
  streamIdleMs?: number;
  maxDownloadBytes?: number;
}

const DEFAULT_MAX_STREAMS_PER_SESSION = 32;
const DEFAULT_MAX_CONCURRENT_PULLS = 4;
const DEFAULT_STREAM_IDLE_MS = 60_000;
const DEFAULT_MAX_DOWNLOAD_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_ERROR_TEXT = 1024;

interface SessionFiles {
  session: LinkSession;
  endpoints: Map<string, HostFileEndpoint>;
  streams: Set<string>;
  pulls: number;
  unregister: Array<() => void>;
}

interface HostStream {
  id: string;
  owner: SessionFiles;
  endpoint: HostFileEndpoint;
  projectId: string;
  reader: ReadableStreamDefaultReader<Uint8Array>;
  leftover: Uint8Array | null;
  busy: boolean;
  controller: AbortController;
  idleTimer: ReturnType<typeof setTimeout> | null;
}

interface HostDownload {
  endpoint: HostFileEndpoint;
  projectId: string;
  controller: AbortController;
}

function newId(): string {
  return crypto.randomBytes(16).toString("hex");
}

function errorResponse(status: number, text: string): FileResponse {
  return { status, headers: buildDaintreeFileErrorHeaders(), text, streamId: null };
}

function concat(chunks: Uint8Array[], total: number): Uint8Array {
  if (chunks.length === 1) return chunks[0]!;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

async function isInside(allowedRoot: string, candidate: string): Promise<string | null> {
  const contained = await resolveContainedRealPath(
    path.normalize(allowedRoot),
    path.normalize(candidate)
  );
  return contained instanceof Response ? null : contained.realFile;
}

/**
 * Open the admitted file without following a final-component symlink, check
 * it on the descriptor, then hash and serve every read from that same
 * descriptor, so a swap after admission can't substitute another file.
 * `close` is idempotent.
 */
async function openDownloadSource(
  realPath: string,
  maxBytes: number
): Promise<TransferSource & { close(): Promise<void> }> {
  let handle: Awaited<ReturnType<typeof fs.open>>;
  try {
    handle = await fs.open(realPath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  } catch {
    throw new AppError({ code: "NOT_FOUND", message: "The file could not be opened" });
  }
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    await handle.close().catch(() => {});
  };
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) {
      throw new AppError({ code: "NOT_A_FILE", message: "Only files can be downloaded" });
    }
    if (stat.size > maxBytes) {
      throw new AppError({
        code: "PAYLOAD_TOO_LARGE",
        message: "File is too large to download",
        userMessage: "That file is too large to download from the host.",
      });
    }
    const hash = crypto.createHash("sha256");
    const buf = Buffer.allocUnsafe(BULK_CHUNK_BYTES);
    for (let offset = 0; offset < stat.size;) {
      const { bytesRead } = await handle.read(buf, 0, buf.byteLength, offset);
      if (bytesRead === 0) break;
      hash.update(buf.subarray(0, bytesRead));
      offset += bytesRead;
    }
    return {
      size: stat.size,
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
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}

export class HostFileService {
  private readonly sessions = new WeakMap<LinkSession, SessionFiles>();
  private readonly streams = new Map<string, HostStream>();
  private readonly downloads = new Set<HostDownload>();
  private readonly endpointSubscriptions = new Map<string, { dispose(): void }>();
  private disposed = false;

  constructor(private readonly options: HostFileServiceOptions) {}

  /** Serve this endpoint's file calls on `session` (its current link). Idempotent. */
  attach(session: LinkSession, endpoint: HostFileEndpoint): void {
    if (this.disposed) return;
    const files = this.sessionFiles(session);
    files.endpoints.set(endpoint.clientEndpointId, endpoint);
    if (!this.endpointSubscriptions.has(endpoint.endpointId)) {
      this.endpointSubscriptions.set(
        endpoint.endpointId,
        endpoint.onClose(() => {
          this.endpointSubscriptions.delete(endpoint.endpointId);
          this.revokeWhere((entry) => entry.endpoint === endpoint);
          files.endpoints.delete(endpoint.clientEndpointId);
        })
      );
    }
  }

  /**
   * Whether `candidate` lies in the project's folder or one of its worktrees:
   * the only roots a remote endpoint of that project may name to the host's
   * own file readers.
   */
  async holdsRoot(projectId: string, candidate: string): Promise<boolean> {
    if (this.disposed) return false;
    for (const root of await this.options.rootsFor(projectId)) {
      if ((await isInside(root, candidate)) !== null) return true;
    }
    return false;
  }

  /** An endpoint moved project or closed: whatever it opened for the old one is revoked. */
  onEndpointsChanged(): void {
    this.revokeWhere(
      (entry) => entry.endpoint.isClosed() || entry.endpoint.projectId !== entry.projectId
    );
  }

  /** The drive lease moved: an endpoint that no longer drives the project loses its reads. */
  onLeaseChanged(projectId: string): void {
    this.revokeWhere(
      (entry) => entry.projectId === projectId && !this.options.isDriving(projectId, entry.endpoint)
    );
  }

  get openStreams(): number {
    return this.streams.size;
  }

  get activeDownloads(): number {
    return this.downloads.size;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.revokeWhere(() => true);
    for (const subscription of this.endpointSubscriptions.values()) subscription.dispose();
    this.endpointSubscriptions.clear();
  }

  private sessionFiles(session: LinkSession): SessionFiles {
    const existing = this.sessions.get(session);
    if (existing) return existing;
    const created: SessionFiles = {
      session,
      endpoints: new Map(),
      streams: new Set(),
      pulls: 0,
      unregister: [],
    };
    created.unregister.push(
      session.registerCallHandler(FileLinkMethod.REQUEST, FileRequestPayloadSchema, (payload) =>
        this.handleRequest(created, payload)
      ),
      session.registerCallHandler(FileLinkMethod.PULL, FilePullPayloadSchema, (payload) =>
        this.handlePull(created, payload)
      ),
      session.registerCallHandler(
        FileLinkMethod.CANCEL,
        FileCancelPayloadSchema,
        ({ streamId }) => {
          const stream = this.streams.get(streamId);
          if (stream && stream.owner === created) this.closeStream(stream);
          return null;
        }
      ),
      session.registerCallHandler(FileLinkMethod.DOWNLOAD, FileDownloadPayloadSchema, (payload) =>
        this.handleDownload(created, payload)
      ),
      session.onClose(() => {
        for (const dispose of created.unregister.splice(0)) dispose();
        this.revokeWhere((entry) => "owner" in entry && entry.owner === created);
      })
    );
    this.sessions.set(session, created);
    return created;
  }

  /**
   * The first of the Shell's endpoints that is attached to a project, drives
   * it, and whose project holds `candidate`; with the canonical path found.
   */
  private async admit(
    files: SessionFiles,
    endpointIds: readonly string[],
    candidate: string,
    grant?: (projectId: string, candidate: string) => Promise<string | null>
  ): Promise<
    | { endpoint: HostFileEndpoint; projectId: string; realPath: string }
    | { refused: "not-found" | "driven-elsewhere" }
  > {
    let drivenElsewhere = false;
    for (const id of endpointIds) {
      const endpoint = files.endpoints.get(id);
      const projectId = endpoint?.projectId ?? null;
      if (!endpoint || endpoint.isClosed() || projectId === null) continue;
      if (!this.options.isDriving(projectId, endpoint)) {
        drivenElsewhere = true;
        continue;
      }
      for (const root of await this.options.rootsFor(projectId)) {
        const realPath = await isInside(root, candidate);
        if (realPath !== null) return { endpoint, projectId, realPath };
      }
      const granted = grant ? await grant(projectId, candidate) : null;
      if (granted !== null) return { endpoint, projectId, realPath: granted };
    }
    return { refused: drivenElsewhere ? "driven-elsewhere" : "not-found" };
  }

  /** Whether what was admitted still holds after the awaits that followed admission. */
  private stillAdmitted(
    files: SessionFiles,
    endpoint: HostFileEndpoint,
    projectId: string
  ): boolean {
    return (
      !this.disposed &&
      files.session.isOpen &&
      this.sessions.get(files.session) === files &&
      !endpoint.isClosed() &&
      endpoint.projectId === projectId &&
      this.options.isDriving(projectId, endpoint)
    );
  }

  private async handleRequest(
    files: SessionFiles,
    payload: FileRequestPayload
  ): Promise<FileResponse> {
    if (payload.root.includes("\0") || !path.isAbsolute(payload.root)) {
      return errorResponse(400, "Invalid path");
    }
    const admitted = await this.admit(files, payload.endpointIds, payload.root);
    if ("refused" in admitted) {
      return admitted.refused === "driven-elsewhere"
        ? errorResponse(403, "Forbidden")
        : errorResponse(404, "Not Found");
    }

    const request = new Request(buildContainedFileUrl(payload.scheme, payload.path, payload.root), {
      method: payload.method,
      headers: payload.range ? { range: payload.range } : {},
    });
    const response = await (this.options.serve ?? serveContainedFileRequest)(
      payload.scheme,
      request
    );
    if (!this.stillAdmitted(files, admitted.endpoint, admitted.projectId)) {
      await response.body?.cancel().catch(() => {});
      return errorResponse(403, "Forbidden");
    }
    const headers: Record<string, string> = {};
    response.headers.forEach((value, key) => {
      headers[key] = value;
    });

    if (payload.method === "HEAD" || response.body === null || response.status >= 300) {
      const text = response.status >= 400 ? (await response.text()).slice(0, MAX_ERROR_TEXT) : null;
      if (text === null) await response.body?.cancel().catch(() => {});
      return { status: response.status, headers, text, streamId: null };
    }

    if (
      files.streams.size >= (this.options.maxStreamsPerSession ?? DEFAULT_MAX_STREAMS_PER_SESSION)
    ) {
      await response.body.cancel().catch(() => {});
      return errorResponse(503, "Too many open previews");
    }
    const stream: HostStream = {
      id: newId(),
      owner: files,
      endpoint: admitted.endpoint,
      projectId: admitted.projectId,
      reader: response.body.getReader(),
      leftover: null,
      busy: false,
      controller: new AbortController(),
      idleTimer: null,
    };
    this.streams.set(stream.id, stream);
    files.streams.add(stream.id);
    this.touch(stream);
    return { status: response.status, headers, text: null, streamId: stream.id };
  }

  private async handlePull(files: SessionFiles, payload: FilePullPayload): Promise<FilePullResult> {
    const stream = this.streams.get(payload.streamId);
    if (!stream || stream.owner !== files) {
      throw new AppError({ code: "NOT_FOUND", message: "The preview stream is closed" });
    }
    if (stream.busy) {
      throw new AppError({
        code: "VALIDATION",
        message: "A pull is already running on this stream",
      });
    }
    if (files.pulls >= (this.options.maxConcurrentPulls ?? DEFAULT_MAX_CONCURRENT_PULLS)) {
      throw new AppError({ code: "RATE_LIMITED", message: "Too many preview reads in flight" });
    }
    stream.busy = true;
    files.pulls++;
    if (stream.idleTimer) clearTimeout(stream.idleTimer);
    stream.idleTimer = null;
    try {
      const limit = Math.min(payload.maxBytes, PULL_MAX_BYTES);
      const chunks: Uint8Array[] = [];
      let total = 0;
      let done = false;
      while (total < limit) {
        let chunk = stream.leftover;
        stream.leftover = null;
        if (!chunk) {
          const next = await stream.reader.read();
          if (next.done) {
            done = true;
            break;
          }
          chunk = next.value;
        }
        const room = limit - total;
        if (chunk.byteLength > room) {
          stream.leftover = chunk.subarray(room);
          chunk = chunk.subarray(0, room);
        }
        chunks.push(chunk);
        total += chunk.byteLength;
      }
      if (this.streams.get(stream.id) !== stream) {
        throw new AppError({ code: "CANCELLED", message: "The preview stream was revoked" });
      }
      if (total > 0) {
        await files.session.transfers.send(bytesTransferSource(concat(chunks, total)), {
          name: "preview",
          destination: { kind: "path", path: `${STREAM_SINK_PREFIX}${payload.token}` },
          signal: stream.controller.signal,
        });
      }
      if (done) this.closeStream(stream);
      return { bytes: total, done };
    } catch (error) {
      this.closeStream(stream);
      throw error;
    } finally {
      stream.busy = false;
      files.pulls--;
      if (this.streams.get(stream.id) === stream) this.touch(stream);
    }
  }

  private async handleDownload(
    files: SessionFiles,
    payload: FileDownloadPayload
  ): Promise<FileDownloadStart> {
    if (payload.hostPath.includes("\0") || !path.isAbsolute(payload.hostPath)) {
      throw new AppError({ code: "INVALID_PATH", message: "The path must be absolute" });
    }
    const admitted = await this.admit(
      files,
      payload.endpointIds,
      payload.hostPath,
      this.options.grantDownload?.bind(this.options)
    );
    if ("refused" in admitted) {
      throw admitted.refused === "driven-elsewhere"
        ? new AppError({
            code: "DRIVEN_ELSEWHERE",
            message: "Another window drives this project",
            userMessage: "Another window is driving this project. Take it over to download.",
          })
        : new AppError({
            code: "NOT_FOUND",
            message: "No such file in the project",
            userMessage: "That file isn't in this project on the host.",
          });
    }
    const source = await openDownloadSource(
      admitted.realPath,
      this.options.maxDownloadBytes ?? DEFAULT_MAX_DOWNLOAD_BYTES
    );
    if (!this.stillAdmitted(files, admitted.endpoint, admitted.projectId)) {
      await source.close();
      throw new AppError({ code: "CANCELLED", message: "The download was revoked" });
    }
    const download: HostDownload = {
      endpoint: admitted.endpoint,
      projectId: admitted.projectId,
      controller: new AbortController(),
    };
    this.downloads.add(download);
    const name = path.basename(admitted.realPath);
    void files.session.transfers
      .send(source, {
        name,
        destination: { kind: "path", path: `${DOWNLOAD_SINK_PREFIX}${payload.token}` },
        signal: download.controller.signal,
      })
      .catch((error: unknown) => {
        logWarn("remote.files.download-failed", {
          code: error instanceof AppError ? error.code : "INTERNAL",
        });
      })
      // A send refused before it started never took ownership of the source.
      .finally(() => {
        this.downloads.delete(download);
        void source.close();
      });
    return { name, size: source.size };
  }

  private touch(stream: HostStream): void {
    if (stream.idleTimer) clearTimeout(stream.idleTimer);
    stream.idleTimer = setTimeout(
      () => this.closeStream(stream),
      this.options.streamIdleMs ?? DEFAULT_STREAM_IDLE_MS
    );
    stream.idleTimer.unref?.();
  }

  private closeStream(stream: HostStream): void {
    if (this.streams.get(stream.id) !== stream) return;
    this.streams.delete(stream.id);
    stream.owner.streams.delete(stream.id);
    if (stream.idleTimer) clearTimeout(stream.idleTimer);
    stream.idleTimer = null;
    stream.controller.abort();
    void stream.reader.cancel().catch(() => {});
  }

  private revokeWhere(match: (entry: HostStream | HostDownload) => boolean): void {
    for (const stream of [...this.streams.values()]) {
      if (match(stream)) this.closeStream(stream);
    }
    for (const download of [...this.downloads]) {
      if (match(download)) {
        this.downloads.delete(download);
        download.controller.abort();
      }
    }
  }
}
