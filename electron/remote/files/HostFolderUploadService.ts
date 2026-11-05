import crypto from "node:crypto";
import fs from "node:fs/promises";
import type { FolderUploadProblem } from "../../../shared/types/folderUpload.js";
import {
  checkFolderUploadRootName,
  checkFolderUploadTotals,
} from "../../../shared/utils/folderUpload.js";
import { AppError } from "../../utils/errorTypes.js";
import { logWarn } from "../../utils/logger.js";
import type { TransferBeginMessage } from "../link/messages.js";
import type { LinkSession } from "../link/session.js";
import type { TransferSink } from "../link/transfer.js";
import { unpackFolderArchive } from "./folderArchiveUnpack.js";
import {
  FOLDER_UPLOAD_SINK_PREFIX,
  FolderUploadLinkMethod,
  FolderUploadOperationPayloadSchema,
  FolderUploadPreparePayloadSchema,
  type FolderUploadCancelResult,
  type FolderUploadFailureReason,
  type FolderUploadOperationPayload,
  type FolderUploadPreparePayload,
  type FolderUploadPrepareResult,
  type FolderUploadStatus,
} from "./folderUploadLinkMethods.js";
import type { HostFileEndpoint } from "./HostFileService.js";
import type { HostInbox, InboxReservation, InboxStaging } from "./hostInbox.js";

/**
 * The host half of folder uploads (#16247): a folder sent from a remote
 * window arrives as one archive and lands in the inbox as a whole tree.
 *
 * A prepare binds the operation to the asking endpoint's Shell, project and
 * drive lease, and to the archive's size and sha256 and the counts declared
 * for it, and reserves room for the archive and the unpacked tree together
 * before a byte moves. The archive is accepted only on the token the prepare
 * issued, and the transfer commits as soon as it is saved and verified: the
 * unpack runs after that, detached from the transfer and from the link it
 * came on, since a commit has a fixed deadline the Shell can't stop and a
 * large folder shouldn't race it. The unpacked tree is published into the
 * inbox in one rename, so nothing ever sees half a folder.
 *
 * Every operation is remembered by the Shell that minted its id, so a prepare,
 * status or cancel asked again after a lost answer, from any link that Shell
 * comes back on, is answered from the record and never publishes twice. A
 * drive-lease change stops every operation admitted under the old lease, as
 * single-file uploads are stopped; a dropped link stops only an archive still
 * on its way.
 */

export interface HostFolderUploadServiceOptions {
  isDriving(projectId: string, endpoint: HostFileEndpoint): boolean;
  /** The project's current drive lease; null when none. */
  leaseIdFor?(projectId: string): number | null;
  inbox: HostInbox;
  /** Tests substitute a wrapper to hold an unpack where they need it. */
  unpack?: typeof unpackFolderArchive;
  /** How long an admitted upload waits for its archive to start arriving. */
  pendingTtlMs?: number;
  /** How long a settled operation is remembered for its retries. */
  outcomeTtlMs?: number;
  /** Operations admitted and not yet settled, across every Shell. */
  maxActive?: number;
  /** How long a cancel waits for the work it stopped to clean up before answering. */
  cancelWaitMs?: number;
}

type Outcome = Extract<FolderUploadStatus, { status: "done" | "failed" | "cancelled" }>;
/** Where an operation the host holds is; `unknown` is only ever an absent record. */
type KnownStatus = Exclude<FolderUploadStatus, { status: "unknown" }>;
type StopReason = "cancelled" | "not-driving" | "disposed";

interface SessionFolders {
  session: LinkSession;
  /** By the endpoint id the Shell names. */
  endpoints: Map<string, HostFileEndpoint>;
  endpointWatches: Map<HostFileEndpoint, { dispose(): void }>;
  /** Archive tokens issued on this link: an archive is accepted only on the link its token went out on. */
  tokens: Map<string, FolderOperation>;
  unregister: Array<() => void>;
}

interface FolderOperation {
  readonly key: string;
  readonly fingerprint: string;
  readonly projectId: string;
  /** The drive lease it was admitted under: any other stops it. */
  readonly leaseId: number | null;
  readonly request: FolderUploadPreparePayload;
  /** The view that last admitted it; its archive must come from a view still driving. */
  endpoint: HostFileEndpoint;
  phase: "preparing" | "awaiting" | "receiving" | "unpacking" | "settled";
  outcome: Outcome | null;
  filesDone: number;
  token: string | null;
  tokenIn: SessionFolders | null;
  /** Fails the upload if its archive never starts arriving. */
  awaitTimer: ReturnType<typeof setTimeout> | null;
  reservation: InboxReservation | null;
  stopReason: StopReason | null;
  readonly abort: AbortController;
  /** Set while receiving: what a stop does to the archive arriving. */
  onStop: (() => void) | null;
  /** Resolves once the operation has settled and released everything it held. */
  readonly settled: Promise<void>;
  markSettled(): void;
  expiresAt: number;
}

