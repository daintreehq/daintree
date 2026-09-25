import type { HostId, OperationId } from "../remoteHosts.js";
import type { HostPickRequest } from "./hostFiles.js";

export type TransferDestination =
  { kind: "inbox"; bucket: "clipboard" | "files" } | { kind: "worktree"; directory: string };

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
