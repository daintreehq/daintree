import type { IpcInvokeMap } from "../../types/index.js";

export const TRIAGE_METHOD_CHANNELS = {
  getSnapshot: "triage:get-snapshot",
  setActive: "triage:set-active",
  refresh: "triage:refresh",
  trash: "triage:trash",
  watchTerminal: "triage:watch-terminal",
  unwatchTerminal: "triage:unwatch-terminal",
  terminalInput: "triage:terminal-input",
  terminalSendKey: "triage:terminal-send-key",
  terminalSubmit: "triage:terminal-submit",
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
