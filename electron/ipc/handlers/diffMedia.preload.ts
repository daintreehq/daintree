import type { IpcInvokeMap } from "../../types/index.js";

export const DIFF_MEDIA_METHOD_CHANNELS = {
  readFileVersions: "diff-media:read-file-versions",
} as const satisfies Record<string, keyof IpcInvokeMap>;

type Methods = typeof DIFF_MEDIA_METHOD_CHANNELS;

export type DiffMediaPreloadBindings = {
  [M in keyof Methods]: (
    ...args: IpcInvokeMap[Methods[M]]["args"]
  ) => Promise<IpcInvokeMap[Methods[M]]["result"]>;
};

type Invoker = (channel: string, ...args: unknown[]) => Promise<unknown>;

export function buildDiffMediaPreloadBindings(invoke: Invoker): DiffMediaPreloadBindings {
  const out: Record<string, (...args: unknown[]) => Promise<unknown>> = {};
  for (const method of Object.keys(DIFF_MEDIA_METHOD_CHANNELS) as Array<keyof Methods>) {
    const channel = DIFF_MEDIA_METHOD_CHANNELS[method];
    out[method as string] = (...args) => invoke(channel, ...args);
  }
  return out as unknown as DiffMediaPreloadBindings;
}
