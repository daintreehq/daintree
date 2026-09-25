import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { UPLOAD_REFUSE_BYTES } from "../../../shared/types/remoteHosts.js";
import { AppError } from "../../utils/errorTypes.js";
import { BULK_CHUNK_BYTES } from "../link/frames.js";
import type { TransferBeginMessage } from "../link/messages.js";
import type { LinkSession } from "../link/session.js";
import type { TransferSink } from "../link/transfer.js";
import { componentsBelow, openDirectoryBeneath, type HeldDirectory } from "./hostContainment.js";
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
 *
 * Add to project walks from the project folder one component at a time and
 * creates, replaces and cleans up only through the folder that walk holds
 * ({@link openDirectoryBeneath}), so swapping any folder on the way for a
 * symlink can't move the write out of the project. A file already there is
 * replaced only with the replace token the host issued when it reported the
 * clash, for that same file, unchanged. What each operation placed is kept
 * for a while, so a retry after a lost acknowledgement is answered from the
 * record instead of placing (or replacing) again.
 */

export interface HostUploadServiceOptions {
  /** Folders a project's uploads may be added to (Add to project). */
  rootsFor(projectId: string): Promise<string[]>;
  isDriving(projectId: string, endpoint: HostFileEndpoint): boolean;
  /** The project's current drive lease, which a replace token is bound to; null when none. */
  leaseIdFor?(projectId: string): number | null;
  inbox: HostInbox;
  maxUploadBytes?: number;
  /** Bytes free for a new file in `dir`, or null when unknown. */
  freeBytes?(dir: string): Promise<number | null>;
  pendingTtlMs?: number;
  maxPendingPerSession?: number;
  /** How long a replace token stays usable after the clash was reported. */
  replaceTokenTtlMs?: number;
  /** How long what an operation placed is remembered for its retries. */
  outcomeTtlMs?: number;
  /** How long a retry waits for the same operation's placement still under way. */
  retryWaitMs?: number;
}

/** What a file in the project was when its clash was reported. */
interface FileIdentity {
  dev: bigint;
  ino: bigint;
  size: bigint;
  mtimeNs: bigint;
}

interface ReplaceGrant {
  clientId: string;
  endpointId: string;
  projectId: string;
  leaseId: number | null;
  folderDev: bigint;
  folderIno: bigint;
  name: string;
  identity: FileIdentity;
  /** The content the clash was reported for: only these bytes may replace the file. */
  sha256: string;
  expiresAt: number;
  /** The operation now using it; a token serves one operation. */
  reservedBy: string | null;
}

/** One operation, by the Shell that minted its id. */
interface OperationRecord {
  fingerprint: string;
  /** `preparing` holds the id while its prepare runs, so a concurrent one can't claim it too. */
  state: "preparing" | "prepared" | "placing" | "committed";
  /** The prepare token while `prepared`, and the link it was issued on. */
  pendingToken: string | null;
  pendingIn: SessionUploads | null;
  hostPath: string | null;
  bytes: number;
  expiresAt: number;
  settled: Promise<void>;
  settle(): void;
}

type PreparedDestination =
  | { kind: "inbox"; bucket: "clipboard" | "files" }
  | {
      kind: "worktree";
      /** The folder as the Shell spelled it; returned paths use this spelling. */
      directory: string;
      /** Where the walk to it starts, and the components below that. */
      folder: FolderRoute;
      folderDev: bigint;
      folderIno: bigint;
      name: string;
      /** Replacing the file the conflict reported, under this token. */
      replace: { token: string; identity: FileIdentity; leaseId: number | null } | null;
    };

interface FolderRoute {
  anchor: string;
  components: string[];
  anchorSpellings: string[];
}

interface PendingUpload {
  opId: string;
  opKey: string;
  endpoint: HostFileEndpoint;
  projectId: string;
  name: string;
  size: number;
  sha256: string;
  destination: PreparedDestination;
  /** The project's drive lease when admitted: a takeover voids the upload. */
  leaseId: number | null;
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
const DEFAULT_REPLACE_TOKEN_TTL_MS = 10 * 60_000;
const MAX_REPLACE_GRANTS = 256;
const DEFAULT_OUTCOME_TTL_MS = 15 * 60_000;
const MAX_OUTCOMES = 1_000;
const DEFAULT_RETRY_WAIT_MS = 30_000;
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

function identityOf(stat: {
  dev: bigint;
  ino: bigint;
  size: bigint;
  mtimeNs: bigint;
}): FileIdentity {
  return { dev: stat.dev, ino: stat.ino, size: stat.size, mtimeNs: stat.mtimeNs };
}

function sameIdentity(a: FileIdentity, b: FileIdentity): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeNs === b.mtimeNs;
}

