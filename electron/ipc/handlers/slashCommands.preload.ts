import type { IpcInvokeMap } from "../../types/index.js";

export const SLASH_COMMANDS_METHOD_CHANNELS = {
  list: "slash-commands:list",
} as const satisfies Record<string, keyof IpcInvokeMap>;

type Methods = typeof SLASH_COMMANDS_METHOD_CHANNELS;

export type SlashCommandsPreloadBindings = {
  [M in keyof Methods]: (
    ...args: IpcInvokeMap[Methods[M]]["args"]
  ) => Promise<IpcInvokeMap[Methods[M]]["result"]>;
};

type Invoker = (channel: string, ...args: unknown[]) => Promise<unknown>;

export function buildSlashCommandsPreloadBindings(invoke: Invoker): SlashCommandsPreloadBindings {
  const out: Record<string, (...args: unknown[]) => Promise<unknown>> = {};
  for (const method of Object.keys(SLASH_COMMANDS_METHOD_CHANNELS) as Array<keyof Methods>) {
    const channel = SLASH_COMMANDS_METHOD_CHANNELS[method];
    out[method as string] = (...args) => invoke(channel, ...args);
  }
  return out as unknown as SlashCommandsPreloadBindings;
}
