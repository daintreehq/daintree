import type { IpcInvokeMap } from "../../types/index.js";

export const MERGED_WORKTREE_CLEANUP_METHOD_CHANNELS = {
  preview: "merged-worktree-cleanup:preview",
  setEnabled: "merged-worktree-cleanup:set-enabled",
  takeReceipts: "merged-worktree-cleanup:take-receipts",
  ackReceipts: "merged-worktree-cleanup:ack-receipts",
} as const satisfies Record<string, keyof IpcInvokeMap>;

type Methods = typeof MERGED_WORKTREE_CLEANUP_METHOD_CHANNELS;

export type MergedWorktreeCleanupPreloadBindings = {
  [M in keyof Methods]: (
    ...args: IpcInvokeMap[Methods[M]]["args"]
  ) => Promise<IpcInvokeMap[Methods[M]]["result"]>;
};

type Invoker = (channel: string, ...args: unknown[]) => Promise<unknown>;

export function buildMergedWorktreeCleanupPreloadBindings(
  invoke: Invoker
): MergedWorktreeCleanupPreloadBindings {
  const out: Record<string, (...args: unknown[]) => Promise<unknown>> = {};
  for (const method of Object.keys(MERGED_WORKTREE_CLEANUP_METHOD_CHANNELS) as Array<
    keyof Methods
  >) {
    const channel = MERGED_WORKTREE_CLEANUP_METHOD_CHANNELS[method];
    out[method as string] = (...args) => invoke(channel, ...args);
  }
  return out as unknown as MergedWorktreeCleanupPreloadBindings;
}
