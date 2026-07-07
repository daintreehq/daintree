import type { IpcInvokeMap } from "../../types/index.js";

export const PAINT_SURFACE_METHOD_CHANNELS = {
  createSurface: "paint-surface:create",
  destroySurface: "paint-surface:destroy",
  setSurfaceBounds: "paint-surface:set-bounds",
  applyWebglThresholds: "paint-surface:apply-webgl-thresholds",
} as const satisfies Record<string, keyof IpcInvokeMap>;

type Methods = typeof PAINT_SURFACE_METHOD_CHANNELS;

export type PaintFabricSurfacePreloadBindings = {
  [M in keyof Methods]: (
    ...args: IpcInvokeMap[Methods[M]]["args"]
  ) => Promise<IpcInvokeMap[Methods[M]]["result"]>;
};

type Invoker = (channel: string, ...args: unknown[]) => Promise<unknown>;

export function buildPaintFabricSurfacePreloadBindings(
  invoke: Invoker
): PaintFabricSurfacePreloadBindings {
  const out: Record<string, (...args: unknown[]) => Promise<unknown>> = {};
  for (const method of Object.keys(PAINT_SURFACE_METHOD_CHANNELS) as Array<keyof Methods>) {
    const channel = PAINT_SURFACE_METHOD_CHANNELS[method];
    out[method as string] = (...args) => invoke(channel, ...args);
  }
  return out as unknown as PaintFabricSurfacePreloadBindings;
}
