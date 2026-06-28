import type { IpcInvokeMap } from "../../types/index.js";

export const FORGE_RECOMMENDATION_METHOD_CHANNELS = {
  getDismissed: "forge-recommendation:get-dismissed",
  markDismissed: "forge-recommendation:mark-dismissed",
} as const satisfies Record<string, keyof IpcInvokeMap>;

type Methods = typeof FORGE_RECOMMENDATION_METHOD_CHANNELS;

export type ForgeRecommendationPreloadBindings = {
  [M in keyof Methods]: (
    ...args: IpcInvokeMap[Methods[M]]["args"]
  ) => Promise<IpcInvokeMap[Methods[M]]["result"]>;
};

type Invoker = (channel: string, ...args: unknown[]) => Promise<unknown>;

export function buildForgeRecommendationPreloadBindings(
  invoke: Invoker
): ForgeRecommendationPreloadBindings {
  const out: Record<string, (...args: unknown[]) => Promise<unknown>> = {};
  for (const method of Object.keys(FORGE_RECOMMENDATION_METHOD_CHANNELS) as Array<keyof Methods>) {
    const channel = FORGE_RECOMMENDATION_METHOD_CHANNELS[method];
    out[method as string] = (...args) => invoke(channel, ...args);
  }
  return out as unknown as ForgeRecommendationPreloadBindings;
}
