import type { IpcInvokeMap } from "../../types/index.js";

export const FLEET_METHOD_CHANNELS = {
  getSnapshot: "fleet:get-snapshot",
  parkRun: "fleet:park-run",
  unparkRun: "fleet:unpark-run",
  snoozeRun: "fleet:snooze-run",
  unsnoozeRun: "fleet:unsnooze-run",
} as const satisfies Record<string, keyof IpcInvokeMap>;

type Methods = typeof FLEET_METHOD_CHANNELS;

export type FleetPreloadBindings = {
  [M in keyof Methods]: (
    ...args: IpcInvokeMap[Methods[M]]["args"]
  ) => Promise<IpcInvokeMap[Methods[M]]["result"]>;
};

type Invoker = (channel: string, ...args: unknown[]) => Promise<unknown>;

export function buildFleetPreloadBindings(invoke: Invoker): FleetPreloadBindings {
  const out: Record<string, (...args: unknown[]) => Promise<unknown>> = {};
  for (const method of Object.keys(FLEET_METHOD_CHANNELS) as Array<keyof Methods>) {
    const channel = FLEET_METHOD_CHANNELS[method];
    out[method as string] = (...args) => invoke(channel, ...args);
  }
  return out as unknown as FleetPreloadBindings;
}
