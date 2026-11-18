import type { IpcInvokeMap } from "../../types/index.js";

export const GIT_HUNKS_METHOD_CHANNELS = {
  stageHunks: "git:stage-hunks",
  unstageHunks: "git:unstage-hunks",
} as const satisfies Record<string, keyof IpcInvokeMap>;

type GitHunkStagingPayload = IpcInvokeMap["git:stage-hunks"]["args"][0];

export interface GitHunksPreloadBindings {
  stageHunks(payload: GitHunkStagingPayload): Promise<IpcInvokeMap["git:stage-hunks"]["result"]>;
  unstageHunks(
    payload: GitHunkStagingPayload
  ): Promise<IpcInvokeMap["git:unstage-hunks"]["result"]>;
}

type Invoker = (channel: string, ...args: unknown[]) => Promise<unknown>;

export function buildGitHunksPreloadBindings(invoke: Invoker): GitHunksPreloadBindings {
  return {
    stageHunks: (payload) =>
      invoke(GIT_HUNKS_METHOD_CHANNELS.stageHunks, payload) as Promise<
        IpcInvokeMap["git:stage-hunks"]["result"]
      >,
    unstageHunks: (payload) =>
      invoke(GIT_HUNKS_METHOD_CHANNELS.unstageHunks, payload) as Promise<
        IpcInvokeMap["git:unstage-hunks"]["result"]
      >,
  };
}
