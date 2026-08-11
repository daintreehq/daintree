import type { IpcInvokeMap } from "../../types/index.js";

export const REMOTE_PANEL_PROJECTION_METHOD_CHANNELS = {
  publish: "remote-panel-projection:publish",
} as const satisfies Record<string, keyof IpcInvokeMap>;

type Methods = typeof REMOTE_PANEL_PROJECTION_METHOD_CHANNELS;

export type RemotePanelProjectionPreloadBindings = {
  [M in keyof Methods]: (
    ...args: IpcInvokeMap[Methods[M]]["args"]
  ) => Promise<IpcInvokeMap[Methods[M]]["result"]>;
};

type Invoker = (channel: string, ...args: unknown[]) => Promise<unknown>;

export function buildRemotePanelProjectionPreloadBindings(
  invoke: Invoker
): RemotePanelProjectionPreloadBindings {
  return {
    publish: (...args) => invoke(REMOTE_PANEL_PROJECTION_METHOD_CHANNELS.publish, ...args),
  } as RemotePanelProjectionPreloadBindings;
}
