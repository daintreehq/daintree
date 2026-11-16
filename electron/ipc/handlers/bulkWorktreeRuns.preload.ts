import type { IpcInvokeMap } from "../../types/index.js";

export const BULK_WORKTREE_RUNS_METHOD_CHANNELS = {
  publish: "bulk-worktree-runs:publish",
  list: "bulk-worktree-runs:list",
  command: "bulk-worktree-runs:command",
  dismiss: "bulk-worktree-runs:dismiss",
} as const satisfies Record<string, keyof IpcInvokeMap>;

type Methods = typeof BULK_WORKTREE_RUNS_METHOD_CHANNELS;

export type BulkWorktreeRunsPreloadBindings = {
  [M in keyof Methods]: (
    ...args: IpcInvokeMap[Methods[M]]["args"]
  ) => Promise<IpcInvokeMap[Methods[M]]["result"]>;
};

type Invoker = (channel: string, ...args: unknown[]) => Promise<unknown>;

export function buildBulkWorktreeRunsPreloadBindings(
  invoke: Invoker
): BulkWorktreeRunsPreloadBindings {
  const out: Record<string, (...args: unknown[]) => Promise<unknown>> = {};
  for (const method of Object.keys(BULK_WORKTREE_RUNS_METHOD_CHANNELS) as Array<keyof Methods>) {
    const channel = BULK_WORKTREE_RUNS_METHOD_CHANNELS[method];
    out[method as string] = (...args) => invoke(channel, ...args);
  }
  return out as unknown as BulkWorktreeRunsPreloadBindings;
}
