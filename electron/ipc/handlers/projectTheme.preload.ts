import type { IpcInvokeMap } from "../../types/index.js";

export const PROJECT_THEME_METHOD_CHANNELS = {
  get: "project-theme:get",
  setTheme: "project-theme:set-theme",
  answerSuggestion: "project-theme:answer-suggestion",
  resetSuggestion: "project-theme:reset-suggestion",
} as const satisfies Record<string, keyof IpcInvokeMap>;

type Methods = typeof PROJECT_THEME_METHOD_CHANNELS;

export type ProjectThemePreloadBindings = {
  [M in keyof Methods]: (
    ...args: IpcInvokeMap[Methods[M]]["args"]
  ) => Promise<IpcInvokeMap[Methods[M]]["result"]>;
};

type Invoker = (channel: string, ...args: unknown[]) => Promise<unknown>;

export function buildProjectThemePreloadBindings(invoke: Invoker): ProjectThemePreloadBindings {
  const out: Record<string, (...args: unknown[]) => Promise<unknown>> = {};
  for (const method of Object.keys(PROJECT_THEME_METHOD_CHANNELS) as Array<keyof Methods>) {
    const channel = PROJECT_THEME_METHOD_CHANNELS[method];
    out[method as string] = (...args) => invoke(channel, ...args);
  }
  return out as unknown as ProjectThemePreloadBindings;
}
