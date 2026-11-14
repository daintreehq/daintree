import type { IpcInvokeMap } from "../../types/index.js";

export const CLOUD_HOSTS_METHOD_CHANNELS = {
  getSnapshot: "cloud-hosts:get-snapshot",
  checkAccountKey: "cloud-hosts:check-account-key",
  addAccount: "cloud-hosts:add-account",
  replaceAccountKey: "cloud-hosts:replace-account-key",
  renameAccount: "cloud-hosts:rename-account",
  removeAccount: "cloud-hosts:remove-account",
  validateAccount: "cloud-hosts:validate-account",
  getCatalog: "cloud-hosts:get-catalog",
  listResources: "cloud-hosts:list-resources",
  createHost: "cloud-hosts:create-host",
  importHost: "cloud-hosts:import-host",
  startHost: "cloud-hosts:start-host",
  stopHost: "cloud-hosts:stop-host",
  retryCreate: "cloud-hosts:retry-create",
  refreshHost: "cloud-hosts:refresh-host",
  deleteMachine: "cloud-hosts:delete-machine",
  setLifetime: "cloud-hosts:set-lifetime",
} as const satisfies Record<string, keyof IpcInvokeMap>;

type Methods = typeof CLOUD_HOSTS_METHOD_CHANNELS;

export type CloudHostsPreloadBindings = {
  [M in keyof Methods]: (
    ...args: IpcInvokeMap[Methods[M]]["args"]
  ) => Promise<IpcInvokeMap[Methods[M]]["result"]>;
};

type Invoker = (channel: string, ...args: unknown[]) => Promise<unknown>;

export function buildCloudHostsPreloadBindings(invoke: Invoker): CloudHostsPreloadBindings {
  const out: Record<string, (...args: unknown[]) => Promise<unknown>> = {};
  for (const method of Object.keys(CLOUD_HOSTS_METHOD_CHANNELS) as Array<keyof Methods>) {
    const channel = CLOUD_HOSTS_METHOD_CHANNELS[method];
    out[method as string] = (...args) => invoke(channel, ...args);
  }
  return out as unknown as CloudHostsPreloadBindings;
}
