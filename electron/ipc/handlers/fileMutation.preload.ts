import type { IpcInvokeMap } from "../../types/index.js";

export const GIT_DISCARD_METHOD_CHANNELS = {
  discardFileChanges: "git:discard-file-changes",
} as const satisfies Record<string, keyof IpcInvokeMap>;

export const FILES_TRASH_METHOD_CHANNELS = {
  trash: "files:trash",
} as const satisfies Record<string, keyof IpcInvokeMap>;

export interface FileMutationPayload {
  worktreePath: string;
  /** Path relative to `worktreePath`. */
  relativePath: string;
}

export interface GitDiscardPreloadBindings {
  discardFileChanges(
    payload: FileMutationPayload
  ): Promise<IpcInvokeMap["git:discard-file-changes"]["result"]>;
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
