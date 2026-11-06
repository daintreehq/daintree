import type { HostId } from "../../../shared/types/remoteHosts.js";
import { formatErrorMessage } from "../../../shared/utils/errorMessage.js";
import type { TransferDestination, UploadResult } from "../../../shared/types/ipc/fileTransfer.js";
import { AppError } from "../../utils/errorTypes.js";
import type { LinkSession } from "../link/session.js";
import type { TransferSource } from "../link/transfer.js";
import {
  classifyFolderUploadCallError,
  FOLDER_UPLOAD_SINK_PREFIX,
  FolderUploadCancelResultSchema,
  FolderUploadLinkMethod,
  FolderUploadPrepareResultSchema,
  FolderUploadStatusSchema,
  type FolderUploadCancelResult,
  type FolderUploadPreparePayload,
  type FolderUploadPrepareResult,
  type FolderUploadStatus,
} from "./folderUploadLinkMethods.js";
import {
  UPLOAD_SINK_PREFIX,
  UploadLinkMethod,
  UploadPrepareResultSchema,
  type UploadRefusalReason,
} from "./uploadLinkMethods.js";

/**
 * The Shell half of uploads: which session and endpoint carry a view's
 * upload, and the prepare-then-send exchange. Failures come back as
 * AppErrors whose user message names the host and the file, and nothing is
 * left half-placed on the host when one fails.
 */

export interface UploadOptions {
  webContentsId: number;
  /** The operation this upload belongs to; the host answers a repeat from its record. */
  opId: string;
  /** The host's display name, for messages. */
  hostLabel: string;
  name: string;
  destination: TransferDestination;
  onProgress?: (sentBytes: number, totalBytes: number) => void;
  signal?: AbortSignal;
}

interface HostLink {
  session: LinkSession | null;
  endpoints: Map<string, number>;
}

const PREPARE_TIMEOUT_MS = 60_000;
/** Longer than the host waits for a cancelled folder upload to wind down before it answers. */
const FOLDER_CANCEL_TIMEOUT_MS = 45_000;
const FOLDER_STATUS_TIMEOUT_MS = 30_000;
/** What the archive is called on the link: never the folder's own name. */
const FOLDER_ARCHIVE_NAME = "folder.zip";

/** Where a folder upload's calls go, and how they are told apart in messages. */
export interface FolderCallOptions {
  webContentsId: number;
  hostLabel: string;
  signal?: AbortSignal;
}

export function notConnected(hostLabel: string): AppError {
  return new AppError({
    code: "HOST_DISCONNECTED",
    message: "The host is not connected",
    userMessage: `Not connected to ${hostLabel}.`,
  });
}

function refusal(reason: UploadRefusalReason, name: string, hostLabel: string): AppError {
  switch (reason) {
    case "no-space":
      return new AppError({
        code: "PAYLOAD_TOO_LARGE",
        message: "The host is out of disk space",
        userMessage: `${hostLabel} is out of disk space.`,
      });
    case "too-large":
      return new AppError({
        code: "PAYLOAD_TOO_LARGE",
        message: "The file is larger than the host accepts",
        userMessage: `${name} is too large to send to ${hostLabel}.`,
      });
    case "outside-project":
      return new AppError({
        code: "OUTSIDE_ROOT",
        message: "The destination folder is not in the project",
        userMessage: `That folder isn't in this project on ${hostLabel}.`,
      });
    case "not-a-directory":
      return new AppError({
        code: "NOT_A_DIRECTORY",
        message: "The destination is not a folder",
        userMessage: `That folder no longer exists on ${hostLabel}.`,
      });
    case "not-a-file":
      return new AppError({
        code: "NOT_A_FILE",
        message: "Something that is not a file has that name",
        userMessage: `${name} can't be replaced on ${hostLabel}: something that isn't a file has that name.`,
      });
    case "busy":
      return new AppError({
        code: "RATE_LIMITED",
        message: "Too many uploads are waiting",
        userMessage: `Other uploads to ${hostLabel} are still starting. Try again in a moment.`,
      });
  }
}

