import type { IpcInvokeMap } from "../../types/index.js";

export const TRIAGE_METHOD_CHANNELS = {
  getSnapshot: "triage:get-snapshot",
  setActive: "triage:set-active",
  refresh: "triage:refresh",
  choose: "triage:choose",
  reply: "triage:reply",
  trash: "triage:trash",
  getKeys: "triage:get-keys",
  checkKey: "triage:check-key",
  saveKey: "triage:save-key",
  clearKey: "triage:clear-key",
} as const satisfies Record<string, keyof IpcInvokeMap>;

type Methods = typeof TRIAGE_METHOD_CHANNELS;

export type TriagePreloadBindings = {
  [M in keyof Methods]: (
    ...args: IpcInvokeMap[Methods[M]]["args"]
  ) => Promise<IpcInvokeMap[Methods[M]]["result"]>;
};

type Invoker = (channel: string, ...args: unknown[]) => Promise<unknown>;

export function buildTriagePreloadBindings(invoke: Invoker): TriagePreloadBindings {
  const out: Record<string, (...args: unknown[]) => Promise<unknown>> = {};
  for (const method of Object.keys(TRIAGE_METHOD_CHANNELS) as Array<keyof Methods>) {
    const channel = TRIAGE_METHOD_CHANNELS[method];
    out[method as string] = (...args) => invoke(channel, ...args);
  }
  return out as unknown as TriagePreloadBindings;
}
