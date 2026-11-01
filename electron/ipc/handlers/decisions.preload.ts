import type { IpcInvokeMap } from "../../types/index.js";

export const DECISIONS_METHOD_CHANNELS = {
  getStatus: "decisions:get-status",
  getPaneState: "decisions:get-pane-state",
  setEnabled: "decisions:set-enabled",
  checkRelay: "decisions:check-relay",
  claimRelay: "decisions:claim-relay",
  restoreIdentity: "decisions:restore-identity",
  disconnectRelay: "decisions:disconnect-relay",
} as const satisfies Record<string, keyof IpcInvokeMap>;

type Methods = typeof DECISIONS_METHOD_CHANNELS;

export type DecisionsPreloadBindings = {
  [M in keyof Methods]: (
    ...args: IpcInvokeMap[Methods[M]]["args"]
  ) => Promise<IpcInvokeMap[Methods[M]]["result"]>;
};

type Invoker = (channel: string, ...args: unknown[]) => Promise<unknown>;

export function buildDecisionsPreloadBindings(invoke: Invoker): DecisionsPreloadBindings {
  const out: Record<string, (...args: unknown[]) => Promise<unknown>> = {};
  for (const method of Object.keys(DECISIONS_METHOD_CHANNELS) as Array<keyof Methods>) {
    const channel = DECISIONS_METHOD_CHANNELS[method];
    out[method as string] = (...args) => invoke(channel, ...args);
  }
  return out as unknown as DecisionsPreloadBindings;
}
