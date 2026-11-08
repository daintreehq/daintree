import type { IpcInvokeMap } from "../../types/index.js";

export const CANOPY_WINDOW_METHOD_CHANNELS = {
  open: "canopy-window:open",
  focus: "canopy-window:focus",
  goToRun: "canopy-window:go-to-run",
  popOut: "canopy-window:pop-out",
  peekPopOut: "canopy-window:peek-pop-out",
  acknowledgePopOut: "canopy-window:acknowledge-pop-out",
} as const satisfies Record<string, keyof IpcInvokeMap>;

type Methods = typeof CANOPY_WINDOW_METHOD_CHANNELS;

export type CanopyWindowPreloadBindings = {
  [M in keyof Methods]: (
    ...args: IpcInvokeMap[Methods[M]]["args"]
  ) => Promise<IpcInvokeMap[Methods[M]]["result"]>;
};

type Invoker = (channel: string, ...args: unknown[]) => Promise<unknown>;

export function buildCanopyWindowPreloadBindings(invoke: Invoker): CanopyWindowPreloadBindings {
  const out: Record<string, (...args: unknown[]) => Promise<unknown>> = {};
  for (const method of Object.keys(CANOPY_WINDOW_METHOD_CHANNELS) as Array<keyof Methods>) {
    const channel = CANOPY_WINDOW_METHOD_CHANNELS[method];
    out[method as string] = (...args) => invoke(channel, ...args);
  }
  return out as unknown as CanopyWindowPreloadBindings;
}
