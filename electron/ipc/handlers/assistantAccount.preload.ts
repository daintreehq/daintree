import type { IpcInvokeMap } from "../../types/index.js";

/**
 * Opt out of the renderer-API generator.
 *
 * The account surface pushes progress events as well as answering invokes, and the
 * generated signature covers only the invoke half — a generated `assistantAccount` would
 * silently lack `onLoginProgress`, so the renderer would type-check against an API
 * missing the half that makes a login observable. The hand-written shape in `api.ts` is
 * the useful one.
 */
export const RENDERER_API_SKIP = true as const;

export const ASSISTANT_ACCOUNT_METHOD_CHANNELS = {
  getStatus: "assistant-account:get-status",
  login: "assistant-account:login",
  cancelLogin: "assistant-account:cancel-login",
  logout: "assistant-account:logout",
} as const satisfies Record<string, keyof IpcInvokeMap>;

type Methods = typeof ASSISTANT_ACCOUNT_METHOD_CHANNELS;

export type AssistantAccountPreloadBindings = {
  [M in keyof Methods]: (
    ...args: IpcInvokeMap[Methods[M]]["args"]
  ) => Promise<IpcInvokeMap[Methods[M]]["result"]>;
};

type Invoker = (channel: string, ...args: unknown[]) => Promise<unknown>;

export function buildAssistantAccountPreloadBindings(
  invoke: Invoker
): AssistantAccountPreloadBindings {
  const out: Record<string, (...args: unknown[]) => Promise<unknown>> = {};
  for (const method of Object.keys(ASSISTANT_ACCOUNT_METHOD_CHANNELS) as Array<keyof Methods>) {
    const channel = ASSISTANT_ACCOUNT_METHOD_CHANNELS[method];
    out[method as string] = (...args) => invoke(channel, ...args);
  }
  return out as unknown as AssistantAccountPreloadBindings;
}
