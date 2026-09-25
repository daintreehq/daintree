import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { UPLOAD_REFUSE_BYTES } from "../../../shared/types/remoteHosts.js";
import { AppError } from "../../utils/errorTypes.js";
import { BULK_CHUNK_BYTES } from "../link/frames.js";
import type { TransferBeginMessage } from "../link/messages.js";
import type { LinkSession } from "../link/session.js";
import type { TransferSink } from "../link/transfer.js";
import { componentsBelow } from "./hostContainment.js";
import type { HostFileEndpoint } from "./HostFileService.js";
import { HostInbox, sanitizeInboxName } from "./hostInbox.js";
import {
  UPLOAD_SINK_PREFIX,
  UploadLinkMethod,
  UploadPreparePayloadSchema,
  type UploadPreparePayload,
  type UploadPrepareResult,
} from "./uploadLinkMethods.js";

/**
 * The host half of uploads from remote windows. A prepared upload is bound to
 * the asking endpoint, its project and the exact size and sha256 announced;
 * the bytes that follow must match all of it, and are only placed once the
 * transfer layer has verified the checksum. A part file is discarded on abort
 * or timeout, including one that times out while it is being placed.
 */

export interface HostUploadServiceOptions {
  /** Folders a project's uploads may be added to (Add to project). */
  rootsFor(projectId: string): Promise<string[]>;
  isDriving(projectId: string, endpoint: HostFileEndpoint): boolean;
  inbox: HostInbox;
  maxUploadBytes?: number;
  /** Bytes free for a new file in `dir`, or null when unknown. */
  freeBytes?(dir: string): Promise<number | null>;
  pendingTtlMs?: number;
  maxPendingPerSession?: number;
}

type PreparedDestination =
  | { kind: "inbox"; bucket: "clipboard" | "files" }
  | {
      kind: "worktree";
      /** The folder as the Shell spelled it; returned paths use this spelling. */
      directory: string;
      realDirectory: string;
      name: string;
      overwrite: boolean;
    };

interface PendingUpload {
  endpoint: HostFileEndpoint;
  projectId: string;
  name: string;
  size: number;
  sha256: string;
  destination: PreparedDestination;
  expiresAt: number;
}

interface SessionUploads {
  session: LinkSession;
  endpoints: Map<string, HostFileEndpoint>;
  pending: Map<string, PendingUpload>;
  unregister: Array<() => void>;
}

const DEFAULT_PENDING_TTL_MS = 60_000;
const DEFAULT_MAX_PENDING_PER_SESSION = 16;
/** Kept free on the host's disk beyond the file itself. */
const FREE_SPACE_MARGIN_BYTES = 64 * 1024 * 1024;

async function defaultFreeBytes(dir: string): Promise<number | null> {
  try {
    const stats = await fs.statfs(dir);
    return Number(stats.bavail) * Number(stats.bsize);
  } catch {
    return null;
  }
}

function isUploadDestination(begin: TransferBeginMessage): boolean {
  const destination = begin.destination;
  return destination.kind === "path" && destination.path.startsWith(UPLOAD_SINK_PREFIX);
}

function notInProject(): AppError {
  return new AppError({
    code: "NOT_FOUND",
    message: "The asking view is not attached to a project on this host",
  });
}

async function copyInto(
  source: Awaited<ReturnType<typeof fs.open>>,
  target: Awaited<ReturnType<typeof fs.open>>
): Promise<number> {
  const buf = Buffer.allocUnsafe(BULK_CHUNK_BYTES);
  let position = 0;
  for (;;) {
    const { bytesRead } = await source.read(buf, 0, buf.byteLength, position);
    if (bytesRead === 0) break;
    for (let offset = 0; offset < bytesRead;) {
      const { bytesWritten } = await target.write(
        buf,
        offset,
        bytesRead - offset,
        position + offset
      );
      if (bytesWritten <= 0) throw new Error("The file could not be written");
      offset += bytesWritten;
    }
    position += bytesRead;
  }
  await target.sync();
  return position;
}

const NEW_FILE_FLAGS =
  fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW;
/** Files added to a project are ordinary repository files, not private temp data. */
const PROJECT_FILE_MODE = 0o644;