function errorCode(error: unknown): string | null {
  if (typeof error !== "object" || error === null || !("code" in error)) return null;
  return typeof error.code === "string" ? error.code : null;
}

/** A transfer-layer failure, restated for the person who dropped the file. */
function sendFailure(error: unknown, name: string, hostLabel: string): Error {
  // A failed prepare arrives rebuilt by the session rather than as this
  // process's AppError; its code still decides whether the upload is resumed.
  const message = formatErrorMessage(error, "Upload failed");
  switch (errorCode(error)) {
    case "CANCELLED":
      return error instanceof AppError ? error : new AppError({ code: "CANCELLED", message });
    case "HOST_DISCONNECTED":
      return notConnected(hostLabel);
    case "OUTCOME_UNKNOWN":
      return new AppError({
        code: "OUTCOME_UNKNOWN",
        message,
        userMessage: `The connection to ${hostLabel} dropped as ${name} finished sending. Drop it again to be sure it arrived.`,
      });
    case "RATE_LIMITED":
      return new AppError({
        code: "RATE_LIMITED",
        message,
        userMessage: `${hostLabel} is busy receiving other files. Try again in a moment.`,
      });
  }
  if (!(error instanceof AppError)) {
    return new AppError({
      code: "INTERNAL",
      message: "Upload failed",
      userMessage: `Couldn't send ${name} to ${hostLabel}.`,
    });
  }
  return new AppError({
    code: error.code,
    message: error.message,
    userMessage: /checksum/i.test(error.message)
      ? `${name} was damaged on the way to ${hostLabel}. Try again.`
      : `Couldn't save ${name} on ${hostLabel}.`,
  });
}

/**
 * A failed folder-upload call or transfer, restated without anything the
 * host or the link said: errors are logged whole, and a folder's must never
 * name it. The code is what decides whether the send is resumed.
 */
function folderFailure(error: unknown, hostLabel: string): AppError {
  switch (errorCode(error)) {
    case "CANCELLED":
      return new AppError({ code: "CANCELLED", message: "Folder upload cancelled" });
    case "HOST_DISCONNECTED":
      return notConnected(hostLabel);
    case "OUTCOME_UNKNOWN":
      return folderOutcomeUnknown(hostLabel);
    case "RATE_LIMITED":
      return new AppError({
        code: "RATE_LIMITED",
        message: "The host is busy",
        userMessage: `${hostLabel} is busy receiving other files. Try again in a moment.`,
      });
    case "DRIVEN_ELSEWHERE":
      return new AppError({
        code: "DRIVEN_ELSEWHERE",
        message: "Another window drives this project",
        userMessage: `Another window has control of this project on ${hostLabel}. Take control to send folders.`,
      });
  }
  switch (classifyFolderUploadCallError(error)) {
    case "unsupported":
      return new AppError({
        code: "UNSUPPORTED",
        message: "The host does not take folder uploads",
        userMessage: `Update Daintree on ${hostLabel} to send folders.`,
      });
    case "validation":
      return new AppError({
        code: "VALIDATION",
        message: "The host refused the folder upload request",
        userMessage: `Couldn't send the folder to ${hostLabel}.`,
      });
    case "other":
      return new AppError({
        code: "INTERNAL",
        message: "The folder upload failed",
        userMessage: `Couldn't send the folder to ${hostLabel}.`,
      });
  }
}

export function folderOutcomeUnknown(hostLabel: string): AppError {
  return new AppError({
    code: "OUTCOME_UNKNOWN",
    message: "The folder upload's outcome is unknown",
    userMessage: `The connection to ${hostLabel} dropped while the folder was being sent. Drop it again to be sure it arrived.`,
  });
}

function unreadableAnswer(hostLabel: string): AppError {
  return new AppError({
    code: "INTERNAL",
    message: "The host answered a folder upload call with an unusable reply",
    userMessage: `Couldn't send the folder to ${hostLabel}.`,
  });
}

