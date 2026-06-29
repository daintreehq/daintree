import type { IpcInvokeMap } from "../../types/index.js";

// Opt out of `scripts/codegen/ipc-renderer.mjs` — the renderer surface uses
// `idleBackgroundAutoClose` while the channel prefix is `idle-background:`. The
// codegen would derive `idleBackground` from the channel; we keep the hand-typed
// `idleBackgroundAutoClose` namespace in api.ts instead.
export const RENDERER_API_SKIP = true as const;

export const IDLE_BACKGROUND_METHOD_CHANNELS = {
  getConfig: "idle-background:get-config",
  updateConfig: "idle-background:update-config",
} as const satisfies Record<string, keyof IpcInvokeMap>;

type Methods = typeof IDLE_BACKGROUND_METHOD_CHANNELS;

export type IdleBackgroundAutoClosePreloadBindings = {
  [M in keyof Methods]: (
    ...args: IpcInvokeMap[Methods[M]]["args"]
  ) => Promise<IpcInvokeMap[Methods[M]]["result"]>;
};

type Invoker = (channel: string, ...args: unknown[]) => Promise<unknown>;

export function buildIdleBackgroundAutoClosePreloadBindings(
  invoke: Invoker
): IdleBackgroundAutoClosePreloadBindings {
  const out: Record<string, (...args: unknown[]) => Promise<unknown>> = {};
  for (const method of Object.keys(IDLE_BACKGROUND_METHOD_CHANNELS) as Array<keyof Methods>) {
    const channel = IDLE_BACKGROUND_METHOD_CHANNELS[method];
    out[method as string] = (...args) => invoke(channel, ...args);
  }
  return out as unknown as IdleBackgroundAutoClosePreloadBindings;
}