interface OpenedFolder {
  /** The path to use for `name` inside the opened folder. */
  entry(name: string): string;
  /** Throws unless the folder's path still names the folder that was opened. */
  verify(): Promise<void>;
  close(): Promise<void>;
}

/** Hold the approved folder open, so later steps act on it and not on whatever its path names now. */
async function openFolder(realDirectory: string): Promise<OpenedFolder> {
  const handle = await fs.open(
    realDirectory,
    fs.constants.O_RDONLY | (fs.constants.O_DIRECTORY ?? 0) | fs.constants.O_NOFOLLOW
  );
  const held = await handle.stat({ bigint: true });
  const viaProc =
    process.platform === "linux" &&
    (await fs.access(`/proc/self/fd/${handle.fd}`).then(
      () => true,
      () => false
    ));
  return {
    entry: (name) =>
      viaProc ? `/proc/self/fd/${handle.fd}/${name}` : path.join(realDirectory, name),
    async verify() {
      if (viaProc) return;
      const named = await fs.lstat(realDirectory, { bigint: true }).catch(() => null);
      if (!named || named.isSymbolicLink() || named.dev !== held.dev || named.ino !== held.ino) {
        throw new Error("The folder changed during the upload");
      }
    },
    close: () => handle.close().catch(() => {}),
  };
}

export class HostUploadService {
  private readonly sessions = new WeakMap<LinkSession, SessionUploads>();
  private readonly subscriptions = new Map<string, { dispose(): void }>();
  private disposed = false;

  constructor(private readonly options: HostUploadServiceOptions) {}

  /** Accept this endpoint's uploads on `session` (its current link). Idempotent. */
  attach(session: LinkSession, endpoint: HostFileEndpoint): void {
    if (this.disposed) return;
    const uploads = this.sessionUploads(session);
    uploads.endpoints.set(endpoint.clientEndpointId, endpoint);
    if (!this.subscriptions.has(endpoint.endpointId)) {
      this.subscriptions.set(
        endpoint.endpointId,
        endpoint.onClose(() => {
          this.subscriptions.delete(endpoint.endpointId);
          uploads.endpoints.delete(endpoint.clientEndpointId);
          for (const [token, pending] of uploads.pending) {
            if (pending.endpoint === endpoint) uploads.pending.delete(token);
          }
        })
      );
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const subscription of this.subscriptions.values()) subscription.dispose();
    this.subscriptions.clear();
  }

  private sessionUploads(session: LinkSession): SessionUploads {
    const existing = this.sessions.get(session);
    if (existing) return existing;
    const created: SessionUploads = {
      session,
      endpoints: new Map(),
      pending: new Map(),
      unregister: [],
    };
    created.unregister.push(
      session.registerCallHandler(UploadLinkMethod.PREPARE, UploadPreparePayloadSchema, (payload) =>
        this.prepare(created, payload)
      ),
      // Beside the project bundle provider on the same session, never instead of it.
      session.transfers.addSinkProvider((begin) =>
        isUploadDestination(begin) ? this.createSink(created, begin) : null
      ),
      session.onClose(() => {
        for (const dispose of created.unregister.splice(0)) dispose();
        created.pending.clear();
      })
    );
    this.sessions.set(session, created);
    return created;
  }

  private admit(
    uploads: SessionUploads,
    endpointId: string
  ): { endpoint: HostFileEndpoint; projectId: string } {
    const endpoint = uploads.endpoints.get(endpointId);
    const projectId = endpoint?.projectId ?? null;
    if (!endpoint || endpoint.isClosed() || projectId === null) throw notInProject();
    if (!this.options.isDriving(projectId, endpoint)) {
      throw new AppError({
        code: "DRIVEN_ELSEWHERE",
        message: "Another window drives this project",
        userMessage: "Another window is driving this project. Take it over to add files.",
      });
    }
    return { endpoint, projectId };
  }

  private stillAdmitted(uploads: SessionUploads, pending: PendingUpload): boolean {
    return (
      !this.disposed &&
      uploads.session.isOpen &&
      !pending.endpoint.isClosed() &&
      pending.endpoint.projectId === pending.projectId &&
      this.options.isDriving(pending.projectId, pending.endpoint)
    );
  }

  private async hasRoom(dir: string, size: number): Promise<boolean> {
    const free = await (this.options.freeBytes ?? defaultFreeBytes)(dir);
    return free === null || free >= size + FREE_SPACE_MARGIN_BYTES;
  }

