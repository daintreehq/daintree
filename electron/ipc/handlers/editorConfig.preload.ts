import type { IpcInvokeMap } from "../../types/index.js";

// Opt out of `scripts/codegen/ipc-renderer.mjs` — `editor.setConfig` keeps its
// hand-typed renderer shape (`{ editor, projectId? }`) that casts to
// `EditorSetConfigPayload` in `preload.cts`. The translation lives in the
// invoke wrapper below, so the generator must skip this namespace.
export const RENDERER_API_SKIP = true as const;

export const EDITOR_CONFIG_METHOD_CHANNELS = {
  getConfig: "editor:get-config",
  setConfig: "editor:set-config",
  discover: "editor:discover",
} as const satisfies Record<string, keyof IpcInvokeMap>;

type Methods = typeof EDITOR_CONFIG_METHOD_CHANNELS;

export type EditorConfigPreloadBindings = {
  [M in keyof Methods]: (
    ...args: IpcInvokeMap[Methods[M]]["args"]
  ) => Promise<IpcInvokeMap[Methods[M]]["result"]>;
};

type Invoker = (channel: string, ...args: unknown[]) => Promise<unknown>;

export function buildEditorConfigPreloadBindings(invoke: Invoker): EditorConfigPreloadBindings {
  const out: Record<string, (...args: unknown[]) => Promise<unknown>> = {};
  for (const method of Object.keys(EDITOR_CONFIG_METHOD_CHANNELS) as Array<keyof Methods>) {
    const channel = EDITOR_CONFIG_METHOD_CHANNELS[method];
    out[method as string] = (...args) => invoke(channel, ...args);
  }
  return out as unknown as EditorConfigPreloadBindings;
}
