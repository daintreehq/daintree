import type { IpcInvokeMap } from "../../types/index.js";

export const NOTIFICATION_SOUNDS_METHOD_CHANNELS = {
  list: "notification-sounds:list",
  importSound: "notification-sounds:import",
  getCustomDir: "notification-sounds:get-custom-dir",
} as const satisfies Record<string, keyof IpcInvokeMap>;

type Methods = typeof NOTIFICATION_SOUNDS_METHOD_CHANNELS;

export type NotificationSoundsPreloadBindings = {
  [M in keyof Methods]: (
    ...args: IpcInvokeMap[Methods[M]]["args"]
  ) => Promise<IpcInvokeMap[Methods[M]]["result"]>;
};

type Invoker = (channel: string, ...args: unknown[]) => Promise<unknown>;

export function buildNotificationSoundsPreloadBindings(
  invoke: Invoker
): NotificationSoundsPreloadBindings {
  const out: Record<string, (...args: unknown[]) => Promise<unknown>> = {};
  for (const method of Object.keys(NOTIFICATION_SOUNDS_METHOD_CHANNELS) as Array<keyof Methods>) {
    const channel = NOTIFICATION_SOUNDS_METHOD_CHANNELS[method];
    out[method as string] = (...args) => invoke(channel, ...args);
  }
  return out as unknown as NotificationSoundsPreloadBindings;
}
