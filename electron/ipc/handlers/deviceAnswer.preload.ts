import type { IpcInvokeMap } from "../../types/index.js";

export const DEVICE_ANSWER_METHOD_CHANNELS = {
  getStatus: "device-answer:get-status",
  setEnabled: "device-answer:set-enabled",
  createPairingCode: "device-answer:create-pairing-code",
  cancelPairingCode: "device-answer:cancel-pairing-code",
  revokeDevice: "device-answer:revoke-device",
} as const satisfies Record<string, keyof IpcInvokeMap>;

type Methods = typeof DEVICE_ANSWER_METHOD_CHANNELS;

export type DeviceAnswerPreloadBindings = {
  [M in keyof Methods]: (
    ...args: IpcInvokeMap[Methods[M]]["args"]
  ) => Promise<IpcInvokeMap[Methods[M]]["result"]>;
};

type Invoker = (channel: string, ...args: unknown[]) => Promise<unknown>;

export function buildDeviceAnswerPreloadBindings(invoke: Invoker): DeviceAnswerPreloadBindings {
  const out: Record<string, (...args: unknown[]) => Promise<unknown>> = {};
  for (const method of Object.keys(DEVICE_ANSWER_METHOD_CHANNELS) as Array<keyof Methods>) {
    const channel = DEVICE_ANSWER_METHOD_CHANNELS[method];
    out[method as string] = (...args) => invoke(channel, ...args);
  }
  return out as unknown as DeviceAnswerPreloadBindings;
}
