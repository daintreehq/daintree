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
import { PREVIEW_REFUSAL_HEADER, type PreviewRefusal } from "../../../shared/types/ipc/files.js";
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
  FileGrantClickedPayloadSchema,
  FileLinkMethod,
  FilePullPayloadSchema,
  FileRequestPayloadSchema,
  PULL_MAX_BYTES,
  STREAM_SINK_PREFIX,
  type FileDownloadPayload,
  type FileDownloadStart,
  type FileGrantClickedPayload,
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
 * same endpoint and project ({@link HostFileService.recordBundle}), and a file it
 * uploaded into the host inbox itself, which it may also preview and read
 * ({@link HostFileService.recordUpload}), and a file the person clicked a link
 * to in one of the view's terminals ({@link HostFileService.grantClicked}).
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
  isDriving(
    projectId: string,
    endpoint: Pick<HostFileEndpoint, "endpointId" | "clientId">
  ): boolean;
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
  /** How long a view's own inbox upload stays readable by it. */
  uploadTtlMs?: number;
  /** How long a file the person clicked stays readable by the view. */
  clickedTtlMs?: number;
}

const DEFAULT_MAX_STREAMS_PER_SESSION = 32;
const DEFAULT_MAX_CONCURRENT_PULLS = 4;
const DEFAULT_MAX_REQUESTS_PER_SESSION = 8;
const DEFAULT_MAX_BUFFERED_BYTES = 128 * 1024 * 1024;
const DEFAULT_MAX_DOWNLOADS_PER_SESSION = 2;
const DEFAULT_STREAM_IDLE_MS = 60_000;
const DEFAULT_MAX_DOWNLOAD_BYTES = 2 * 1024 * 1024 * 1024;
const DEFAULT_BUNDLE_TTL_MS = 10 * 60 * 1000;
// The inbox keeps an upload for a day, so its uploader's grant lasts as long.
const DEFAULT_UPLOAD_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_BUNDLES_PER_ENDPOINT = 8;
const MAX_UPLOADS_PER_ENDPOINT = 64;
// Long enough to read the file, reopen the dialog or pin it as a panel; a
// click on the same link again starts it over.
const DEFAULT_CLICKED_TTL_MS = 60 * 60 * 1000;
const MAX_CLICKED_PER_ENDPOINT = 64;
const MAX_GRANT_ENDPOINTS = 256;
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
  /** Pulls the Shell may have in flight at once; above one, they name their sequence. */
  depth: number;
  /** Pulls running now: reading, or waiting for their slice to be acknowledged. */
  pulling: number;
  /** Settles when the pull in front has read its slice: reads never overlap. */
  turn: Promise<void>;
  nextSequence: number;
  /** The body has been read to its end. */
  ended: boolean;
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

/**
 * A file as it was recorded. Device and inode alone aren't enough: a file
 * deleted and written again at the same path can get the same inode number
 * back (Linux reuses them freely), but never the same change time.
 */
type FileIdentity = { dev: bigint; ino: bigint; size: bigint; mtimeNs: bigint; ctimeNs: bigint };

function identityOf(stats: import("node:fs").BigIntStats): FileIdentity {
  return {
    dev: stats.dev,
    ino: stats.ino,
    size: stats.size,
    mtimeNs: stats.mtimeNs,
    ctimeNs: stats.ctimeNs,
  };
}

function sameFile(a: FileIdentity, b: FileIdentity): boolean {
  return (
    a.dev === b.dev &&
    a.ino === b.ino &&
    a.size === b.size &&
    a.mtimeNs === b.mtimeNs &&
    a.ctimeNs === b.ctimeNs
  );
}

interface RecordedBundle {
  projectId: string;
  expiresAt: number;
  /** The file CopyTree wrote, as it was when recorded: a file put in its place later isn't it. */
  identity: Promise<FileIdentity | null>;
}

/**
 * An inbox upload as it was placed. Not its times: the inbox touches them when
 * another upload of the same bytes reuses the file, and that mustn't revoke
 * the first uploader's read.
 */
export type UploadIdentity = { dev: bigint; ino: bigint; size: bigint };

interface RecordedUpload {
  projectId: string;
  expiresAt: number;
  identity: Promise<UploadIdentity | null>;
}

/**
 * A file the person opened from a terminal link. Held by path, not identity:
 * what they asked to see is whatever file is at that path, so a log that grows
 * or a file an editor saves over stays readable on refresh.
 */