const DEFAULT_PENDING_TTL_MS = 60_000;
const DEFAULT_OUTCOME_TTL_MS = 15 * 60_000;
const MAX_OUTCOMES = 1_000;
const DEFAULT_MAX_ACTIVE = 4;
const DEFAULT_CANCEL_WAIT_MS = 30_000;

const TRANSFER_FAILED: Outcome = { status: "failed", reason: "transfer-failed" };

function notInProject(): AppError {
  return new AppError({
    code: "NOT_FOUND",
    message: "The asking view is not attached to a project on this host",
  });
}

function operationInUse(): AppError {
  return new AppError({
    code: "VALIDATION",
    message: "That operation id already belongs to a different folder upload",
  });
}

function isFolderUploadDestination(begin: TransferBeginMessage): boolean {
  const destination = begin.destination;
  return destination.kind === "path" && destination.path.startsWith(FOLDER_UPLOAD_SINK_PREFIX);
}

function fingerprintOf(projectId: string, payload: FolderUploadPreparePayload): string {
  return JSON.stringify([
    projectId,
    payload.rootName,
    payload.archiveBytes,
    payload.sha256,
    payload.fileCount,
    payload.folderCount,
    payload.totalBytes,
  ]);
}

function errorCode(error: unknown): string {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return typeof code === "string" ? code : "unknown";
}

function failure(reason: FolderUploadFailureReason, problem?: FolderUploadProblem): Outcome {
  return problem === undefined
    ? { status: "failed", reason }
    : { status: "failed", reason, problem };
}

/** A disk that filled up is a reason the Shell can name; anything else is a write failure. */
function writeFailure(error: unknown): Outcome {
  const code = errorCode(error);
  return failure(code === "ENOSPC" || code === "EDQUOT" ? "no-space" : "write-failed");
}

function stoppedOutcome(reason: StopReason): Outcome {
  return reason === "not-driving" ? failure("not-driving") : { status: "cancelled" };
}

export class HostFolderUploadService {
  private readonly sessions = new WeakMap<LinkSession, SessionFolders>();
  /** Every session still registered, so dispose can unregister them. */
  private readonly liveSessions = new Set<SessionFolders>();
  /** By Shell client and operation id. */
  private readonly operations = new Map<string, FolderOperation>();
  /** Operations not yet settled; each holds one of the host's slots. */
  private readonly active = new Set<FolderOperation>();
  private disposed = false;

  constructor(private readonly options: HostFolderUploadServiceOptions) {}

  /** Answer this endpoint's folder uploads on `session` (its current link). Idempotent. */
  attach(session: LinkSession, endpoint: HostFileEndpoint): void {
    if (this.disposed) return;
    const folders = this.sessionFolders(session);
    const id = endpoint.clientEndpointId;
    const previous = folders.endpoints.get(id);
    if (previous === endpoint) return;
    if (previous) {
      folders.endpointWatches.get(previous)?.dispose();
      folders.endpointWatches.delete(previous);
    }
    folders.endpoints.set(id, endpoint);
    folders.endpointWatches.set(
      endpoint,
      endpoint.onClose(() => {
        folders.endpointWatches.delete(endpoint);
        if (folders.endpoints.get(id) === endpoint) folders.endpoints.delete(id);
      })
    );
  }

  /** The project's drive lease changed: folder uploads admitted under the old one stop. */
  onLeaseChanged(projectId: string): void {
    const current = this.leaseIdFor(projectId);
    for (const operation of [...this.active]) {
      if (operation.projectId === projectId && operation.leaseId !== current) {
        this.stop(operation, "not-driving");
      }
    }
  }

