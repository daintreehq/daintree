import type { HostId, OperationId } from "../remoteHosts.js";
import type { HostPickRequest } from "./hostFiles.js";

export type TransferDestination =
  | { kind: "inbox"; bucket: "clipboard" | "files" }
  /**
   * "Add to project": into a folder of the project on the host. An existing
   * file there is only replaced with the `replaceToken` the host handed back
   * when it reported that file (see {@link UploadResult.conflict}), once the
   * user confirmed; the host honours it for that unchanged file only.
   */
  | { kind: "worktree"; directory: string; replaceToken?: string };

/**
 * The folder, under the host's temp dir, that holds everything dropped, pasted
 * or attached in a remote window: `clipboard/` for pasted images and
 * `files/<yyyymmdd-hhmmss>-<id>/<name>` for files.
 */
export const HOST_INBOX_DIR_NAME = "daintree-inbox";

export interface UploadLocalFilePayload {
  hostId: HostId;
  localPath: string;
  destination: TransferDestination;
  opId: OperationId;
}

export interface UploadBytesPayload {
  hostId: HostId;
  bytes: Uint8Array;
  name: string;
  mimeType: string | null;
  destination: TransferDestination;
  opId: OperationId;
}

export interface UploadResult {
  hostPath: string;
  bytes: number;
  /** True when an identical file already in the inbox was reused. */
  deduplicated: boolean;
  /**
   * Add to project only: a file of that name is already in the folder.
   * Nothing was written; `hostPath` names the file that is there, so the
   * caller can ask before replacing it, and `replaceToken` is what a retry
   * carries to replace exactly that file.
   */
  conflict?: boolean;
  replaceToken?: string;
}

/**
 * `clipboard:save-image` in a window attached to a remote host: the operation
 * the image's upload runs under, so its progress events carry that id and
 * `fileTransfer.cancel` stops it. A local save ignores it.
 */
export interface ClipboardSaveImageOptions {
  opId?: OperationId;
}

/** A local file as the upload paths see it, before anything is sent. */
export interface LocalFileStat {
  size: number;
  isDirectory: boolean;
}

/** Device-owned choices about sending local files to a host. */
export interface UploadPreferences {
  /** Ctrl+V in an agent terminal of a remote window sends a clipboard image to the host. */
  interceptCtrlVImages: boolean;
}

export interface DownloadPayload {
  hostId: HostId;
  hostPath: string;
  opId: OperationId;
}

export interface DownloadResult {
  localPath: string;
  bytes: number;
}

export type FileTransferEvent =
  | {
      type: "progress";
      opId: OperationId;
      transferredBytes: number;
      totalBytes: number;
    }
  /**
   * A native picker was asked for in a window attached to a remote host: this
   * view shows Daintree's host picker and answers with `answerHostPick`.
   */
  | { type: "host-pick-request"; requestId: string; request: HostPickRequest };

export interface AnswerHostPickPayload {
  requestId: string;
  /** The chosen host paths, or null when the picker was dismissed. */
  paths: string[] | null;
}