  /** The real folder `directory` names, when it lies in one of the project's folders. */
  private async locateDirectory(projectId: string, directory: string): Promise<string | null> {
    if (!path.isAbsolute(directory) || directory.includes("\0")) return null;
    const real = await fs.realpath(directory).catch(() => null);
    if (real === null) return null;
    for (const root of await this.options.rootsFor(projectId)) {
      const realRoot = await fs.realpath(root).catch(() => null);
      if (realRoot !== null && componentsBelow(realRoot, real) !== null) return real;
    }
    return null;
  }

  private async prepare(
    uploads: SessionUploads,
    payload: UploadPreparePayload
  ): Promise<UploadPrepareResult> {
    if (this.disposed) throw notInProject();
    const { endpoint, projectId } = this.admit(uploads, payload.endpointId);
    if (payload.size > (this.options.maxUploadBytes ?? UPLOAD_REFUSE_BYTES)) {
      return { status: "refused", reason: "too-large" };
    }
    this.expirePending(uploads);
    if (
      uploads.pending.size >= (this.options.maxPendingPerSession ?? DEFAULT_MAX_PENDING_PER_SESSION)
    ) {
      return { status: "refused", reason: "busy" };
    }

    let destination: PreparedDestination;
    if (payload.destination.kind === "inbox") {
      const { bucket } = payload.destination;
      await this.options.inbox.ensure();
      const duplicate = await this.options.inbox.findDuplicate(
        bucket,
        payload.name,
        payload.sha256,
        payload.size
      );
      if (duplicate) return { status: "duplicate", hostPath: duplicate };
      if (!(await this.hasRoom(this.options.inbox.root, payload.size))) {
        return { status: "refused", reason: "no-space" };
      }
      destination = { kind: "inbox", bucket };
    } else {
      const { directory, overwrite } = payload.destination;
      const realDirectory = await this.locateDirectory(projectId, directory);
      if (realDirectory === null) return { status: "refused", reason: "outside-project" };
      const dirStat = await fs.stat(realDirectory).catch(() => null);
      if (!dirStat?.isDirectory()) return { status: "refused", reason: "not-a-directory" };
      const name = sanitizeInboxName(payload.name);
      const existing = await fs.lstat(path.join(realDirectory, name)).catch(() => null);
      if (existing) {
        if (!existing.isFile()) return { status: "refused", reason: "not-a-file" };
        if (!overwrite) return { status: "conflict", hostPath: path.join(directory, name) };
      }
      if (
        !(await this.hasRoom(this.options.inbox.root, payload.size)) ||
        !(await this.hasRoom(realDirectory, payload.size))
      ) {
        return { status: "refused", reason: "no-space" };
      }
      destination = { kind: "worktree", directory, realDirectory, name, overwrite };
    }

    const token = crypto.randomBytes(16).toString("hex");
    uploads.pending.set(token, {
      endpoint,
      projectId,
      name: payload.name,
      size: payload.size,
      sha256: payload.sha256,
      destination,
      expiresAt: Date.now() + (this.options.pendingTtlMs ?? DEFAULT_PENDING_TTL_MS),
    });
    return { status: "ready", token };
  }

  private expirePending(uploads: SessionUploads): void {
    const now = Date.now();
    for (const [token, pending] of uploads.pending) {
      if (pending.expiresAt <= now) uploads.pending.delete(token);
    }
  }