  /** Stops every operation; each removes what it staged as it unwinds. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const folders of this.liveSessions) this.closeSession(folders);
    for (const operation of [...this.active]) this.stop(operation, "disposed");
    this.operations.clear();
  }

  private sessionFolders(session: LinkSession): SessionFolders {
    const existing = this.sessions.get(session);
    if (existing) return existing;
    const created: SessionFolders = {
      session,
      endpoints: new Map(),
      endpointWatches: new Map(),
      tokens: new Map(),
      unregister: [],
    };
    created.unregister.push(
      session.registerCallHandler(
        FolderUploadLinkMethod.PREPARE,
        FolderUploadPreparePayloadSchema,
        (payload) => this.prepare(created, payload)
      ),
      session.registerCallHandler(
        FolderUploadLinkMethod.STATUS,
        FolderUploadOperationPayloadSchema,
        (payload) => this.status(created, payload)
      ),
      session.registerCallHandler(
        FolderUploadLinkMethod.CANCEL,
        FolderUploadOperationPayloadSchema,
        (payload) => this.cancel(created, payload)
      ),
      // Beside the file upload and project bundle providers on the same session.
      session.transfers.addSinkProvider((begin) =>
        isFolderUploadDestination(begin) ? this.createSink(created, begin) : null
      ),
      session.onClose(() => this.closeSession(created))
    );
    this.sessions.set(session, created);
    this.liveSessions.add(created);
    return created;
  }

  /**
   * The link is gone: its tokens can no longer carry an archive, but an
   * upload still waiting for one keeps its admission, so a retry from the
   * link the Shell comes back on is handed a fresh token.
   */
  private closeSession(folders: SessionFolders): void {
    this.liveSessions.delete(folders);
    for (const dispose of folders.unregister.splice(0)) dispose();
    for (const watch of folders.endpointWatches.values()) watch.dispose();
    folders.endpointWatches.clear();
    folders.endpoints.clear();
    for (const operation of folders.tokens.values()) {
      operation.token = null;
      operation.tokenIn = null;
    }
    folders.tokens.clear();
  }

  private leaseIdFor(projectId: string): number | null {
    return this.options.leaseIdFor?.(projectId) ?? null;
  }

  private leaseHeld(operation: FolderOperation): boolean {
    return !this.disposed && this.leaseIdFor(operation.projectId) === operation.leaseId;
  }

  /** `endpoint` may still send this operation's archive. */
  private mayDrive(operation: FolderOperation, endpoint: HostFileEndpoint): boolean {
    return (
      this.leaseHeld(operation) &&
      !endpoint.isClosed() &&
      endpoint.projectId === operation.projectId &&
      this.options.isDriving(operation.projectId, endpoint)
    );
  }

  private endpointFor(folders: SessionFolders, endpointId: string): HostFileEndpoint {
    const endpoint = folders.endpoints.get(endpointId);
    if (!endpoint || endpoint.isClosed()) throw notInProject();
    return endpoint;
  }

  private opKey(endpoint: HostFileEndpoint, opId: string): string {
    return `${endpoint.clientId}\0${opId}`;
  }

  private expireOperations(): void {
    const now = Date.now();
    for (const [key, operation] of this.operations) {
      if (operation.phase === "settled" && operation.expiresAt <= now) {
        this.operations.delete(key);
      }
    }
    // Bounded: the oldest settled outcomes go first, and work under way never does.
    for (const [key, operation] of this.operations) {
      if (this.operations.size <= MAX_OUTCOMES) break;
      if (operation.phase === "settled") this.operations.delete(key);
    }
  }

  private statusOf(operation: FolderOperation): KnownStatus {
    switch (operation.phase) {
      case "preparing":
      case "awaiting":
      case "receiving":
        return { status: "receiving" };
      case "unpacking":
        return {
          status: "unpacking",
          filesDone: operation.filesDone,
          filesTotal: operation.request.fileCount,
        };
      case "settled":
        return operation.outcome!;
    }
  }

  private status(
    folders: SessionFolders,
    payload: FolderUploadOperationPayload
  ): FolderUploadStatus {
    if (this.disposed) throw notInProject();
    const endpoint = this.endpointFor(folders, payload.endpointId);
    this.expireOperations();
    const operation = this.operations.get(this.opKey(endpoint, payload.opId));
    return operation ? this.statusOf(operation) : { status: "unknown" };
  }

