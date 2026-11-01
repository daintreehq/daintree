import type { IpcInvokeMap } from "../../types/index.js";

export const SCHEDULES_METHOD_CHANNELS = {
  list: "schedules:list",
  create: "schedules:create",
  update: "schedules:update",
  setEnabled: "schedules:set-enabled",
  remove: "schedules:remove",
  runNow: "schedules:run-now",
} as const satisfies Record<string, keyof IpcInvokeMap>;

type Methods = typeof SCHEDULES_METHOD_CHANNELS;

export type SchedulesPreloadBindings = {
  [M in keyof Methods]: (
    ...args: IpcInvokeMap[Methods[M]]["args"]
  ) => Promise<IpcInvokeMap[Methods[M]]["result"]>;
};

type Invoker = (channel: string, ...args: unknown[]) => Promise<unknown>;

export function buildSchedulesPreloadBindings(invoke: Invoker): SchedulesPreloadBindings {
  const out: Record<string, (...args: unknown[]) => Promise<unknown>> = {};
  for (const method of Object.keys(SCHEDULES_METHOD_CHANNELS) as Array<keyof Methods>) {
    const channel = SCHEDULES_METHOD_CHANNELS[method];
    out[method as string] = (...args) => invoke(channel, ...args);
  }
  return out as unknown as SchedulesPreloadBindings;
}
