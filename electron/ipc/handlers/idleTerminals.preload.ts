import type { IpcInvokeMap } from "../../types/index.js";

// Opt out of `scripts/codegen/ipc-renderer.mjs` — the renderer surface uses
// `idleTerminals` (plural) while the channel prefix is `idle-terminal:`
// (singular). The codegen would derive `idleTerminal` from the channel; we
// keep the hand-typed `idleTerminals` namespace in api.ts instead.
export const RENDERER_API_SKIP = true as const;

export const IDLE_TERMINAL_METHOD_CHANNELS = {
  getConfig: "idle-terminal:get-config",
  updateConfig: "idle-terminal:update-config",
  closeProject: "idle-terminal:close-project",
  dismissProject: "idle-terminal:dismiss-project",
} as const satisfies Record<string, keyof IpcInvokeMap>;

type Methods = typeof IDLE_TERMINAL_METHOD_CHANNELS;

export type IdleTerminalPreloadBindings = {
  [M in keyof Methods]: (
    ...args: IpcInvokeMap[Methods[M]]["args"]
  ) => Promise<IpcInvokeMap[Methods[M]]["result"]>;
};

type Invoker = (channel: string, ...args: unknown[]) => Promise<unknown>;

export function buildIdleTerminalPreloadBindings(invoke: Invoker): IdleTerminalPreloadBindings {
  const out: Record<string, (...args: unknown[]) => Promise<unknown>> = {};
  for (const method of Object.keys(IDLE_TERMINAL_METHOD_CHANNELS) as Array<keyof Methods>) {
    const channel = IDLE_TERMINAL_METHOD_CHANNELS[method];
    out[method as string] = (...args) => invoke(channel, ...args);
  }
  return out as unknown as IdleTerminalPreloadBindings;
}
