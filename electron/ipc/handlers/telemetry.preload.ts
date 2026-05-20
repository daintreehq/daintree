import type { IpcInvokeMap } from "../../types/index.js";

// Opt out of `scripts/codegen/ipc-renderer.mjs` — the renderer API uses a
// nested `preview` namespace (`telemetry.preview.getState()`) while the IPC
// channels are flat (`telemetry:preview-get-state`). The reshaping happens
// in the renderer-side `telemetry` object wired in `preload.cts`.
export const RENDERER_API_SKIP = true as const;

export const TELEMETRY_METHOD_CHANNELS = {
  get: "telemetry:get",
  setEnabled: "telemetry:set-enabled",
  markPromptShown: "telemetry:mark-prompt-shown",
  track: "telemetry:track",
  previewGetState: "telemetry:preview-get-state",
  previewToggle: "telemetry:preview-toggle",
} as const satisfies Record<string, keyof IpcInvokeMap>;

type Methods = typeof TELEMETRY_METHOD_CHANNELS;

export type TelemetryPreloadBindings = {
  [M in keyof Methods]: (
    ...args: IpcInvokeMap[Methods[M]]["args"]
  ) => Promise<IpcInvokeMap[Methods[M]]["result"]>;
};

type Invoker = (channel: string, ...args: unknown[]) => Promise<unknown>;

export function buildTelemetryPreloadBindings(invoke: Invoker): TelemetryPreloadBindings {
  const out: Record<string, (...args: unknown[]) => Promise<unknown>> = {};
  for (const method of Object.keys(TELEMETRY_METHOD_CHANNELS) as Array<keyof Methods>) {
    const channel = TELEMETRY_METHOD_CHANNELS[method];
    out[method as string] = (...args) => invoke(channel, ...args);
  }
  return out as unknown as TelemetryPreloadBindings;
}
