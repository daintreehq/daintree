import type { IpcInvokeMap } from "../../types/index.js";

export const REMOTE_HOSTS_METHOD_CHANNELS = {
  list: "remote-hosts:list",
  add: "remote-hosts:add",
  update: "remote-hosts:update",
  forget: "remote-hosts:forget",
  connect: "remote-hosts:connect",
  disconnect: "remote-hosts:disconnect",
  getWindowHost: "remote-hosts:get-window-host",
  switchWindowHost: "remote-hosts:switch-window-host",
  discover: "remote-hosts:discover",
  probe: "remote-hosts:probe",
  getLocalHandshake: "remote-hosts:get-local-handshake",
  isInUse: "remote-hosts:is-in-use",
  planInstall: "remote-hosts:plan-install",
  install: "remote-hosts:install",
  getInstallStatus: "remote-hosts:get-install-status",
  cancelInstall: "remote-hosts:cancel-install",
  startHostMode: "remote-hosts:start-host-mode",
  listHostProjects: "remote-hosts:list-host-projects",
} as const satisfies Record<string, keyof IpcInvokeMap>;

type Methods = typeof REMOTE_HOSTS_METHOD_CHANNELS;

export type RemoteHostsPreloadBindings = {
  [M in keyof Methods]: (
    ...args: IpcInvokeMap[Methods[M]]["args"]
  ) => Promise<IpcInvokeMap[Methods[M]]["result"]>;
};

type Invoker = (channel: string, ...args: unknown[]) => Promise<unknown>;

export function buildRemoteHostsPreloadBindings(invoke: Invoker): RemoteHostsPreloadBindings {
  const out: Record<string, (...args: unknown[]) => Promise<unknown>> = {};
  for (const method of Object.keys(REMOTE_HOSTS_METHOD_CHANNELS) as Array<keyof Methods>) {
    const channel = REMOTE_HOSTS_METHOD_CHANNELS[method];
    out[method as string] = (...args) => invoke(channel, ...args);
  }
  return out as unknown as RemoteHostsPreloadBindings;
}
