import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { ClientEndpoint } from "../../ipc/endpoint.js";
import {
  buildContainedFileUrl,
  buildDaintreeFileErrorHeaders,
  resolveContainedRealPath,
  serveOpenedContainedFile,
} from "../../setup/protocols.js";
import { AppError } from "../../utils/errorTypes.js";
import { logWarn } from "../../utils/logger.js";
import type { LinkSession } from "../link/session.js";
import { BULK_CHUNK_BYTES } from "../link/frames.js";
import { bytesTransferSource, type TransferSource } from "../link/transfer.js";
import { componentsBelow, openBeneath, type OpenedHostFile } from "./hostContainment.js";
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
 * Every call names the asking view's own endpoint, and runs under that
 * endpoint's project and drive lease only. The file is reached by walking from
 * the project's folder (or one of its worktrees) one component at a time
 * without following symlinks, and is served from the descriptor that walk
 * opened ({@link openBeneath}), with the local handlers' MIME gates, caps and
 * Range handling ({@link serveOpenedContainedFile}). The only file outside a
 * project a view may download is a CopyTree bundle the host generated for that
 * same endpoint and project ({@link HostFileService.recordBundle}).
 *
 * Capacity (requests, open streams, buffered bytes, downloads) is reserved
 * before any filesystem work and released on every path. Streams and
 * downloads belong to the endpoint that opened them and are revoked when it
 * closes, moves to another project, or stops driving it.
 */

export type HostFileEndpoint = Pick<
  ClientEndpoint,
  "endpointId" | "clientId" | "projectId" | "isClosed" | "onClose"
> & { readonly clientEndpointId: string };

export interface HostFileServiceOptions {
  /** Folders a project's previews may be rooted in. */
  rootsFor(projectId: string): Promise<string[]>;
  isDriving(projectId: string, endpoint: HostFileEndpoint): boolean;
  /** Answers from the opened descriptor; tests substitute it. */
  serve?: typeof serveOpenedContainedFile;
  maxStreamsPerSession?: number;
  maxConcurrentPulls?: number;
  /** Previews being admitted and answered at once, per Shell. */
  maxRequestsPerSession?: number;
  /** Bytes buffered for previews (images, PDFs, text) across every Shell. */
  maxBufferedBytes?: number;
  maxDownloadsPerSession?: number;
  /** A stream nobody pulls for this long is closed. */
  streamIdleMs?: number;
  maxDownloadBytes?: number;
  /** How long a recorded CopyTree bundle stays downloadable. */
  bundleTtlMs?: number;
}

const DEFAULT_MAX_STREAMS_PER_SESSION = 32;
const DEFAULT_MAX_CONCURRENT_PULLS = 4;
const DEFAULT_MAX_REQUESTS_PER_SESSION = 8;
const DEFAULT_MAX_BUFFERED_BYTES = 128 * 1024 * 1024;
const DEFAULT_MAX_DOWNLOADS_PER_SESSION = 2;
const DEFAULT_STREAM_IDLE_MS = 60_000;
const DEFAULT_MAX_DOWNLOAD_BYTES = 2 * 1024 * 1024 * 1024;
const DEFAULT_BUNDLE_TTL_MS = 10 * 60 * 1000;
const MAX_BUNDLES_PER_ENDPOINT = 8;
const MAX_BUNDLE_ENDPOINTS = 256;
const MAX_ERROR_TEXT = 1024;

interface SessionFiles {
  session: LinkSession;
  endpoints: Map<string, HostFileEndpoint>;
  streams: Set<string>;
  pulls: number;
  requests: number;
  pendingStreams: number;
  downloads: number;
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
  /** Returns the buffered bytes this stream's body holds to the shared budget. */
  release(): void;
}

interface HostDownload {
  endpoint: HostFileEndpoint;
  projectId: string;
  controller: AbortController;
}

interface RecordedBundle {
  projectId: string;
  expiresAt: number;
}