export class ClientUploadTransport {
  private readonly hosts = new Map<HostId, HostLink>();
  private readonly openedListeners = new Set<() => void>();

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
    for (const listener of [...this.openedListeners]) listener();
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

  noteEndpointClosed(hostId: HostId, info: { endpointId: string }): void {
    const link = this.hosts.get(hostId);
    if (!link) return;
    link.endpoints.delete(info.endpointId);
    if (link.endpoints.size === 0) this.hosts.delete(hostId);
  }

  /** The asking view's newest endpoint on the host, never another view's. */
  private endpointFor(hostId: HostId, webContentsId: number): string | null {
    const link = this.hosts.get(hostId);
    if (!link) return null;
    let found: string | null = null;
    for (const [endpointId, owner] of link.endpoints) {
      if (owner === webContentsId) found = endpointId;
    }
    return found;
  }

  async upload(
    hostId: HostId,
    source: TransferSource,
    options: UploadOptions
  ): Promise<UploadResult> {
    const { signal, hostLabel, name } = options;
    if (signal?.aborted) throw new AppError({ code: "CANCELLED", message: "Upload cancelled" });
    const session = this.hosts.get(hostId)?.session;
    const endpointId = this.endpointFor(hostId, options.webContentsId);
    if (!session || !session.isOpen || endpointId === null) throw notConnected(hostLabel);

    const destination =
      options.destination.kind === "inbox"
        ? options.destination
        : {
            kind: "worktree" as const,
            directory: options.destination.directory,
            ...(options.destination.replaceToken !== undefined
              ? { replaceToken: options.destination.replaceToken }
              : {}),
          };
    let prepared;
    try {
      prepared = UploadPrepareResultSchema.parse(
        await session.call(
          UploadLinkMethod.PREPARE,
          {
            endpointId,
            name,
            size: source.size,
            sha256: source.sha256,
            opId: options.opId,
            destination,
          },
          { timeoutMs: PREPARE_TIMEOUT_MS, signal }
        )
      );
    } catch (error) {
      // Errors from the host arrive rebuilt from the envelope, not as this process's AppError.
      if (errorCode(error) === "DRIVEN_ELSEWHERE") {
        throw new AppError({
          code: "DRIVEN_ELSEWHERE",
          message: "Another window drives this project",
          userMessage: `Another window has control of this project on ${hostLabel}. Take control to add files.`,
        });
      }
      if (errorCode(error) === "VALIDATION") {
        throw new AppError({
          code: "VALIDATION",
          message: "The host refused the upload request",
          userMessage: `Couldn't send ${name} to ${hostLabel}.`,
        });
      }
      throw sendFailure(error, name, hostLabel);
    }

    switch (prepared.status) {
      case "duplicate":
        return { hostPath: prepared.hostPath, bytes: source.size, deduplicated: true };
      case "done":
        return { hostPath: prepared.hostPath, bytes: prepared.bytes, deduplicated: false };
      case "conflict":
        return {
          hostPath: prepared.hostPath,
          bytes: 0,
          deduplicated: false,
          conflict: true,
          replaceToken: prepared.replaceToken,
        };
      case "refused":
        throw refusal(prepared.reason, name, hostLabel);
      case "ready":
        break;
    }

    let result;
    try {
      result = await session.transfers.send(source, {
        name,
        destination: { kind: "path", path: `${UPLOAD_SINK_PREFIX}${prepared.token}` },
        signal,
        onProgress: (progress) => options.onProgress?.(progress.bytes, progress.totalBytes),
      });
    } catch (error) {
      throw sendFailure(error, name, hostLabel);
    }
    if (!result.path.startsWith("/")) {
      throw new AppError({
        code: "INTERNAL",
        message: "The host answered with an unusable path",
        userMessage: `Couldn't save ${name} on ${hostLabel}.`,
      });
    }
    return { hostPath: result.path, bytes: result.bytes, deduplicated: false };
  }

