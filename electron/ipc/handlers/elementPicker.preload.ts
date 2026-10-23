import type { IpcInvokeMap } from "../../types/index.js";

export const ELEMENT_PICKER_METHOD_CHANNELS = {
  bind: "element-picker:bind",
  reselect: "element-picker:reselect",
  openWorkspace: "element-picker:workspace-open",
  closeWorkspace: "element-picker:workspace-close",
  resolve: "element-picker:resolve",
  describeProject: "element-picker:describe-project",
  sourceRevisions: "element-picker:source-revisions",
} as const satisfies Record<string, keyof IpcInvokeMap>;

type Methods = typeof ELEMENT_PICKER_METHOD_CHANNELS;

export type ElementPickerPreloadBindings = {
  [M in keyof Methods]: (
    ...args: IpcInvokeMap[Methods[M]]["args"]
  ) => Promise<IpcInvokeMap[Methods[M]]["result"]>;
};

type Invoker = (channel: string, ...args: unknown[]) => Promise<unknown>;

export function buildElementPickerPreloadBindings(invoke: Invoker): ElementPickerPreloadBindings {
  const out: Record<string, (...args: unknown[]) => Promise<unknown>> = {};
  for (const method of Object.keys(ELEMENT_PICKER_METHOD_CHANNELS) as Array<keyof Methods>) {
    const channel = ELEMENT_PICKER_METHOD_CHANNELS[method];
    out[method as string] = (...args) => invoke(channel, ...args);
  }
  return out as unknown as ElementPickerPreloadBindings;
}