interface RecordedClick {
  projectId: string;
  expiresAt: number;
}

function isUpload(stats: import("node:fs").BigIntStats, identity: UploadIdentity): boolean {
  return (
    stats.isFile() &&
    stats.dev === identity.dev &&
    stats.ino === identity.ino &&
    stats.size === identity.size
  );
}

interface Located {
  anchor: string;
  components: string[];
  /** Other spellings of the anchor an absolute symlink target may use (e.g. /tmp for /private/tmp). */
  anchorSpellings?: string[];
  /** For a recorded file: whether the opened file is still the one recorded. */
  isRecorded?: (stats: import("node:fs").BigIntStats) => boolean;
}

function newId(): string {
  return crypto.randomBytes(16).toString("hex");
}

function errorResponse(status: number, text: string, refusal?: PreviewRefusal): FileResponse {
  const headers: Record<string, string> = buildDaintreeFileErrorHeaders();
  if (refusal) headers[PREVIEW_REFUSAL_HEADER] = refusal;
  return { status, headers, text, streamId: null };
}

/** Keep one entry per key, newest last, dropping the oldest past `max`. */
function boundedSet<K, V>(map: Map<K, V>, key: K, value: V, max: number): void {
  map.delete(key);
  if (map.size >= max) map.delete(map.keys().next().value!);
  map.set(key, value);
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
  /** Host endpoint id → the inbox files it uploaded itself, by exact path. */
  private readonly uploads = new Map<string, Map<string, RecordedUpload>>();
  /** Host endpoint id → the files the person clicked in its terminals, by exact path. */
  private readonly clicked = new Map<string, Map<string, RecordedClick>>();
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
          this.uploads.delete(endpoint.endpointId);
          this.clicked.delete(endpoint.endpointId);
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
    const key = path.normalize(filePath);
    const identity = fs
      .lstat(key, { bigint: true })
      .then((stats): FileIdentity | null => (stats.isFile() ? identityOf(stats) : null))
      .catch(() => null);
    boundedSet(
      this.grantsFor(this.bundles, endpoint.endpointId),
      key,
      {
        projectId: endpoint.projectId,
        expiresAt: Date.now() + (this.options.bundleTtlMs ?? DEFAULT_BUNDLE_TTL_MS),
        identity,
      },
      MAX_BUNDLES_PER_ENDPOINT
    );
  }

  /**
   * A view uploaded this file into the host inbox for its project. That exact
   * file, and nothing else in the inbox (which holds every Shell's uploads),
   * becomes previewable, readable and downloadable by the same endpoint while
   * it stays on that project.
   */
  recordUpload(
    endpoint: Pick<HostFileEndpoint, "endpointId" | "projectId" | "isClosed">,
    projectId: string,
    filePath: string
  ): void {
    // An endpoint that closed or moved while the upload was placed gets nothing.
    if (this.disposed || endpoint.isClosed() || endpoint.projectId !== projectId) return;
    if (!isRequestPath(filePath)) return;
    const key = path.normalize(filePath);
    const identity = fs
      .lstat(key, { bigint: true })
      .then((stats): UploadIdentity | null =>
        stats.isFile() ? { dev: stats.dev, ino: stats.ino, size: stats.size } : null
      )
      .catch(() => null);
    boundedSet(
      this.grantsFor(this.uploads, endpoint.endpointId),
      key,
      {
        projectId,
        expiresAt: Date.now() + (this.options.uploadTtlMs ?? DEFAULT_UPLOAD_TTL_MS),
        identity,
      },
      MAX_UPLOADS_PER_ENDPOINT
    );
  }

  /**
   * The identity of `filePath` when it is a file this endpoint uploaded for
   * its current project and is still the very file it placed, else null: what
   * lets a text read reach it outside the project's folders. The reader holds
   * the descriptor it opens to this identity, so a file swapped in after this
   * check isn't read.
   */
  async uploadIdentity(
    endpoint: Pick<ClientEndpoint, "endpointId" | "projectId">,
    filePath: string
  ): Promise<UploadIdentity | null> {
    if (this.disposed || !endpoint.projectId || !isRequestPath(filePath)) return null;
    const upload = this.freshUpload(endpoint.endpointId, endpoint.projectId, filePath);
    const identity = upload ? await upload.identity : null;
    if (!identity) return null;
    const stats = await fs.lstat(path.normalize(filePath), { bigint: true }).catch(() => null);
    return stats !== null && isUpload(stats, identity) ? identity : null;
  }

  /**
   * Whether `filePath` is a file the person clicked in one of this endpoint's
   * terminals, for its current project, while it still drives that project:
   * what lets a text read reach it outside the project's folders. Text reads
   * don't otherwise need the lease, but the grant rests on it.
   */
  isClicked(
    endpoint: Pick<ClientEndpoint, "endpointId" | "clientId" | "projectId">,
    filePath: string
  ): boolean {
    if (this.disposed || !endpoint.projectId || !isRequestPath(filePath)) return false;
    if (!this.options.isDriving(endpoint.projectId, endpoint)) return false;
    return this.freshClick(endpoint.endpointId, endpoint.projectId, filePath) !== null;
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
    this.uploads.clear();
    this.clicked.clear();
  }

  private grantsFor<T>(grants: Map<string, Map<string, T>>, endpointId: string): Map<string, T> {
    let recorded = grants.get(endpointId);
    if (!recorded) {
      recorded = new Map();
      boundedSet(grants, endpointId, recorded, MAX_GRANT_ENDPOINTS);
    }
    return recorded;
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
          // The Shell's own cancel: nothing to tell it.
          if (stream && stream.owner === created) this.closeStream(stream, false);
          return null;
        }
      ),
      session.registerCallHandler(FileLinkMethod.DOWNLOAD, FileDownloadPayloadSchema, (payload) =>
        this.handleDownload(created, payload)
      ),
      session.registerCallHandler(
        FileLinkMethod.GRANT_CLICKED,
        FileGrantClickedPayloadSchema,
        (payload) => this.grantClicked(created, payload)
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
    const identity = await bundle.identity;
    if (identity === null) return null;
    const anchor = await fs.realpath(path.dirname(key)).catch(() => null);
    return anchor === null
      ? null
      : {
          anchor,
          components: [path.basename(key)],
          isRecorded: (stats) => sameFile(identityOf(stats), identity),
        };
  }

  /** The upload this endpoint recorded for this project at exactly this path, if still fresh. */
  private freshUpload(
    endpointId: string,
    projectId: string,
    hostPath: string
  ): RecordedUpload | null {
    const recorded = this.uploads.get(endpointId);
    const key = path.normalize(hostPath);
    const upload = recorded?.get(key);
    if (!upload) return null;
    if (upload.expiresAt <= Date.now()) {
      recorded!.delete(key);
      return null;
    }
    return upload.projectId === projectId ? upload : null;
  }

  /** Where to open the inbox file this endpoint uploaded for this project at exactly this path. */
  private async locateUpload(
    endpointId: string,
    projectId: string,
    hostPath: string,
    within?: string
  ): Promise<Located | null> {
    const upload = this.freshUpload(endpointId, projectId, hostPath);
    const key = path.normalize(hostPath);
    if (!upload) return null;
    if (within !== undefined && componentsBelow(within, key) === null) return null;
    const identity = await upload.identity;
    if (identity === null) return null;
    const anchor = await fs.realpath(path.dirname(key)).catch(() => null);
    return anchor === null
      ? null
      : {
          anchor,
          components: [path.basename(key)],
          isRecorded: (stats) => isUpload(stats, identity),
        };
  }

  /**
   * The person clicked a link to this file in a terminal of the asking view.
   * The host can't see the click, only that the view drives its project: a
   * view that drives can already read any file through that project's
   * terminals, so this widens nothing it could reach, only what the viewer
   * shows. Regular files only, never through a link at the last step.
   */
  private async grantClicked(files: SessionFiles, payload: FileGrantClickedPayload): Promise<null> {
    if (!isRequestPath(payload.hostPath)) {
      throw new AppError({ code: "INVALID_PATH", message: "The path must be absolute" });
    }
    const admitted = this.admit(files, payload.endpointId);
    if ("refused" in admitted) {
      throw admitted.refused === "driven-elsewhere"
        ? new AppError({
            code: "DRIVEN_ELSEWHERE",
            message: "Another window drives this project",
            userMessage: "Another window has control of this project. Take control to open files.",
          })
        : notInProject();
    }
    const key = path.normalize(payload.hostPath);
    const stats = await fs.lstat(key).catch(() => null);
    if (!stats?.isFile()) {
      throw new AppError({ code: "NOT_A_FILE", message: "Only files can be opened" });
    }
    if (!this.stillAdmitted(files, admitted.endpoint, admitted.projectId)) throw notInProject();
    boundedSet(
      this.grantsFor(this.clicked, admitted.endpoint.endpointId),
      key,
      {
        projectId: admitted.projectId,
        expiresAt: Date.now() + (this.options.clickedTtlMs ?? DEFAULT_CLICKED_TTL_MS),
      },
      MAX_CLICKED_PER_ENDPOINT
    );
    return null;
  }

  /** The click this endpoint recorded for this project at exactly this path, if still fresh. */
  private freshClick(
    endpointId: string,
    projectId: string,
    hostPath: string
  ): RecordedClick | null {
    const recorded = this.clicked.get(endpointId);
    const key = path.normalize(hostPath);
    const click = recorded?.get(key);
    if (!click) return null;
    if (click.expiresAt <= Date.now()) {
      recorded!.delete(key);
      return null;
    }
    return click.projectId === projectId ? click : null;
  }

  /**
   * Where to open the file the person clicked in this endpoint's terminals at
   * exactly this path. The walk would follow a link that stays in the folder,
   * so the opened file must be the very file the path names now: a link put
   * in its place never reaches a file beside it.
   */
  private async locateClicked(
    endpointId: string,
    projectId: string,
    hostPath: string,
    within?: string
  ): Promise<Located | null> {
    if (!this.freshClick(endpointId, projectId, hostPath)) return null;
    const key = path.normalize(hostPath);
    if (within !== undefined && componentsBelow(within, key) === null) return null;
    const named = await fs.lstat(key, { bigint: true }).catch(() => null);
    if (!named?.isFile()) return null;
    const anchor = await fs.realpath(path.dirname(key)).catch(() => null);
    return anchor === null
      ? null
      : {
          anchor,
          components: [path.basename(key)],
          isRecorded: (stats) =>
            stats.isFile() && stats.dev === named.dev && stats.ino === named.ino,
        };
  }

  /** Close what was opened for a recorded file that isn't that file any more. */
  private async stillRecorded(
    located: Located,
    opened: { handle: OpenedHostFile }
  ): Promise<boolean> {
    if (!located.isRecorded) return true;
    const now = await opened.handle.stat({ bigint: true }).catch(() => null);
    if (now && located.isRecorded(now)) return true;
    await opened.handle.close().catch(() => {});
    return false;
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
          ? errorResponse(403, "Forbidden", "driven-elsewhere")
          : errorResponse(404, "Not Found");
      }
      const located =
        (await this.locate(admitted.projectId, payload.path, payload.root)) ??
        // A clicked file before an upload: an upload grant whose file was
        // replaced since would otherwise refuse a click on the same path.
        (await this.locateClicked(
          admitted.endpoint.endpointId,
          admitted.projectId,
          payload.path,
          payload.root
        )) ??
        (await this.locateUpload(
          admitted.endpoint.endpointId,
          admitted.projectId,
          payload.path,
          payload.root
        ));
      if (!located) return errorResponse(404, "Not Found", "outside-project");
      const opened = await openBeneath(located.anchor, located.components, located.anchorSpellings);
      if (!opened || opened === "not-a-file") return errorResponse(404, "Not Found");
      if (!(await this.stillRecorded(located, opened))) return errorResponse(404, "Not Found");

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
        return this.options.isDriving(admitted.projectId, admitted.endpoint)
          ? errorResponse(403, "Forbidden")
          : errorResponse(403, "Forbidden", "driven-elsewhere");
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
        depth: Math.min(
          payload.pullDepth ?? 1,
          this.options.maxConcurrentPulls ?? DEFAULT_MAX_CONCURRENT_PULLS
        ),
        pulling: 0,
        turn: Promise.resolve(),
        nextSequence: 0,
        ended: false,
        controller: new AbortController(),
        idleTimer: null,
        release,
      };
      handedOff = true;
      this.streams.set(stream.id, stream);
      files.streams.add(stream.id);
      this.touch(stream);
      return {
        status: response.status,
        headers,
        text: null,
        streamId: stream.id,
        ...(payload.pullDepth !== undefined ? { pullDepth: stream.depth } : {}),
      };
    } finally {
      files.requests--;
      files.pendingStreams--;
      if (!handedOff) release();
    }
  }

  /**
   * The next slice of a stream, sent as its own verified transfer; answered
   * once the Shell has acknowledged it. A stream read with several pulls in
   * flight reads its slices strictly in the order the pulls arrived (each
   * names its sequence), while their transfers overlap, so the next slice is
   * already crossing the link while the last one waits for its acknowledgement.
   */
  private async handlePull(files: SessionFiles, payload: FilePullPayload): Promise<FilePullResult> {
    const stream = this.streams.get(payload.streamId);
    if (!stream || stream.owner !== files) {
      throw new AppError({ code: "NOT_FOUND", message: "The preview stream is closed" });
    }
    if (stream.pulling >= stream.depth) {
      throw new AppError({
        code: "VALIDATION",
        message:
          stream.depth === 1
            ? "A pull is already running on this stream"
            : "Too many pulls in flight on this stream",
      });
    }
    if (stream.depth > 1 && payload.sequence !== stream.nextSequence) {
      // Slices out of order would reach the preview in the wrong order: fail closed.
      this.closeStream(stream);
      throw new AppError({ code: "VALIDATION", message: "A pull arrived out of order" });
    }
    if (files.pulls >= (this.options.maxConcurrentPulls ?? DEFAULT_MAX_CONCURRENT_PULLS)) {
      throw new AppError({ code: "RATE_LIMITED", message: "Too many preview reads in flight" });
    }
    stream.pulling++;
    stream.nextSequence++;
    files.pulls++;
    if (stream.idleTimer) clearTimeout(stream.idleTimer);
    stream.idleTimer = null;
    const inFront = stream.turn;
    let passTurn!: () => void;
    stream.turn = new Promise<void>((resolve) => {
      passTurn = resolve;
    });
    try {
      await inFront;
      if (this.streams.get(stream.id) !== stream) {
        throw new AppError({ code: "CANCELLED", message: "The preview stream was revoked" });
      }
      // A pull already in flight when the body ran out: nothing more to send.
      if (stream.ended) return { bytes: 0, done: true };
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
      if (done) stream.ended = true;
      passTurn();
      if (total > 0) {
        await files.session.transfers.send(bytesTransferSource(concat(chunks, total)), {
          name: "preview",
          destination: { kind: "path", path: `${STREAM_SINK_PREFIX}${payload.token}` },
          signal: stream.controller.signal,
        });
      }
      // With several pulls in flight the Shell may still hold slices it has
      // not passed on; the stream stays revocable until it cancels or idles out.
      if (done && stream.depth === 1) this.closeStream(stream);
      return { bytes: total, done };
    } catch (error) {
      this.closeStream(stream);
      throw error;
    } finally {
      passTurn();
      stream.pulling--;
      files.pulls--;
      if (this.streams.get(stream.id) === stream && stream.pulling === 0) this.touch(stream);
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
              userMessage: "Another window has control of this project. Take control to download.",
            })
          : notInProject();
      }
      const located =
        (await this.locateBundle(admitted.endpoint, admitted.projectId, payload.hostPath)) ??
        (await this.locate(admitted.projectId, payload.hostPath)) ??
        (await this.locateClicked(
          admitted.endpoint.endpointId,
          admitted.projectId,
          payload.hostPath
        )) ??
        (await this.locateUpload(
          admitted.endpoint.endpointId,
          admitted.projectId,
          payload.hostPath
        ));
      const opened =
        located && (await openBeneath(located.anchor, located.components, located.anchorSpellings));
      if (opened === "not-a-file") {
        throw new AppError({ code: "NOT_A_FILE", message: "Only files can be downloaded" });
      }
      if (!opened || !(await this.stillRecorded(located!, opened))) throw notInProject();
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

  /**
   * End a stream: its transfers abort and its body is let go. A Shell reading
   * with several pulls in flight is told, unless it asked, so it drops the
   * slices it holds instead of passing them on after the stream was revoked.
   */
  private closeStream(stream: HostStream, notifyShell = true): void {
    if (this.streams.get(stream.id) !== stream) return;
    this.streams.delete(stream.id);
    stream.owner.streams.delete(stream.id);
    if (stream.idleTimer) clearTimeout(stream.idleTimer);
    stream.idleTimer = null;
    stream.controller.abort();
    stream.release();
    void stream.reader.cancel().catch(() => {});
    const session = stream.owner.session;
    if (notifyShell && stream.depth > 1 && session.isOpen) {
      void session.call(FileLinkMethod.STREAM_CLOSED, { streamId: stream.id }).catch(() => {});
    }
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
