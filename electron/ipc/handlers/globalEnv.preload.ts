import type { IpcInvokeMap } from "../../types/index.js";

// Opt out of `scripts/codegen/ipc-renderer.mjs` — `global-env:set` carries a
// `{ variables }` payload object on the IPC channel while the renderer API
// keeps the positional `set(variables)` shape. The translation lives in the
// invoke wrapper below, so the generator must skip this namespace.
export const RENDERER_API_SKIP = true as const;

export const GLOBAL_ENV_METHOD_CHANNELS = {
  get: "global-env:get",
  set: "global-env:set",
} as const satisfies Record<string, keyof IpcInvokeMap>;

export interface GlobalEnvPreloadBindings {
  get(): Promise<Record<string, string>>;
  set(variables: Record<string, string>): Promise<void>;
}

type Invoker = (channel: string, ...args: unknown[]) => Promise<unknown>;

export function buildGlobalEnvPreloadBindings(invoke: Invoker): GlobalEnvPreloadBindings {
  return {
    get: () => invoke(GLOBAL_ENV_METHOD_CHANNELS.get) as Promise<Record<string, string>>,
    set: (variables) => invoke(GLOBAL_ENV_METHOD_CHANNELS.set, { variables }) as Promise<void>,
  };
}
