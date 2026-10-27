import type { IpcInvokeMap } from "../../types/index.js";

export const CANOPY_METHOD_CHANNELS = {
  getSnapshot: "canopy:get-snapshot",
  setActive: "canopy:set-active",
  refresh: "canopy:refresh",
  reread: "canopy:reread",
  trash: "canopy:trash",
  untrash: "canopy:untrash",
  restoreTrashed: "canopy:restore-trashed",
  removeTrashed: "canopy:remove-trashed",
  emptyTrash: "canopy:empty-trash",
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
  setShown: "canopy:set-shown",
  runBranch: "canopy:run-branch",
  searchScreens: "canopy:search-screens",
  watchTerminal: "canopy:watch-terminal",
  watchAssistantTerminal: "canopy:watch-assistant-terminal",
  resolveAssistant: "canopy:resolve-assistant",
  readAgentDirectory: "canopy:read-agent-directory",
  readAssistantWork: "canopy:read-assistant-work",
  unwatchTerminal: "canopy:unwatch-terminal",
  captureBackdrop: "canopy:capture-backdrop",
  setMode: "canopy:set-mode",
  getModel: "canopy:get-model",
  getSizeHolds: "canopy:get-size-holds",
  retryModel: "canopy:retry-model",
  removeModels: "canopy:remove-models",
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
