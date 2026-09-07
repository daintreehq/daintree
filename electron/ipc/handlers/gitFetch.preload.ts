import type { IpcInvokeMap } from "../../types/index.js";

export const GIT_FETCH_METHOD_CHANNELS = {
  fetch: "git:fetch",
} as const satisfies Record<string, keyof IpcInvokeMap>;

export interface GitFetchPreloadBindings {
  fetch(payload: { cwd: string; prune?: boolean }): Promise<IpcInvokeMap["git:fetch"]["result"]>;
}

type Invoker = (channel: string, ...args: unknown[]) => Promise<unknown>;

export function buildGitFetchPreloadBindings(invoke: Invoker): GitFetchPreloadBindings {
  return {
    fetch: (payload) =>
      invoke(GIT_FETCH_METHOD_CHANNELS.fetch, payload) as Promise<
        IpcInvokeMap["git:fetch"]["result"]
      >,
  };
}