/** `name` in the held folder as lstat sees it, or null when nothing is there. */
async function lstatEntry(folder: HeldDirectory, name: string) {
  await folder.verify();
  const stat = await fs.lstat(folder.entry(name), { bigint: true }).catch(() => null);
  await folder.verify();
  return stat;
}

function fingerprintOf(projectId: string, payload: UploadPreparePayload): string {
  const destination =
    payload.destination.kind === "inbox"
      ? `inbox:${payload.destination.bucket}`
      : `worktree:${path.normalize(payload.destination.directory)}`;
  return JSON.stringify([projectId, payload.name, payload.size, payload.sha256, destination]);
}

function operationInUse(): AppError {
  return new AppError({
    code: "VALIDATION",
    message: "That operation id already belongs to a different upload",
  });
}

export class HostUploadService {
  private readonly sessions = new WeakMap<LinkSession, SessionUploads>();
  private readonly subscriptions = new Map<string, { dispose(): void }>();
  private readonly replaceGrants = new Map<string, ReplaceGrant>();
  /** By Shell client and operation id. */
  private readonly operations = new Map<string, OperationRecord>();
  private readonly inFlight = new Set<{
    projectId: string;
    leaseId: number | null;
    stop(): void;
  }>();
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
            if (pending.endpoint === endpoint) this.dropPending(uploads, token);
          }
          for (const [token, grant] of this.replaceGrants) {
            if (grant.endpointId === endpoint.endpointId) this.replaceGrants.delete(token);
          }
        })
      );
    }
  }

  /** The project's drive lease changed: uploads admitted under the old one stop. */
  onLeaseChanged(projectId: string): void {
    const current = this.leaseIdFor(projectId);
    for (const upload of this.inFlight) {
      if (upload.projectId === projectId && upload.leaseId !== current) upload.stop();
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const subscription of this.subscriptions.values()) subscription.dispose();
    this.subscriptions.clear();
    this.replaceGrants.clear();
    for (const record of this.operations.values()) record.settle();
    this.operations.clear();
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
        for (const token of [...created.pending.keys()]) this.dropPending(created, token);
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
      this.options.isDriving(pending.projectId, pending.endpoint) &&
      this.leaseIdFor(pending.projectId) === pending.leaseId
    );
  }

  private async hasRoom(dir: string, size: number): Promise<boolean> {
    const free = await (this.options.freeBytes ?? defaultFreeBytes)(dir);
    return free === null || free >= size + FREE_SPACE_MARGIN_BYTES;
  }

  private leaseIdFor(projectId: string): number | null {
    return this.options.leaseIdFor?.(projectId) ?? null;
  }

  /**
   * Walk to the folder `directory` names from one of the project's folders,
   * and hold it. The walk never passes through a symlink that leaves the
   * project, and every later step acts through what it holds.
   */
  private async openFolder(
    projectId: string,
    directory: string
  ): Promise<{ route: FolderRoute; held: HeldDirectory } | "not-a-directory" | null> {
    if (!path.isAbsolute(directory) || directory.includes("\0")) return null;
    let wrongKind = false;
    for (const root of await this.options.rootsFor(projectId)) {
      const anchor = await fs.realpath(root).catch(() => null);
      if (anchor === null) continue;
      const normalized = path.normalize(root);
      const anchorSpellings = normalized === anchor ? [] : [normalized];
      for (const spelling of new Set([normalized, anchor])) {
        const components = componentsBelow(spelling, directory);
        if (components === null) continue;
        const route = { anchor, components, anchorSpellings };
        const held = await this.reopenFolder(route);
        if (held === "not-a-directory") wrongKind = true;
        else if (held !== null) return { route, held };
      }
    }
    return wrongKind ? "not-a-directory" : null;
  }

  private reopenFolder(route: FolderRoute): Promise<HeldDirectory | "not-a-directory" | null> {
    return openDirectoryBeneath(route.anchor, route.components, route.anchorSpellings);
  }

  private opKey(endpoint: HostFileEndpoint, opId: string): string {
    return `${endpoint.clientId}\0${opId}`;
  }

  /** A record that never settles (its link or sink vanished without a word) is dropped after this. */
  private abandonAfterMs(): number {
    return this.options.outcomeTtlMs ?? DEFAULT_OUTCOME_TTL_MS;
  }

  private expireOperations(): void {
    const now = Date.now();
    for (const [key, record] of this.operations) {
      // A placement still running holds its id until its sink settles (the
      // transfer layer's inactivity timeout guarantees that it does).
      if (record.state !== "placing" && record.expiresAt <= now) this.forgetOperation(key, record);
    }
    // Bounded: the oldest settled outcomes go first.
    for (const [key, record] of this.operations) {
      if (this.operations.size <= MAX_OUTCOMES) break;
      if (record.state === "committed") this.operations.delete(key);
    }
  }

  private forgetOperation(key: string, record: OperationRecord): void {
    if (this.operations.get(key) === record) this.operations.delete(key);
    record.settle();
  }

  /**
   * A retry of an operation this Shell already started: its recorded
   * outcome, "fresh" when nothing of it stands, or "busy" while the first
   * attempt is still placing its file.
   */
  private async priorOutcome(
    key: string,
    fingerprint: string
  ): Promise<UploadPrepareResult | "fresh"> {
    this.expireOperations();
    let record = this.operations.get(key);
    if (!record) return "fresh";
    if (record.fingerprint !== fingerprint) throw operationInUse();
    if (record.state === "preparing") return { status: "refused", reason: "busy" };
    if (record.state === "placing") {
      const waited = await Promise.race([
        record.settled.then(() => true),
        new Promise<false>((resolve) => {
          const timer = setTimeout(
            () => resolve(false),
            this.options.retryWaitMs ?? DEFAULT_RETRY_WAIT_MS
          );
          timer.unref?.();
        }),
      ]);
      if (!waited) return { status: "refused", reason: "busy" };
      record = this.operations.get(key);
      if (!record) return "fresh";
      if (record.fingerprint !== fingerprint) throw operationInUse();
      if (record.state === "preparing") return { status: "refused", reason: "busy" };
    }
    if (record.state === "committed" && record.hostPath !== null) {
      return { status: "done", hostPath: record.hostPath, bytes: record.bytes };
    }
    // Prepared but never sent: start over under the same id.
    if (record.pendingToken !== null && record.pendingIn !== null) {
      this.dropPending(record.pendingIn, record.pendingToken);
    }
    this.forgetOperation(key, record);
    return "fresh";
  }

  private issueReplaceGrant(grant: Omit<ReplaceGrant, "expiresAt" | "reservedBy">): string {
    const now = Date.now();
    for (const [token, existing] of this.replaceGrants) {
      if (existing.expiresAt <= now) this.replaceGrants.delete(token);
    }
    while (this.replaceGrants.size >= MAX_REPLACE_GRANTS) {
      const oldest = this.replaceGrants.keys().next().value;
      if (oldest === undefined) break;
      this.replaceGrants.delete(oldest);
    }
    const token = crypto.randomBytes(16).toString("hex");
    this.replaceGrants.set(token, {
      ...grant,
      expiresAt: now + (this.options.replaceTokenTtlMs ?? DEFAULT_REPLACE_TOKEN_TTL_MS),
      reservedBy: null,
    });
    return token;
  }

  /** The grant `token` names, when it was issued for exactly this replacement. */
  private matchingGrant(
    token: string,
    request: {
      endpoint: HostFileEndpoint;
      projectId: string;
      opId: string;
      held: HeldDirectory;
      name: string;
      identity: FileIdentity;
      sha256: string;
    }
  ): ReplaceGrant | null {
    const grant = this.replaceGrants.get(token);
    if (!grant) return null;
    if (grant.expiresAt <= Date.now()) {
      this.replaceGrants.delete(token);
      return null;
    }
    const matches =
      (grant.reservedBy === null || grant.reservedBy === request.opId) &&
      grant.clientId === request.endpoint.clientId &&
      grant.endpointId === request.endpoint.endpointId &&
      grant.projectId === request.projectId &&
      grant.leaseId === this.leaseIdFor(request.projectId) &&
      grant.folderDev === request.held.dev &&
      grant.folderIno === request.held.ino &&
      grant.name === request.name &&
      grant.sha256 === request.sha256 &&
      sameIdentity(grant.identity, request.identity);
    return matches ? grant : null;
  }

  private async prepare(
    uploads: SessionUploads,
    payload: UploadPreparePayload
  ): Promise<UploadPrepareResult> {
    if (this.disposed) throw notInProject();
    const { endpoint, projectId } = this.admit(uploads, payload.endpointId);
    const opKey = this.opKey(endpoint, payload.opId);
    const fingerprint = fingerprintOf(projectId, payload);
    const prior = await this.priorOutcome(opKey, fingerprint);
    if (prior !== "fresh") return prior;
    // Claimed in the same turn as the check: a concurrent prepare under this
    // id now finds it and waits, whatever it asks for.
    const clash = this.operations.get(opKey);
    if (clash) {
      if (clash.fingerprint !== fingerprint) throw operationInUse();
      return { status: "refused", reason: "busy" };
    }
    let settle!: () => void;
    const settled = new Promise<void>((resolve) => {
      settle = resolve;
    });
    const record: OperationRecord = {
      fingerprint,
      state: "preparing",
      pendingToken: null,
      pendingIn: null,
      hostPath: null,
      bytes: 0,
      // A prepare stuck on the filesystem must not hold the id forever.
      expiresAt: Date.now() + this.abandonAfterMs(),
      settled,
      settle,
    };
    this.operations.set(opKey, record);
    let result: UploadPrepareResult | null = null;
    try {
      result = await this.prepareClaimed(uploads, payload, endpoint, projectId, opKey, record);
      return result;
    } finally {
      if (result?.status !== "ready") this.forgetOperation(opKey, record);
    }
  }

  private async prepareClaimed(
    uploads: SessionUploads,
    payload: UploadPreparePayload,
    endpoint: HostFileEndpoint,
    projectId: string,
    opKey: string,
    record: OperationRecord
  ): Promise<UploadPrepareResult> {
    // The wait above may have outlived the endpoint's claim on the project.
    this.admit(uploads, payload.endpointId);
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
      const { directory, replaceToken } = payload.destination;
      const opened = await this.openFolder(projectId, directory);
      if (opened === null) return { status: "refused", reason: "outside-project" };
      if (opened === "not-a-directory") return { status: "refused", reason: "not-a-directory" };
      const { route, held } = opened;
      try {
        const name = sanitizeInboxName(payload.name);
        const existing = await lstatEntry(held, name);
        let replace: { token: string; identity: FileIdentity; leaseId: number | null } | null =
          null;
        if (existing) {
          if (!existing.isFile()) return { status: "refused", reason: "not-a-file" };
          const identity = identityOf(existing);
          const grant =
            replaceToken === undefined
              ? null
              : this.matchingGrant(replaceToken, {
                  endpoint,
                  projectId,
                  opId: payload.opId,
                  held,
                  name,
                  identity,
                  sha256: payload.sha256,
                });
          if (!grant || replaceToken === undefined) {
            // Asked afresh, or the file changed (or the token doesn't fit):
            // report the clash as it stands now, with a token for exactly it.
            return {
              status: "conflict",
              hostPath: path.join(directory, name),
              replaceToken: this.issueReplaceGrant({
                clientId: endpoint.clientId,
                endpointId: endpoint.endpointId,
                projectId,
                leaseId: this.leaseIdFor(projectId),
                folderDev: held.dev,
                folderIno: held.ino,
                name,
                identity,
                sha256: payload.sha256,
              }),
            };
          }
          grant.reservedBy = payload.opId;
          replace = { token: replaceToken, identity, leaseId: grant.leaseId };
        } else if (replaceToken !== undefined) {
          // The file it named is gone: this becomes a plain add, and the token is spent.
          this.replaceGrants.delete(replaceToken);
        }
        if (
          !(await this.hasRoom(this.options.inbox.root, payload.size)) ||
          !(await this.hasRoom(held.canonicalPath, payload.size))
        ) {
          if (replace) this.releaseGrant(replace.token, payload.opId);
          return { status: "refused", reason: "no-space" };
        }
        destination = {
          kind: "worktree",
          directory,
          folder: route,
          folderDev: held.dev,
          folderIno: held.ino,
          name,
          replace,
        };
      } finally {
        await held.close();
      }
    }

    // The link may have closed (or the endpoint lost the project) while the
    // checks above ran; its close already swept pending uploads, so record none.
    if (this.disposed || !uploads.session.isOpen) throw notInProject();
    // Expired while it ran: the id is no longer this prepare's to use.
    if (this.operations.get(opKey) !== record) return { status: "refused", reason: "busy" };
    this.admit(uploads, payload.endpointId);
    const token = crypto.randomBytes(16).toString("hex");
    record.state = "prepared";
    record.expiresAt = Date.now() + this.abandonAfterMs();
    record.pendingToken = token;
    record.pendingIn = uploads;
    uploads.pending.set(token, {
      opId: payload.opId,
      opKey,
      endpoint,
      projectId,
      name: payload.name,
      size: payload.size,
      sha256: payload.sha256,
      destination,
      leaseId: this.leaseIdFor(projectId),
      expiresAt: Date.now() + (this.options.pendingTtlMs ?? DEFAULT_PENDING_TTL_MS),
    });
    return { status: "ready", token };
  }

  private releaseGrant(token: string, opId: string): void {
    const grant = this.replaceGrants.get(token);
    if (grant && grant.reservedBy === opId) grant.reservedBy = null;
  }

  /** Forget a prepared upload that will never be sent, and what it held. */
  private dropPending(uploads: SessionUploads, token: string): void {
    const pending = uploads.pending.get(token);
    if (!pending) return;
    uploads.pending.delete(token);
    if (pending.destination.kind === "worktree" && pending.destination.replace) {
      this.releaseGrant(pending.destination.replace.token, pending.opId);
    }
    const record = this.operations.get(pending.opKey);
    if (record && record.pendingToken === token) this.forgetOperation(pending.opKey, record);
  }

  private expirePending(uploads: SessionUploads): void {
    const now = Date.now();
    for (const [token, pending] of uploads.pending) {
      if (pending.expiresAt <= now) this.dropPending(uploads, token);
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
    const record = this.operations.get(pending.opKey);
    const failed = () => {
      if (pending.destination.kind === "worktree" && pending.destination.replace) {
        this.releaseGrant(pending.destination.replace.token, pending.opId);
      }
      if (record) this.forgetOperation(pending.opKey, record);
    };
    if (begin.size !== pending.size || begin.sha256 !== pending.sha256) {
      failed();
      throw new Error("The transfer does not match the prepared upload");
    }
    if (!this.stillAdmitted(uploads, pending)) {
      failed();
      throw new Error("The upload is no longer admitted");
    }
    if (record) {
      record.state = "placing";
      record.pendingToken = null;
      record.pendingIn = null;
      record.expiresAt = Date.now() + this.abandonAfterMs();
    }

    const inbox = this.options.inbox;
    let part: Awaited<ReturnType<HostInbox["createPart"]>>;
    try {
      part = await inbox.createPart();
    } catch (error) {
      failed();
      throw error;
    }
    let written = 0;
    let closed = false;
    let aborted = false;
    let committing = false;
    // A takeover of the project stops this upload where it stands.
    const inFlight = {
      projectId: pending.projectId,
      leaseId: pending.leaseId,
      stop: () => {
        aborted = true;
      },
    };
    this.inFlight.add(inFlight);
    let settledOutcome = false;
    let placed: string | null = null;
    /** The project folder the file went into, held until the transfer settles. */
    let placedIn: HeldDirectory | null = null;
    /** What this upload wrote there, so cleanup never removes someone else's file. */
    let placedFile: { dev: bigint; ino: bigint } | null = null;
    // A placed file can be taken back unless it replaced one the user already had.
    const removable = pending.destination.kind === "inbox" || !pending.destination.replace;
    const removePlaced = async () => {
      if (placed === null || !removable) return;
      const target = pending.destination;
      if (target.kind === "worktree") {
        if (placedIn === null || placedFile === null) return;
        try {
          const there = await lstatEntry(placedIn, target.name);
          if (!there || there.dev !== placedFile.dev || there.ino !== placedFile.ino) return;
          await fs.rm(placedIn.entry(target.name), { force: true });
        } catch {
          // The folder no longer names what was held; leave it rather than guess.
        }
        return;
      }
      await fs.rm(placed, { force: true }).catch(() => {});
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
    const settleOutcome = (hostPath: string | null) => {
      if (settledOutcome) return;
      settledOutcome = true;
      this.inFlight.delete(inFlight);
      if (pending.destination.kind === "worktree" && pending.destination.replace) {
        const { token: grantToken } = pending.destination.replace;
        if (hostPath !== null) this.replaceGrants.delete(grantToken);
        else this.releaseGrant(grantToken, pending.opId);
      }
      if (!record) return;
      if (hostPath === null) {
        this.forgetOperation(pending.opKey, record);
        return;
      }
      record.state = "committed";
      record.hostPath = hostPath;
      record.bytes = pending.size;
      record.expiresAt = Date.now() + (this.options.outcomeTtlMs ?? DEFAULT_OUTCOME_TTL_MS);
      record.settle();
      this.expireOperations();
    };

    const placeInWorktree = async (
      target: Extract<PreparedDestination, { kind: "worktree" }>
    ): Promise<string> => {
      // Walked again from the project folder: the folder must be the very one
      // the prepare approved, and everything below goes through what this
      // walk holds, never a path a swapped folder could redirect.
      const folder = await this.reopenFolder(target.folder);
      if (folder === null || folder === "not-a-directory") {
        throw new Error("The folder moved during the upload");
      }
      placedIn = folder;
      if (folder.dev !== target.folderDev || folder.ino !== target.folderIno) {
        throw new Error("The folder moved during the upload");
      }
      // The bytes go into a temporary entry of our own first, so a failure
      // never touches the final name, and only that entry is ever cleaned up.
      const tempName = `.${target.name.slice(0, 100)}.daintree-upload-${token.slice(0, 8)}`;
      const source = await fs.open(part.path, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      let tempExists = false;
      try {
        await folder.verify();
        const out = await fs.open(folder.entry(tempName), NEW_FILE_FLAGS, PROJECT_FILE_MODE);
        tempExists = true;
        try {
          await folder.verify();
          if ((await copyInto(source, out)) !== pending.size) throw new Error("Short copy");
          const written = await out.stat({ bigint: true });
          placedFile = { dev: written.dev, ino: written.ino };
        } finally {
          await out.close().catch(() => {});
        }
        if (aborted) throw new Error("cancelled");
        await folder.verify();
        // Published only by the endpoint still driving under the lease it was admitted in.
        if (!this.stillAdmitted(uploads, pending)) {
          throw new Error("The project changed hands during the upload");
        }
        if (!target.replace) {
          // link() never replaces: a file that appeared under the name meanwhile stays.
          let linked = true;
          try {
            await fs.link(folder.entry(tempName), folder.entry(target.name));
          } catch (error) {
            const code = (error as NodeJS.ErrnoException).code;
            if (code === "EEXIST") {
              throw new Error("A file with that name appeared during the upload", {
                cause: error,
              });
            }
            if (code !== "EPERM" && code !== "ENOTSUP" && code !== "EOPNOTSUPP") throw error;
            linked = false;
          }
          if (!linked) {
            // No hard links on this filesystem: create the name exclusively and copy.
            const final = await fs.open(
              folder.entry(target.name),
              NEW_FILE_FLAGS,
              PROJECT_FILE_MODE
            );
            const created = await final.stat({ bigint: true });
            placedFile = { dev: created.dev, ino: created.ino };
            let copied = -1;
            try {
              copied = await copyInto(source, final);
            } catch {
              // Reported below as a short copy, after the partial file is gone.
            } finally {
              await final.close().catch(() => {});
            }
            if (copied !== pending.size) {
              await folder
                .verify()
                .then(() => fs.rm(folder.entry(target.name), { force: true }))
                .catch(() => {});
              throw new Error("Short copy");
            }
          }
        } else {
          // Only the file the user agreed to replace, still there and exactly as it
          // was, under the drive lease the replacement was confirmed in.
          const existing = await lstatEntry(folder, target.name);
          if (!existing || !existing.isFile()) {
            throw new Error("The file to replace is no longer there");
          }
          if (!sameIdentity(identityOf(existing), target.replace.identity)) {
            throw new Error("The file changed after the replacement was confirmed");
          }
          if (this.leaseIdFor(pending.projectId) !== target.replace.leaseId) {
            throw new Error("The project changed hands after the replacement was confirmed");
          }
          if (aborted || !this.stillAdmitted(uploads, pending)) throw new Error("cancelled");
          await folder.verify();
          await fs.rename(folder.entry(tempName), folder.entry(target.name));
          tempExists = false;
        }
        await folder.verify();
      } finally {
        await source.close().catch(() => {});
        if (tempExists) {
          await folder
            .verify()
            .then(() => fs.rm(folder.entry(tempName), { force: true }))
            .catch(() => {});
        }
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
        let outcome: string | null = null;
        committing = true;
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
          if (aborted && removable) {
            await removePlaced();
            throw new Error("cancelled");
          }
          // A replacement can't be taken back; it stands, and a retry is told where it went.
          outcome = placed;
          if (aborted) throw new Error("cancelled");
          return placed;
        } finally {
          settleOutcome(outcome);
          await placedIn?.close();
          await discardPart();
          void inbox.cleanup();
        }
      },
      async abort() {
        aborted = true;
        await discardPart();
        await removePlaced();
        // A commit under way settles the operation itself, once it knows what stands.
        if (!committing) settleOutcome(null);
      },
    };
  }
}