  /** The view's own endpoint on the host's current link, or HOST_DISCONNECTED. */
  private folderLink(
    hostId: HostId,
    options: FolderCallOptions
  ): { session: LinkSession; endpointId: string } {
    if (options.signal?.aborted) {
      throw new AppError({ code: "CANCELLED", message: "Folder upload cancelled" });
    }
    const session = this.hosts.get(hostId)?.session;
    const endpointId = this.endpointFor(hostId, options.webContentsId);
    if (!session || !session.isOpen || endpointId === null) throw notConnected(options.hostLabel);
    return { session, endpointId };
  }

  private async folderCall<T>(
    hostId: HostId,
    method: string,
    body: Record<string, unknown>,
    parse: (answer: unknown) => { success: true; data: T } | { success: false },
    options: FolderCallOptions & { timeoutMs: number }
  ): Promise<{ answer: T; session: LinkSession }> {
    const { session, endpointId } = this.folderLink(hostId, options);
    let raw: unknown;
    try {
      raw = await session.call(
        method,
        { endpointId, ...body },
        { timeoutMs: options.timeoutMs, signal: options.signal }
      );
    } catch (error) {
      throw folderFailure(error, options.hostLabel);
    }
    const parsed = parse(raw);
    if (!parsed.success) throw unreadableAnswer(options.hostLabel);
    return { answer: parsed.data, session };
  }

  /**
   * Admit a folder upload, or learn where this operation already is. The
   * session it was asked on comes back with the answer, since a token is
   * good only on the link it was issued on.
   */
  async prepareFolder(
    hostId: HostId,
    payload: Omit<FolderUploadPreparePayload, "endpointId">,
    options: FolderCallOptions
  ): Promise<{ result: FolderUploadPrepareResult; session: LinkSession }> {
    const { answer, session } = await this.folderCall(
      hostId,
      FolderUploadLinkMethod.PREPARE,
      { ...payload },
      (raw) => FolderUploadPrepareResultSchema.safeParse(raw),
      { ...options, timeoutMs: PREPARE_TIMEOUT_MS }
    );
    return { result: answer, session };
  }

  async folderStatus(
    hostId: HostId,
    opId: string,
    options: FolderCallOptions
  ): Promise<FolderUploadStatus> {
    const { answer } = await this.folderCall(
      hostId,
      FolderUploadLinkMethod.STATUS,
      { opId },
      (raw) => FolderUploadStatusSchema.safeParse(raw),
      { ...options, timeoutMs: FOLDER_STATUS_TIMEOUT_MS }
    );
    return answer;
  }

  async cancelFolder(
    hostId: HostId,
    opId: string,
    options: FolderCallOptions
  ): Promise<FolderUploadCancelResult> {
    const { answer } = await this.folderCall(
      hostId,
      FolderUploadLinkMethod.CANCEL,
      { opId },
      (raw) => FolderUploadCancelResultSchema.safeParse(raw),
      { ...options, timeoutMs: FOLDER_CANCEL_TIMEOUT_MS }
    );
    return answer;
  }

  /**
   * Send a folder's archive to the token a prepare on `session` issued.
   * Resolving says the host has the archive whole, never that the folder is
   * in place: only a `done` status says that.
   */
  async sendFolderArchive(
    session: LinkSession,
    source: TransferSource,
    token: string,
    options: {
      hostLabel: string;
      signal?: AbortSignal;
      onProgress?: (sentBytes: number, totalBytes: number) => void;
    }
  ): Promise<void> {
    if (!session.isOpen) throw notConnected(options.hostLabel);
    try {
      await session.transfers.send(source, {
        name: FOLDER_ARCHIVE_NAME,
        destination: { kind: "path", path: `${FOLDER_UPLOAD_SINK_PREFIX}${token}` },
        signal: options.signal,
        onProgress: (progress) => options.onProgress?.(progress.bytes, progress.totalBytes),
      });
    } catch (error) {
      throw folderFailure(error, options.hostLabel);
    }
  }
}
