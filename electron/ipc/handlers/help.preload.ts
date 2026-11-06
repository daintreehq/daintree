import type { IpcInvokeMap } from "../../types/index.js";

export const HELP_METHOD_CHANNELS = {
  getFolderPath: "help:get-folder-path",
  openAssistantContentFolder: "help:open-assistant-content-folder",
  markTerminal: "help:mark-terminal",
  unmarkTerminal: "help:unmark-terminal",
  provisionSession: "help:provision-session",
  revokeSession: "help:revoke-session",
  peekPendingHibernation: "help:peek-pending-hibernation",
  takePendingHibernation: "help:take-pending-hibernation",
  restorePendingHibernation: "help:restore-pending-hibernation",
  listPendingHibernationSlots: "help:list-pending-hibernation-slots",
  adoptDetachedSession: "help:adopt-detached-session",
  discardConversation: "help:discard-conversation",
  listPastSessions: "help:list-past-sessions",
  getStarterPrompts: "help:get-starter-prompts",
  reportPanelOpen: "help:report-panel-open",
  getPinnedActionContext: "help:get-pinned-action-context",
  ensureGlobalAssistant: "help:global-assistant-ensure",
  getGlobalAssistantState: "help:global-assistant-state",
  attachGlobalAssistant: "help:global-assistant-attach",
  detachGlobalAssistant: "help:global-assistant-detach",
  claimGlobalAssistantInput: "help:global-assistant-claim-input",
  releaseGlobalAssistantInput: "help:global-assistant-release-input",
  setGlobalAssistantInputEligible: "help:global-assistant-input-eligible",
  restartGlobalAssistant: "help:global-assistant-restart",
  discardGlobalAssistant: "help:global-assistant-discard",
  getWindowGlobalAssistantPanel: "help:window-global-assistant-panel",
  reportWindowGlobalAssistantPanel: "help:report-window-global-assistant-panel",
} as const satisfies Record<string, keyof IpcInvokeMap>;

type Methods = typeof HELP_METHOD_CHANNELS;

export type HelpPreloadBindings = {
  [M in keyof Methods]: (
    ...args: IpcInvokeMap[Methods[M]]["args"]
  ) => Promise<IpcInvokeMap[Methods[M]]["result"]>;
};

type Invoker = (channel: string, ...args: unknown[]) => Promise<unknown>;

export function buildHelpPreloadBindings(invoke: Invoker): HelpPreloadBindings {
  const out: Record<string, (...args: unknown[]) => Promise<unknown>> = {};
  for (const method of Object.keys(HELP_METHOD_CHANNELS) as Array<keyof Methods>) {
    const channel = HELP_METHOD_CHANNELS[method];
    out[method as string] = (...args) => invoke(channel, ...args);
  }
  return out as unknown as HelpPreloadBindings;
}