  /**
   * Stop an operation and answer where it ended once its work has wound down:
   * `cancelled` when nothing will be published, `done` when publishing had
   * already won, and as it was for one already settled.
   */
  private async cancel(
    folders: SessionFolders,
    payload: FolderUploadOperationPayload
  ): Promise<FolderUploadCancelResult> {
    if (this.disposed) throw notInProject();
    const endpoint = this.endpointFor(folders, payload.endpointId);
    this.expireOperations();
    const operation = this.operations.get(this.opKey(endpoint, payload.opId));
    if (!operation) return { status: "unknown" };
    this.stop(operation, "cancelled");
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      operation.settled,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, this.options.cancelWaitMs ?? DEFAULT_CANCEL_WAIT_MS);
        timer.unref?.();
      }),
    ]);
    clearTimeout(timer);
    // Still unwinding: its stop is set, so all that can still publish is a rename already under way.
    return operation.outcome ?? { status: "cancelled" };
  }

  private stop(operation: FolderOperation, reason: StopReason): void {
    if (operation.phase === "settled" || operation.stopReason !== null) return;
    operation.stopReason = reason;
    operation.abort.abort();
    if (operation.phase === "awaiting") this.settle(operation, stoppedOutcome(reason));
    else if (operation.phase === "receiving") operation.onStop?.();
    // Preparing and unpacking see the stop where they next check, and unwind from there.
  }

  /** Record how an operation ended and give back everything it held. */
  private settle(operation: FolderOperation, outcome: Outcome): void {
    if (operation.phase === "settled") return;
    operation.phase = "settled";
    operation.outcome = outcome;
    this.revokeToken(operation);
    this.clearAwaitTimer(operation);
    operation.onStop = null;
    operation.reservation?.release();
    operation.reservation = null;
    this.active.delete(operation);
    operation.expiresAt = Date.now() + (this.options.outcomeTtlMs ?? DEFAULT_OUTCOME_TTL_MS);
    operation.markSettled();
    this.expireOperations();
  }

  /** Drop an operation that was never admitted, so its id can be asked again afresh. */
  private forget(operation: FolderOperation): void {
    if (this.operations.get(operation.key) === operation) this.operations.delete(operation.key);
    this.revokeToken(operation);
    this.clearAwaitTimer(operation);
    operation.reservation?.release();
    operation.reservation = null;
    this.active.delete(operation);
    operation.phase = "settled";
    operation.markSettled();
  }

  private revokeToken(operation: FolderOperation): void {
    if (operation.token !== null) operation.tokenIn?.tokens.delete(operation.token);
    operation.token = null;
    operation.tokenIn = null;
  }

  private clearAwaitTimer(operation: FolderOperation): void {
    if (operation.awaitTimer !== null) clearTimeout(operation.awaitTimer);
    operation.awaitTimer = null;
  }

  /** A token for the archive on this link; the wait for it starts over. */
  private issueToken(folders: SessionFolders, operation: FolderOperation): string {
    this.revokeToken(operation);
    const token = crypto.randomBytes(16).toString("hex");
    operation.token = token;
    operation.tokenIn = folders;
    folders.tokens.set(token, operation);
    this.clearAwaitTimer(operation);
    operation.awaitTimer = setTimeout(() => {
      if (operation.phase === "awaiting") this.settle(operation, TRANSFER_FAILED);
    }, this.options.pendingTtlMs ?? DEFAULT_PENDING_TTL_MS);
    operation.awaitTimer.unref?.();
    return token;
  }

  private async prepare(
    folders: SessionFolders,
    payload: FolderUploadPreparePayload
  ): Promise<FolderUploadPrepareResult> {
    if (this.disposed) throw notInProject();
    const endpoint = this.endpointFor(folders, payload.endpointId);
    const projectId = endpoint.projectId;
    if (projectId === null) throw notInProject();
    const key = this.opKey(endpoint, payload.opId);
    const fingerprint = fingerprintOf(projectId, payload);
    this.expireOperations();
    const existing = this.operations.get(key);
    if (existing) {
      if (existing.fingerprint !== fingerprint) throw operationInUse();
      return this.prepareAgain(folders, endpoint, existing);
    }

    if (!this.options.isDriving(projectId, endpoint)) {
      return { status: "refused", reason: "not-driving" };
    }
    // Never the Shell's word for it: the counts it declared are held to the limits here too.
    const problem = checkFolderUploadRootName(payload.rootName) ?? checkFolderUploadTotals(payload);
    if (problem) return { status: "refused", reason: "over-limits", problem };
    if (this.active.size >= (this.options.maxActive ?? DEFAULT_MAX_ACTIVE)) {
      return { status: "refused", reason: "busy" };
    }

    // Claimed in the same turn as the checks, before any await: a concurrent
    // prepare under this id finds it, and concurrent prepares can't all pass
    // the slot check.
    let markSettled!: () => void;
    const settled = new Promise<void>((resolve) => {
      markSettled = resolve;
    });
    const operation: FolderOperation = {
      key,
      fingerprint,
      projectId,
      leaseId: this.leaseIdFor(projectId),
      request: payload,
      endpoint,
      phase: "preparing",
      outcome: null,
      filesDone: 0,
      token: null,
      tokenIn: null,
      awaitTimer: null,
      reservation: null,
      stopReason: null,
      abort: new AbortController(),
      onStop: null,
      settled,
      markSettled,
      expiresAt: Number.POSITIVE_INFINITY,
    };
    this.operations.set(key, operation);
    this.active.add(operation);

    let reservation: InboxReservation | null;
    try {
      // The archive and the tree it unpacks to are both on disk until the
      // archive is removed; the inbox adds its margin and every other
      // reservation still held.
      reservation = await this.options.inbox.reserve(payload.archiveBytes + payload.totalBytes);
    } catch {
      this.forget(operation);
      throw new Error("The host inbox could not be prepared");
    }
    if (this.disposed || operation.stopReason === "disposed") {
      reservation?.release();
      this.forget(operation);
      throw notInProject();
    }
    if (operation.stopReason === "cancelled") {
      reservation?.release();
      this.settle(operation, { status: "cancelled" });
      return { status: "cancelled" };
    }
    if (reservation === null) {
      this.forget(operation);
      return { status: "refused", reason: "no-space" };
    }
    // The link or the endpoint's claim on the project may have gone while it reserved.
    if (!folders.session.isOpen || endpoint.isClosed()) {
      reservation.release();
      this.forget(operation);
      throw notInProject();
    }
    if (operation.stopReason === "not-driving" || !this.mayDrive(operation, endpoint)) {
      reservation.release();
      this.forget(operation);
      return { status: "refused", reason: "not-driving" };
    }
    operation.reservation = reservation;
    operation.phase = "awaiting";
    return { status: "ready", token: this.issueToken(folders, operation) };
  }

  /** A prepare asked again under an id this Shell already holds: where that operation is. */
  private prepareAgain(
    folders: SessionFolders,
    endpoint: HostFileEndpoint,
    operation: FolderOperation
  ): FolderUploadPrepareResult {
    if (operation.phase === "preparing") return { status: "refused", reason: "busy" };
    if (operation.phase !== "awaiting") return this.statusOf(operation);
    if (!this.leaseHeld(operation)) {
      this.stop(operation, "not-driving");
      return this.statusOf(operation);
    }
    if (!this.mayDrive(operation, endpoint)) return { status: "refused", reason: "not-driving" };
    // Nothing has arrived yet: the archive may still come, on this link.
    operation.endpoint = endpoint;
    return { status: "ready", token: this.issueToken(folders, operation) };
  }

  private async createSink(
    folders: SessionFolders,
    begin: TransferBeginMessage
  ): Promise<TransferSink> {
    const destination = begin.destination;
    if (destination.kind !== "path" || !destination.path.startsWith(FOLDER_UPLOAD_SINK_PREFIX)) {
      throw new Error("Unexpected transfer destination");
    }
    const token = destination.path.slice(FOLDER_UPLOAD_SINK_PREFIX.length);
    const operation = folders.tokens.get(token);
    if (!operation || operation.phase !== "awaiting") {
      throw new Error("No folder upload was prepared for this destination");
    }
    // Spent: one archive per admission, and the wait for it is over.
    this.revokeToken(operation);
    this.clearAwaitTimer(operation);
    operation.phase = "receiving";
    if (
      begin.size !== operation.request.archiveBytes ||
      begin.sha256 !== operation.request.sha256
    ) {
      this.settle(operation, TRANSFER_FAILED);
      throw new Error("The transfer does not match the prepared folder upload");
    }
    if (!this.mayDrive(operation, operation.endpoint)) {
      this.settle(operation, failure("not-driving"));
      throw new Error("The folder upload is no longer admitted");
    }

    const inbox = this.options.inbox;
    let part: Awaited<ReturnType<HostInbox["createPart"]>>;
    try {
      part = await inbox.createPart();
    } catch (error) {
      this.settle(operation, writeFailure(error));
      throw new Error("The folder archive could not be stored");
    }

    let written = 0;
    let closed = false;
    let handedOff = false;
    let ended = false;
    /** Why a write or save failed, kept for when the transfer layer aborts the sink. */
    let failed: Outcome | null = null;
    const discardPart = async () => {
      if (!closed) {
        closed = true;
        await part.handle.close().catch(() => {});
      }
      await fs.rm(part.path, { force: true }).catch(() => {});
      inbox.releasePart(part.path);
    };
    const end = async (outcome: Outcome) => {
      if (handedOff || ended) return;
      ended = true;
      await discardPart();
      this.settle(operation, outcome);
    };
    const stopped = () => ended || operation.stopReason !== null;
    operation.onStop = () => void end(stoppedOutcome(operation.stopReason ?? "cancelled"));
    if (operation.stopReason !== null) {
      await end(stoppedOutcome(operation.stopReason));
      throw new Error("The folder upload was stopped");
    }

    return {
      write: async (chunk) => {
        if (stopped()) throw new Error("The folder upload was stopped");
        try {
          // A write may take fewer bytes than offered; count only what reached the file.
          for (let offset = 0; offset < chunk.byteLength;) {
            const { bytesWritten } = await part.handle.write(
              chunk,
              offset,
              chunk.byteLength - offset,
              written
            );
            if (bytesWritten <= 0) throw new Error("Short write");
            offset += bytesWritten;
            written += bytesWritten;
          }
        } catch (error) {
          failed ??= stopped() ? null : writeFailure(error);
          throw new Error("The folder archive could not be written");
        }
      },
      commit: async () => {
        let size: number;
        try {
          await part.handle.sync();
          size = (await part.handle.stat()).size;
          closed = true;
          await part.handle.close();
        } catch (error) {
          failed ??= stopped() ? null : writeFailure(error);
          throw new Error("The folder archive could not be saved");
        }
        if (size !== written || written !== operation.request.archiveBytes) {
          throw new Error("The saved archive is not the size that was sent");
        }
        if (stopped()) throw new Error("The folder upload was stopped");
        // Only a takeover stops it from here; a link that drops now leaves
        // the Shell to ask after it.
        if (!this.leaseHeld(operation)) {
          this.stop(operation, "not-driving");
          throw new Error("The project changed hands during the upload");
        }
        handedOff = true;
        operation.onStop = null;
        operation.phase = "unpacking";
        void this.unpackAndPublish(operation, part.path);
        // Says the archive arrived, never where the folder is: only a done status does.
        return destination.path;
      },
      abort: async () => {
        await end(
          operation.stopReason !== null
            ? stoppedOutcome(operation.stopReason)
            : (failed ?? TRANSFER_FAILED)
        );
      },
    };
  }

  /** Runs once the archive's transfer has committed; never rejects. */
  private async unpackAndPublish(operation: FolderOperation, archivePath: string): Promise<void> {
    const inbox = this.options.inbox;
    let archiveRemoved = false;
    const removeArchive = async () => {
      if (archiveRemoved) return;
      archiveRemoved = true;
      await fs.rm(archivePath, { force: true }).catch(() => {});
      inbox.releasePart(archivePath);
    };
    const { request, abort } = operation;
    let staging: InboxStaging | null = null;
    let outcome: Outcome;
    try {
      staging = await inbox.createStaging();
      const result = await (this.options.unpack ?? unpackFolderArchive)({
        archivePath,
        stagingDir: staging.treePath,
        rootName: request.rootName,
        declared: {
          fileCount: request.fileCount,
          folderCount: request.folderCount,
          totalBytes: request.totalBytes,
        },
        signal: abort.signal,
        onProgress: ({ filesDone }) => {
          operation.filesDone = filesDone;
        },
      });
      // Its bytes are in the tree now (or refused); free them before publishing.
      await removeArchive();
      if (!result.ok) {
        outcome = failure(result.reason, result.problem);
      } else {
        if (!this.leaseHeld(operation)) this.stop(operation, "not-driving");
        const hostPath = await inbox.publishTree(staging, request.rootName, abort.signal);
        outcome = { status: "done", hostPath };
      }
    } catch (error) {
      if (operation.stopReason !== null) {
        outcome = stoppedOutcome(operation.stopReason);
      } else {
        outcome = writeFailure(error);
        logWarn("remote.folder-upload.unpack-failed", { code: errorCode(error) });
      }
    } finally {
      await removeArchive();
      // A no-op once the tree is published.
      if (staging) await inbox.discardStaging(staging).catch(() => {});
    }
    this.settle(operation, outcome);
    void inbox.cleanup();
  }
}
