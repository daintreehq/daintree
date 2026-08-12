import type { IpcInvokeMap } from "../../types/index.js";

export const REMOTE_ACCESS_METHOD_CHANNELS = {
  getState: "remote-access:get-state",
  updateConfig: "remote-access:update-config",
  openPairingWindow: "remote-access:open-pairing-window",
  approvePairing: "remote-access:approve-pairing",
  rejectPairing: "remote-access:reject-pairing",
  setDeviceCapabilities: "remote-access:set-device-capabilities",
  renameDevice: "remote-access:rename-device",
  disconnectDevice: "remote-access:disconnect-device",
  disconnectAllDevices: "remote-access:disconnect-all-devices",
  revokeDevice: "remote-access:revoke-device",
} as const satisfies Record<string, keyof IpcInvokeMap>;

type Methods = typeof REMOTE_ACCESS_METHOD_CHANNELS;

export type RemoteAccessPreloadBindings = {
  [M in keyof Methods]: (
    ...args: IpcInvokeMap[Methods[M]]["args"]
  ) => Promise<IpcInvokeMap[Methods[M]]["result"]>;
};

type Invoker = (channel: string, ...args: unknown[]) => Promise<unknown>;

export function buildRemoteAccessPreloadBindings(invoke: Invoker): RemoteAccessPreloadBindings {
  const out: Record<string, (...args: unknown[]) => Promise<unknown>> = {};
  for (const method of Object.keys(REMOTE_ACCESS_METHOD_CHANNELS) as Array<keyof Methods>) {
    const channel = REMOTE_ACCESS_METHOD_CHANNELS[method];
    out[method as string] = (...args) => invoke(channel, ...args);
  }
  return out as RemoteAccessPreloadBindings;
}
