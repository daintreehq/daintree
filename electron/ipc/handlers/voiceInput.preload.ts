import type { IpcInvokeMap } from "../../types/index.js";

// The session-scoped invokes, and the selection rewrite. The rest of `voiceInput` (settings, permissions,
// correction, the audio send and the event subscriptions) is still wired by
// hand in `preload.cts`.
export const VOICE_INPUT_METHOD_CHANNELS = {
  start: "voice-input:start",
  stop: "voice-input:stop",
  cancel: "voice-input:cancel",
  flushParagraph: "voice-input:flush-paragraph",
  getLiveSession: "voice-input:get-live-session",
  stopLive: "voice-input:stop-live",
  revealLive: "voice-input:reveal-live",
  rewrite: "voice-input:rewrite",
  getLastTerms: "voice-input:get-last-terms",
} as const satisfies Record<string, keyof IpcInvokeMap>;

type Methods = typeof VOICE_INPUT_METHOD_CHANNELS;

export type VoiceInputPreloadBindings = {
  [M in keyof Methods]: (
    ...args: IpcInvokeMap[Methods[M]]["args"]
  ) => Promise<IpcInvokeMap[Methods[M]]["result"]>;
};

type Invoker = (channel: string, ...args: unknown[]) => Promise<unknown>;

export function buildVoiceInputPreloadBindings(invoke: Invoker): VoiceInputPreloadBindings {
  const out: Record<string, (...args: unknown[]) => Promise<unknown>> = {};
  for (const method of Object.keys(VOICE_INPUT_METHOD_CHANNELS) as Array<keyof Methods>) {
    const channel = VOICE_INPUT_METHOD_CHANNELS[method];
    out[method as string] = (...args) => invoke(channel, ...args);
  }
  return out as unknown as VoiceInputPreloadBindings;
}
