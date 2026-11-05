import type { FolderUploadProblem, FolderUploadTotals } from "../folderUpload.js";
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

/** A host file the person clicked a link to in a remote view's terminal. */
export interface GrantClickedFilePayload {
  hostId: HostId;
  hostPath: string;
}

export interface DownloadResult {
  localPath: string;
  bytes: number;
}

/** Why something inside a dropped folder is left out of what is sent. */
export type FolderNotCopiedReason =
  | "symlink"
  | "junction"
  /** Any other Windows reparse point. */
  | "reparse-point"
  /** A device, socket, FIFO or anything else that isn't a file or a folder. */
  | "special-file"
  | "unreadable";

/** An item directly inside the dropped folder, with what it adds to the totals. */
export interface FolderSummaryItem {
  /** In the archive's root-prefixed form: `Root/node_modules/`, `Root/video.mov`. */
  path: string;
  kind: "file" | "folder";
  /** Files at or under it, so 1 for a file. */
  fileCount: number;
  /** Folders at or under it, itself included, so 0 for a file. */
  folderCount: number;
  totalBytes: number;
}

/**
 * A folder dropped or pasted in a remote window, as the question shows it
 * before anything is sent. Every list holds at most
 * `FOLDER_UPLOAD_SUMMARY_MAX_ITEMS`; the counts beside them cover the rest.
 */
export interface FolderUploadSummary {
  rootName: string;
  totals: FolderUploadTotals;
  /**
   * The walk stopped early (at a limit, a clash or a path it can't carry):
   * every count and size here and in the lists is at least what it shows.
   */
  lowerBound: boolean;
  /**
   * Hidden files and folders (`.git`, `.env`), copied and counted like any
   * other, and the outermost of them by path.
   */
  hidden: FolderUploadTotals & { paths: string[] };
  /**
   * The items directly inside the folder that hold the most bytes, largest
   * first. A count or size limit's problem names its own largest
   * contributors, ranked by what that limit counts.
   */
  largest: FolderSummaryItem[];
  /** What is left out and why: never followed, never sent. */
  notCopied: { count: number; items: Array<{ path: string; reason: FolderNotCopiedReason }> };
}

/**
 * The walk itself gave up: it looked at more items than this, copied or not,
 * before the folder's own limits were reached (a folder of links or sockets).
 * Only the Shell's summary carries it; it never crosses the link.
 */
export interface FolderWalkLimitProblem {
  kind: "walk-limit";
  maximum: number;
  actual: number;
  /** The items directly inside the folder holding the most of them. */
  paths: string[];
}

/** A summarized folder: ready to ask about, or refused with the limit or clash responsible. */
export type FolderUploadCheck =
  | { status: "ready"; summary: FolderUploadSummary }
  | {
      status: "refused";
      summary: FolderUploadSummary;
      problem: FolderUploadProblem | FolderWalkLimitProblem;
    };

export interface SummarizeLocalFolderPayload {
  /** The dropped or pasted folder, exactly as this view was granted it. */
  localPath: string;
  /** The walk runs under this id, so `cancel` stops it. */
  opId: OperationId;
}

/**
 * A folder dropped or pasted in this view, summarized on this machine. A
 * ready one carries the handle a send names it by: bound to this view and to
 * exactly what was summarized, for as long as the view's grant of the folder
 * lasts. A refused one has nothing to send.
 */
export type LocalFolderSummaryResult =
  | (Extract<FolderUploadCheck, { status: "ready" }> & { handle: string })
  | Extract<FolderUploadCheck, { status: "refused" }>;

export type FolderUploadPhase = "packing" | "sending" | "unpacking";

export type FileTransferEvent =
  | {
      type: "progress";
      opId: OperationId;
      transferredBytes: number;
      totalBytes: number;
    }
  /**
   * A folder upload's progress. Each phase measures its own work: packing
   * counts files packed and their content bytes, sending the archive's bytes,
   * unpacking the files the host has written. Null is "not measured in this
   * phase", never zero; the totals are always known.
   */
  | {
      type: "folder-progress";
      opId: OperationId;
      phase: FolderUploadPhase;
      filesDone: number | null;
      filesTotal: number;
      transferredBytes: number | null;
      /** The archive's size while sending, the files' content otherwise. */
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
