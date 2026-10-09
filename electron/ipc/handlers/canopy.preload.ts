import type { IpcInvokeMap } from "../../types/index.js";

export const CANOPY_METHOD_CHANNELS = {
  getSnapshot: "canopy:get-snapshot",
  setActive: "canopy:set-active",
  refresh: "canopy:refresh",
  trash: "canopy:trash",
  untrash: "canopy:untrash",
  rename: "canopy:rename",
  archive: "canopy:archive",
  unarchive: "canopy:unarchive",
  answer: "canopy:answer",
  markSeen: "canopy:mark-seen",
  setRead: "canopy:set-read",
  markAllRead: "canopy:mark-all-read",
  restoreReads: "canopy:restore-reads",
  noteSent: "canopy:note-sent",
  setScope: "canopy:set-scope",
  runBranch: "canopy:run-branch",
  watchTerminal: "canopy:watch-terminal",
  unwatchTerminal: "canopy:unwatch-terminal",
  captureBackdrop: "canopy:capture-backdrop",
  setMode: "canopy:set-mode",
  terminalInput: "canopy:terminal-input",
  terminalResize: "canopy:terminal-resize",
  terminalSendKey: "canopy:terminal-send-key",
  terminalSubmit: "canopy:terminal-submit",
} as const satisfies Record<string, keyof IpcInvokeMap>;

type Methods = typeof CANOPY_METHOD_CHANNELS;

export type CanopyPreloadBindings = {
  [M in keyof Methods]: (
    ...args: IpcInvokeMap[Methods[M]]["args"]
  ) => Promise<IpcInvokeMap[Methods[M]]["result"]>;
};

type Invoker = (channel: string, ...args: unknown[]) => Promise<unknown>;

export function buildCanopyPreloadBindings(invoke: Invoker): CanopyPreloadBindings {
  const out: Record<string, (...args: unknown[]) => Promise<unknown>> = {};
  for (const method of Object.keys(CANOPY_METHOD_CHANNELS) as Array<keyof Methods>) {
    const channel = CANOPY_METHOD_CHANNELS[method];
    out[method as string] = (...args) => invoke(channel, ...args);
  }
  return out as unknown as CanopyPreloadBindings;
}