  private async createSink(
    uploads: SessionUploads,
    begin: TransferBeginMessage
  ): Promise<TransferSink> {
    const destination = begin.destination;
    if (destination.kind !== "path" || !destination.path.startsWith(UPLOAD_SINK_PREFIX)) {
      throw new Error("Unexpected transfer destination");
    }
    const token = destination.path.slice(UPLOAD_SINK_PREFIX.length);
    this.expirePending(uploads);
    const pending = uploads.pending.get(token);
    if (!pending) throw new Error("No upload was prepared for this destination");
    uploads.pending.delete(token);
    if (begin.size !== pending.size || begin.sha256 !== pending.sha256) {
      throw new Error("The transfer does not match the prepared upload");
    }
    if (!this.stillAdmitted(uploads, pending)) throw new Error("The upload is no longer admitted");

    const inbox = this.options.inbox;
    const part = await inbox.createPart();
    let written = 0;
    let closed = false;
    let aborted = false;
    let placed: string | null = null;
    // A placed file can be taken back unless it replaced one the user already had.
    const removable = pending.destination.kind === "inbox" || !pending.destination.overwrite;
    const removePlaced = async () => {
      if (placed === null || !removable) return;
      const target = pending.destination;
      const onDisk =
        target.kind === "worktree" ? path.join(target.realDirectory, target.name) : placed;
      await fs.rm(onDisk, { force: true }).catch(() => {});
    };
    const close = async () => {
      if (closed) return;
      closed = true;
      await part.handle.close().catch(() => {});
    };
    const discardPart = async () => {
      await close();
      await fs.rm(part.path, { force: true }).catch(() => {});
      inbox.releasePart(part.path);
    };

    const placeInWorktree = async (
      target: Extract<PreparedDestination, { kind: "worktree" }>
    ): Promise<string> => {
      const real = await fs.realpath(target.directory).catch(() => null);
      if (real !== target.realDirectory) throw new Error("The folder moved during the upload");
      // Everything below goes through the folder the checks approved, never a
      // path a swapped directory could redirect: openat through /proc on Linux,
      // and elsewhere a re-check that the path still names that very folder.
      const folder = await openFolder(target.realDirectory);
      const entry = (name: string) => folder.entry(name);
      const source = await fs.open(part.path, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      try {
        if (!target.overwrite) {
          await folder.verify();
          const out = await fs.open(entry(target.name), NEW_FILE_FLAGS, PROJECT_FILE_MODE);
          try {
            await folder.verify();
            if ((await copyInto(source, out)) !== pending.size) throw new Error("Short copy");
          } catch (error) {
            await out.close().catch(() => {});
            await fs.rm(entry(target.name), { force: true }).catch(() => {});
            throw error;
          }
          await out.close();
        } else {
          const tempName = `.${target.name.slice(0, 100)}.daintree-upload-${token.slice(0, 8)}`;
          await folder.verify();
          const out = await fs.open(entry(tempName), NEW_FILE_FLAGS, PROJECT_FILE_MODE);
          try {
            if ((await copyInto(source, out)) !== pending.size) throw new Error("Short copy");
            await out.close();
            const existing = await fs.lstat(entry(target.name)).catch(() => null);
            if (existing && !existing.isFile()) throw new Error("Only a file can be replaced");
            await folder.verify();
            if (aborted) throw new Error("cancelled");
            await fs.rename(entry(tempName), entry(target.name));
          } catch (error) {
            await out.close().catch(() => {});
            await fs.rm(entry(tempName), { force: true }).catch(() => {});
            throw error;
          }
        }
      } finally {
        await source.close().catch(() => {});
        await folder.close();
      }
      return path.join(target.directory, target.name);
    };

    return {
      async write(chunk) {
        if (aborted) throw new Error("cancelled");
        // A write may take fewer bytes than offered; count only what reached the file.
        for (let offset = 0; offset < chunk.byteLength;) {
          const { bytesWritten } = await part.handle.write(
            chunk,
            offset,
            chunk.byteLength - offset,
            written
          );
          if (bytesWritten <= 0) throw new Error("The upload could not be written");
          offset += bytesWritten;
          written += bytesWritten;
        }
      },
      commit: async () => {
        try {
          await part.handle.sync();
          const size = (await part.handle.stat()).size;
          await close();
          if (size !== written || written !== pending.size) {
            throw new Error("The saved upload is not the size that was sent");
          }
          if (aborted || !this.stillAdmitted(uploads, pending)) throw new Error("cancelled");
          const target = pending.destination;
          if (target.kind === "inbox") {
            placed = await inbox.place(target.bucket, part.path, pending.name, pending.sha256);
          } else {
            placed = await placeInWorktree(target);
          }
          // Timed out while placing: the Shell was told it failed, so it must not stay.
          if (aborted) {
            await removePlaced();
            throw new Error("cancelled");
          }
          return placed;
        } finally {
          await discardPart();
          void inbox.cleanup();
        }
      },
      async abort() {
        aborted = true;
        await discardPart();
        await removePlaced();
      },
    };
  }
}
