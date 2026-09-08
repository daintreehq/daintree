import type { IpcInvokeMap } from "../../types/index.js";

export const SESSION_RESTORE_METHOD_CHANNELS = {
  getConfig: "session-restore:get-config",
  updateConfig: "session-restore:update-config",
} as const satisfies Record<string, keyof IpcInvokeMap>;

type Methods = typeof SESSION_RESTORE_METHOD_CHANNELS;

export type SessionRestorePreloadBindings = {
  [M in keyof Methods]: (
    ...args: IpcInvokeMap[Methods[M]]["args"]
  ) => Promise<IpcInvokeMap[Methods[M]]["result"]>;
};

type Invoker = (channel: string, ...args: unknown[]) => Promise<unknown>;

export function buildSessionRestorePreloadBindings(
  invoke: Invoker
): SessionRestorePreloadBindings {
  const out: Record<string, (...args: unknown[]) => Promise<unknown>> = {};
  for (const method of Object.keys(SESSION_RESTORE_METHOD_CHANNELS) as Array<keyof Methods>) {
    const channel = SESSION_RESTORE_METHOD_CHANNELS[method];
    out[method as string] = (...args) => invoke(channel, ...args);
  }
  return out as unknown as SessionRestorePreloadBindings;
}
