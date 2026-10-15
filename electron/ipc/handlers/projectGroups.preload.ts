import type { IpcInvokeMap } from "../../types/index.js";

export const PROJECT_GROUPS_METHOD_CHANNELS = {
  list: "project-groups:list",
  create: "project-groups:create",
  rename: "project-groups:rename",
  delete: "project-groups:delete",
  reorder: "project-groups:reorder",
  setSortMode: "project-groups:set-sort-mode",
  setMembership: "project-groups:set-membership",
  setArchived: "project-groups:set-archived",
} as const satisfies Record<string, keyof IpcInvokeMap>;

type Methods = typeof PROJECT_GROUPS_METHOD_CHANNELS;

export type ProjectGroupsPreloadBindings = {
  [M in keyof Methods]: (
    ...args: IpcInvokeMap[Methods[M]]["args"]
  ) => Promise<IpcInvokeMap[Methods[M]]["result"]>;
};

type Invoker = (channel: string, ...args: unknown[]) => Promise<unknown>;

export function buildProjectGroupsPreloadBindings(invoke: Invoker): ProjectGroupsPreloadBindings {
  const out: Record<string, (...args: unknown[]) => Promise<unknown>> = {};
  for (const method of Object.keys(PROJECT_GROUPS_METHOD_CHANNELS) as Array<keyof Methods>) {
    const channel = PROJECT_GROUPS_METHOD_CHANNELS[method];
    out[method as string] = (...args) => invoke(channel, ...args);
  }
  return out as unknown as ProjectGroupsPreloadBindings;
}
