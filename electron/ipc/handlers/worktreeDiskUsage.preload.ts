import type { IpcInvokeMap } from "../../types/index.js";

export const WORKTREE_DISK_USAGE_METHOD_CHANNELS = {
  measure: "worktree-disk-usage:measure",
  cancel: "worktree-disk-usage:cancel",
} as const satisfies Record<string, keyof IpcInvokeMap>;

type Methods = typeof WORKTREE_DISK_USAGE_METHOD_CHANNELS;

export type WorktreeDiskUsagePreloadBindings = {
  [M in keyof Methods]: (
    ...args: IpcInvokeMap[Methods[M]]["args"]
  ) => Promise<IpcInvokeMap[Methods[M]]["result"]>;
};

type Invoker = (channel: string, ...args: unknown[]) => Promise<unknown>;

export function buildWorktreeDiskUsagePreloadBindings(
  invoke: Invoker
): WorktreeDiskUsagePreloadBindings {
  const out: Record<string, (...args: unknown[]) => Promise<unknown>> = {};
  for (const method of Object.keys(WORKTREE_DISK_USAGE_METHOD_CHANNELS) as Array<keyof Methods>) {
    const channel = WORKTREE_DISK_USAGE_METHOD_CHANNELS[method];
    out[method as string] = (...args) => invoke(channel, ...args);
  }
  return out as unknown as WorktreeDiskUsagePreloadBindings;
}