interface Located {
  anchor: string;
  components: string[];
  /** Other spellings of the anchor an absolute symlink target may use (e.g. /tmp for /private/tmp). */
  anchorSpellings?: string[];
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

function isRequestPath(candidate: string): boolean {
  return !candidate.includes("\0") && path.isAbsolute(candidate);
}

/**
 * Hash and serve every read from the descriptor the containment walk opened,
 * so nothing is resolved by path after admission. Takes ownership of `handle`;
 * `close` is idempotent.
 */
async function downloadSourceFrom(
  handle: OpenedHostFile,
  maxBytes: number
): Promise<TransferSource & { close(): Promise<void> }> {
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
  /** Host endpoint id → the bundles generated for it, by exact path. */
  private readonly bundles = new Map<string, Map<string, RecordedBundle>>();
  private bufferedBytes = 0;
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
          this.bundles.delete(endpoint.endpointId);
          this.revokeWhere((entry) => entry.endpoint === endpoint);
          files.endpoints.delete(endpoint.clientEndpointId);
        })
      );
    }
  }

  /**
   * A CopyTree bundle was generated for this endpoint's project. That exact
   * file becomes downloadable by the same endpoint, while it stays attached to
   * the same project, for a short while; nothing else in the shared context
   * folder does.
   */
  recordBundle(endpoint: Pick<ClientEndpoint, "endpointId" | "projectId">, filePath: string): void {
    if (this.disposed || !endpoint.projectId || !isRequestPath(filePath)) return;
    let recorded = this.bundles.get(endpoint.endpointId);
    if (!recorded) {
      if (this.bundles.size >= MAX_BUNDLE_ENDPOINTS) {
        this.bundles.delete(this.bundles.keys().next().value!);
      }
      recorded = new Map();
      this.bundles.set(endpoint.endpointId, recorded);
    }
    const key = path.normalize(filePath);
    recorded.delete(key);
    if (recorded.size >= MAX_BUNDLES_PER_ENDPOINT) recorded.delete(recorded.keys().next().value!);
    recorded.set(key, {
      projectId: endpoint.projectId,
      expiresAt: Date.now() + (this.options.bundleTtlMs ?? DEFAULT_BUNDLE_TTL_MS),
    });
  }

  /**
   * Whether `candidate` lies in the project's folder or one of its worktrees:
   * the only roots a remote endpoint of that project may name to the host's
   * own file readers.
   */
  async holdsRoot(projectId: string, candidate: string): Promise<boolean> {
    if (this.disposed) return false;
    for (const root of await this.options.rootsFor(projectId)) {
      const contained = await resolveContainedRealPath(
        path.normalize(root),
        path.normalize(candidate)
      );
      if (!(contained instanceof Response)) return true;
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

  /** Preview bytes held right now against the shared budget. */
  get heldBufferedBytes(): number {
    return this.bufferedBytes;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.revokeWhere(() => true);
    for (const subscription of this.endpointSubscriptions.values()) subscription.dispose();
    this.endpointSubscriptions.clear();
    this.bundles.clear();
  }

  private sessionFiles(session: LinkSession): SessionFiles {
    const existing = this.sessions.get(session);
    if (existing) return existing;
    const created: SessionFiles = {
      session,
      endpoints: new Map(),
      streams: new Set(),
      pulls: 0,
      requests: 0,
      pendingStreams: 0,
      downloads: 0,
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

  /** The asking view's own endpoint, when it is attached to a project it drives. */
  private admit(
    files: SessionFiles,
    endpointId: string
  ):
    | { endpoint: HostFileEndpoint; projectId: string }
    | { refused: "not-found" | "driven-elsewhere" } {
    const endpoint = files.endpoints.get(endpointId);
    const projectId = endpoint?.projectId ?? null;
    if (!endpoint || endpoint.isClosed() || projectId === null) return { refused: "not-found" };
    if (!this.options.isDriving(projectId, endpoint)) return { refused: "driven-elsewhere" };
    return { endpoint, projectId };
  }

  /**
   * Where to walk from to reach `target`: a project folder or worktree that
   * holds it (and `within`, when given, which must itself be in that folder
   * and hold `target`), as spelled by the project or canonically.
   */
  private async locate(
    projectId: string,
    target: string,
    within?: string
  ): Promise<Located | null> {
    if (within !== undefined && componentsBelow(within, target) === null) return null;
    for (const root of await this.options.rootsFor(projectId)) {
      const anchor = await fs.realpath(root).catch(() => null);
      if (anchor === null) continue;
      for (const spelling of new Set([path.normalize(root), anchor])) {
        if (within !== undefined && componentsBelow(spelling, within) === null) continue;
        const components = componentsBelow(spelling, target);
        if (components !== null) {
          const normalized = path.normalize(root);
          return normalized === anchor
            ? { anchor, components }
            : { anchor, components, anchorSpellings: [normalized] };
        }
      }
    }
    return null;
  }

  /** The bundle recorded for exactly this endpoint, project and path, if still fresh. */
  private async locateBundle(
    endpoint: HostFileEndpoint,
    projectId: string,
    hostPath: string
  ): Promise<Located | null> {
    const recorded = this.bundles.get(endpoint.endpointId);
    const key = path.normalize(hostPath);
    const bundle = recorded?.get(key);
    if (!bundle) return null;
    if (bundle.expiresAt <= Date.now()) {
      recorded!.delete(key);
      return null;
    }
    if (bundle.projectId !== projectId) return null;
    const anchor = await fs.realpath(path.dirname(key)).catch(() => null);
    return anchor === null ? null : { anchor, components: [path.basename(key)] };
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
    if (!isRequestPath(payload.root) || !isRequestPath(payload.path)) {
      return errorResponse(400, "Invalid path");
    }
    // Capacity is taken before anything touches the filesystem.
    if (
      this.disposed ||
      files.requests >= (this.options.maxRequestsPerSession ?? DEFAULT_MAX_REQUESTS_PER_SESSION) ||
      files.streams.size + files.pendingStreams >=
        (this.options.maxStreamsPerSession ?? DEFAULT_MAX_STREAMS_PER_SESSION)
    ) {
      return errorResponse(503, "Too many open previews");
    }
    files.requests++;
    files.pendingStreams++;
    let reserved = 0;
    const release = () => {
      this.bufferedBytes -= reserved;
      reserved = 0;
    };
    let handedOff = false;
    try {
      const admitted = this.admit(files, payload.endpointId);
      if ("refused" in admitted) {
        return admitted.refused === "driven-elsewhere"
          ? errorResponse(403, "Forbidden")
          : errorResponse(404, "Not Found");
      }
      const located = await this.locate(admitted.projectId, payload.path, payload.root);
      const opened =
        located && (await openBeneath(located.anchor, located.components, located.anchorSpellings));
      if (!opened || opened === "not-a-file") return errorResponse(404, "Not Found");

      const request = new Request(
        buildContainedFileUrl(payload.scheme, payload.path, payload.root),
        { method: payload.method, headers: payload.range ? { range: payload.range } : {} }
      );
      const maxBuffered = this.options.maxBufferedBytes ?? DEFAULT_MAX_BUFFERED_BYTES;
      const response = await (this.options.serve ?? serveOpenedContainedFile)(
        payload.scheme,
        opened.handle,
        opened.canonicalPath,
        request,
        (bytes) => {
          if (this.bufferedBytes + bytes > maxBuffered) return false;
          this.bufferedBytes += bytes;
          reserved += bytes;
          return true;
        }
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
        const text =
          response.status >= 400 ? (await response.text()).slice(0, MAX_ERROR_TEXT) : null;
        if (text === null) await response.body?.cancel().catch(() => {});
        return { status: response.status, headers, text, streamId: null };
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
        release,
      };
      handedOff = true;
      this.streams.set(stream.id, stream);
      files.streams.add(stream.id);
      this.touch(stream);
      return { status: response.status, headers, text: null, streamId: stream.id };
    } finally {
      files.requests--;
      files.pendingStreams--;
      if (!handedOff) release();
    }
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
    if (!isRequestPath(payload.hostPath)) {
      throw new AppError({ code: "INVALID_PATH", message: "The path must be absolute" });
    }
    if (
      this.disposed ||
      files.downloads >= (this.options.maxDownloadsPerSession ?? DEFAULT_MAX_DOWNLOADS_PER_SESSION)
    ) {
      throw new AppError({
        code: "RATE_LIMITED",
        message: "Too many downloads in flight",
        userMessage:
          "Other downloads from this host are still running. Try again when they finish.",
      });
    }
    files.downloads++;
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      files.downloads--;
    };
    let handedOff = false;
    try {
      const admitted = this.admit(files, payload.endpointId);
      if ("refused" in admitted) {
        throw admitted.refused === "driven-elsewhere"
          ? new AppError({
              code: "DRIVEN_ELSEWHERE",
              message: "Another window drives this project",
              userMessage: "Another window is driving this project. Take it over to download.",
            })
          : notInProject();
      }
      const located =
        (await this.locateBundle(admitted.endpoint, admitted.projectId, payload.hostPath)) ??
        (await this.locate(admitted.projectId, payload.hostPath));
      const opened =
        located && (await openBeneath(located.anchor, located.components, located.anchorSpellings));
      if (opened === "not-a-file") {
        throw new AppError({ code: "NOT_A_FILE", message: "Only files can be downloaded" });
      }
      if (!opened) throw notInProject();
      const source = await downloadSourceFrom(
        opened.handle,
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
      const name = path.basename(opened.canonicalPath);
      handedOff = true;
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
          release();
          void source.close();
        });
      return { name, size: source.size };
    } finally {
      if (!handedOff) release();
    }
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
    stream.release();
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

function notInProject(): AppError {
  return new AppError({
    code: "NOT_FOUND",
    message: "No such file in the project",
    userMessage: "That file isn't in this project on the host.",
  });
}
