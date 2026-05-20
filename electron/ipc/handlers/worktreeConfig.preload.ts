import type { IpcInvokeMap } from "../../types/index.js";

// Opt out of `scripts/codegen/ipc-renderer.mjs` — `worktreeConfig`'s renderer
// API uses positional arguments (`setWslGit(worktreeId, enabled)`) while the
// IPC channels carry a `{ worktreeId, enabled }` payload object. The
// translation lives in the invoke wrapper below, so the generator must skip
// this namespace.
export const RENDERER_API_SKIP = true as const;

export const WORKTREE_CONFIG_METHOD_CHANNELS = {
  get: "worktree-config:get",
  setPattern: "worktree-config:set-pattern",
  setWslGit: "worktree-config:set-wsl-git",
  dismissWslBanner: "worktree-config:dismiss-wsl-banner",
} as const satisfies Record<string, keyof IpcInvokeMap>;

export interface WorktreeConfigPreloadBindings {
  get(): Promise<IpcInvokeMap["worktree-config:get"]["result"]>;
  setPattern(pattern: string): Promise<IpcInvokeMap["worktree-config:set-pattern"]["result"]>;
  setWslGit(worktreeId: string, enabled: boolean): Promise<void>;
  dismissWslBanner(worktreeId: string): Promise<void>;
}

type Invoker = (channel: string, ...args: unknown[]) => Promise<unknown>;

export function buildWorktreeConfigPreloadBindings(invoke: Invoker): WorktreeConfigPreloadBindings {
  return {
    get: () =>
      invoke(WORKTREE_CONFIG_METHOD_CHANNELS.get) as Promise<
        IpcInvokeMap["worktree-config:get"]["result"]
      >,
    setPattern: (pattern) =>
      invoke(WORKTREE_CONFIG_METHOD_CHANNELS.setPattern, { pattern }) as Promise<
        IpcInvokeMap["worktree-config:set-pattern"]["result"]
      >,
    setWslGit: (worktreeId, enabled) =>
      invoke(WORKTREE_CONFIG_METHOD_CHANNELS.setWslGit, { worktreeId, enabled }) as Promise<void>,
    dismissWslBanner: (worktreeId) =>
      invoke(WORKTREE_CONFIG_METHOD_CHANNELS.dismissWslBanner, { worktreeId }) as Promise<void>,
  };
}
