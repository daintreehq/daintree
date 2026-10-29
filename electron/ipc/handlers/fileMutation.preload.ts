import type { IpcInvokeMap } from "../../types/index.js";

export const GIT_DISCARD_METHOD_CHANNELS = {
  discardFileChanges: "git:discard-file-changes",
  previewFileMutation: "git:preview-file-mutation",
} as const satisfies Record<string, keyof IpcInvokeMap>;

export const FILES_TRASH_METHOD_CHANNELS = {
  trash: "files:trash",
} as const satisfies Record<string, keyof IpcInvokeMap>;

export interface FileMutationPayload {
  worktreePath: string;
  /** Path relative to `worktreePath`. */
  relativePath: string;
}

export interface FileDiscardPayload extends FileMutationPayload {
  /** The approved preview's `token`; the discard refuses if the file moved since. */
  expectedToken?: string;
}

export interface FileMutationPreviewPayload extends FileMutationPayload {
  kind: "discard" | "trash";
}

export interface GitDiscardPreloadBindings {
  discardFileChanges(
    payload: FileDiscardPayload
  ): Promise<IpcInvokeMap["git:discard-file-changes"]["result"]>;
  previewFileMutation(
    payload: FileMutationPreviewPayload
  ): Promise<IpcInvokeMap["git:preview-file-mutation"]["result"]>;
}

export interface FilesTrashPreloadBindings {
  trash(payload: FileMutationPayload): Promise<IpcInvokeMap["files:trash"]["result"]>;
}

type Invoker = (channel: string, ...args: unknown[]) => Promise<unknown>;

export function buildGitDiscardPreloadBindings(invoke: Invoker): GitDiscardPreloadBindings {
  return {
    discardFileChanges: (payload) =>
      invoke(GIT_DISCARD_METHOD_CHANNELS.discardFileChanges, payload) as Promise<
        IpcInvokeMap["git:discard-file-changes"]["result"]
      >,
    previewFileMutation: (payload) =>
      invoke(GIT_DISCARD_METHOD_CHANNELS.previewFileMutation, payload) as Promise<
        IpcInvokeMap["git:preview-file-mutation"]["result"]
      >,
  };
}

export function buildFilesTrashPreloadBindings(invoke: Invoker): FilesTrashPreloadBindings {
  return {
    trash: (payload) =>
      invoke(FILES_TRASH_METHOD_CHANNELS.trash, payload) as Promise<
        IpcInvokeMap["files:trash"]["result"]
      >,
  };
}
