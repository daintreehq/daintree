import type { HostId } from "../../../shared/types/remoteHosts.js";
import type { TransferDestination, UploadResult } from "../../../shared/types/ipc/fileTransfer.js";
import { AppError } from "../../utils/errorTypes.js";
import type { LinkSession } from "../link/session.js";
import type { TransferSource } from "../link/transfer.js";
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
  if (!(error instanceof AppError)) {
    if (errorCode(error) === "HOST_DISCONNECTED") return notConnected(hostLabel);
    return new AppError({
      code: "INTERNAL",
      message: "Upload failed",
      userMessage: `Couldn't send ${name} to ${hostLabel}.`,
    });
  }
  switch (error.code) {
    case "CANCELLED":
      return error;
    case "HOST_DISCONNECTED":
      return notConnected(hostLabel);
    case "OUTCOME_UNKNOWN":
      return new AppError({
        code: "OUTCOME_UNKNOWN",
        message: error.message,
        userMessage: `The connection to ${hostLabel} dropped as ${name} finished sending. Drop it again to be sure it arrived.`,
      });
    case "RATE_LIMITED":
      return new AppError({
        code: "RATE_LIMITED",
        message: error.message,
        userMessage: `${hostLabel} is busy receiving other files. Try again in a moment.`,
      });
    default:
      return new AppError({
        code: error.code,
        message: error.message,
        userMessage: /checksum/i.test(error.message)
          ? `${name} was damaged on the way to ${hostLabel}. Try again.`
          : `Couldn't save ${name} on ${hostLabel}.`,
      });
  }
}

export class ClientUploadTransport {
  private readonly hosts = new Map<HostId, HostLink>();

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
            overwrite: options.destination.overwrite === true,
          };
    let prepared;
    try {
      prepared = UploadPrepareResultSchema.parse(
        await session.call(
          UploadLinkMethod.PREPARE,
          { endpointId, name, size: source.size, sha256: source.sha256, destination },
          { timeoutMs: PREPARE_TIMEOUT_MS, signal }
        )
      );
    } catch (error) {
      // Errors from the host arrive rebuilt from the envelope, not as this process's AppError.
      if (errorCode(error) === "DRIVEN_ELSEWHERE") {
        throw new AppError({
          code: "DRIVEN_ELSEWHERE",
          message: "Another window drives this project",
          userMessage: `Another window is driving this project on ${hostLabel}. Take it over to add files.`,
        });
      }
      throw sendFailure(error, name, hostLabel);
    }

    switch (prepared.status) {
      case "duplicate":
        return { hostPath: prepared.hostPath, bytes: source.size, deduplicated: true };
      case "conflict":
        return {
          hostPath: prepared.hostPath,
          bytes: 0,
          deduplicated: false,
          conflict: true,
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
}
