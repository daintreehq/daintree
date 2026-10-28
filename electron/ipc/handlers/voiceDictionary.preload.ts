import type { IpcInvokeMap } from "../../types/index.js";

export const VOICE_DICTIONARY_METHOD_CHANNELS = {
  add: "voice-dictionary:add",
  remove: "voice-dictionary:remove",
  update: "voice-dictionary:update",
  acceptSuggestion: "voice-dictionary:accept-suggestion",
  dismissSuggestion: "voice-dictionary:dismiss-suggestion",
  recordSuggestions: "voice-dictionary:record-suggestions",
  getProject: "voice-dictionary:get-project",
  addToProject: "voice-dictionary:add-to-project",
  removeFromProject: "voice-dictionary:remove-from-project",
  updateInProject: "voice-dictionary:update-in-project",
} as const satisfies Record<string, keyof IpcInvokeMap>;

type Methods = typeof VOICE_DICTIONARY_METHOD_CHANNELS;

export type VoiceDictionaryPreloadBindings = {
  [M in keyof Methods]: (
    ...args: IpcInvokeMap[Methods[M]]["args"]
  ) => Promise<IpcInvokeMap[Methods[M]]["result"]>;
};

type Invoker = (channel: string, ...args: unknown[]) => Promise<unknown>;

export function buildVoiceDictionaryPreloadBindings(
  invoke: Invoker
): VoiceDictionaryPreloadBindings {
  const out: Record<string, (...args: unknown[]) => Promise<unknown>> = {};
  for (const method of Object.keys(VOICE_DICTIONARY_METHOD_CHANNELS) as Array<keyof Methods>) {
    const channel = VOICE_DICTIONARY_METHOD_CHANNELS[method];
    out[method as string] = (...args) => invoke(channel, ...args);
  }
  return out as unknown as VoiceDictionaryPreloadBindings;
}
