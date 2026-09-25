import type { IpcInvokeMap } from "../../types/index.js";

export const DRIVE_LEASE_METHOD_CHANNELS = {
  get: "drive-lease:get",
  takeOver: "drive-lease:take-over",
} as const satisfies Record<string, keyof IpcInvokeMap>;

type Methods = typeof DRIVE_LEASE_METHOD_CHANNELS;

export type DriveLeasePreloadBindings = {
  [M in keyof Methods]: (
    ...args: IpcInvokeMap[Methods[M]]["args"]
  ) => Promise<IpcInvokeMap[Methods[M]]["result"]>;
};

type Invoker = (channel: string, ...args: unknown[]) => Promise<unknown>;

export function buildDriveLeasePreloadBindings(invoke: Invoker): DriveLeasePreloadBindings {
  const out: Record<string, (...args: unknown[]) => Promise<unknown>> = {};
  for (const method of Object.keys(DRIVE_LEASE_METHOD_CHANNELS) as Array<keyof Methods>) {
    const channel = DRIVE_LEASE_METHOD_CHANNELS[method];
    out[method as string] = (...args) => invoke(channel, ...args);
  }
  return out as unknown as DriveLeasePreloadBindings;
}
