import type { IpcInvokeMap } from "../../types/index.js";

export const USER_PROMPT_TEMPLATES_METHOD_CHANNELS = {
  list: "user-prompt-templates:list",
  openFolder: "user-prompt-templates:open-folder",
} as const satisfies Record<string, keyof IpcInvokeMap>;

type Methods = typeof USER_PROMPT_TEMPLATES_METHOD_CHANNELS;

export type UserPromptTemplatesPreloadBindings = {
  [M in keyof Methods]: (
    ...args: IpcInvokeMap[Methods[M]]["args"]
  ) => Promise<IpcInvokeMap[Methods[M]]["result"]>;
};

type Invoker = (channel: string, ...args: unknown[]) => Promise<unknown>;

export function buildUserPromptTemplatesPreloadBindings(
  invoke: Invoker
): UserPromptTemplatesPreloadBindings {
  const out: Record<string, (...args: unknown[]) => Promise<unknown>> = {};
  for (const method of Object.keys(USER_PROMPT_TEMPLATES_METHOD_CHANNELS) as Array<keyof Methods>) {
    const channel = USER_PROMPT_TEMPLATES_METHOD_CHANNELS[method];
    out[method as string] = (...args) => invoke(channel, ...args);
  }
  return out as unknown as UserPromptTemplatesPreloadBindings;
}
