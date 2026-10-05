import type { IpcInvokeMap } from "../../types/index.js";

export const PROCESSES_METHOD_CHANNELS = {
  getSnapshot: "processes:get-snapshot",
  killClosedTerminalProcesses: "processes:kill-closed-terminal-processes",
} as const satisfies Record<string, keyof IpcInvokeMap>;

type Methods = typeof PROCESSES_METHOD_CHANNELS;

export type ProcessesPreloadBindings = {
  [M in keyof Methods]: (
    ...args: IpcInvokeMap[Methods[M]]["args"]
  ) => Promise<IpcInvokeMap[Methods[M]]["result"]>;
};

type Invoker = (channel: string, ...args: unknown[]) => Promise<unknown>;

export function buildProcessesPreloadBindings(invoke: Invoker): ProcessesPreloadBindings {
  const out: Record<string, (...args: unknown[]) => Promise<unknown>> = {};
  for (const method of Object.keys(PROCESSES_METHOD_CHANNELS) as Array<keyof Methods>) {
    const channel = PROCESSES_METHOD_CHANNELS[method];
    out[method as string] = (...args) => invoke(channel, ...args);
  }
  return out as unknown as ProcessesPreloadBindings;
}
