import type { IpcInvokeMap } from "../../types/index.js";

// Opt out of `scripts/codegen/ipc-renderer.mjs` — the renderer-facing
// `terminalConfig` namespace also exposes `importColorScheme()` (mapped to
// `terminal-config:import-color-scheme`), which has not migrated to the
// namespace yet (see issue #6020). The full `terminalConfig` object lives in
// `preload.cts` so the generator must skip the namespace defined here.
export const RENDERER_API_SKIP = true as const;

export const TERMINAL_CONFIG_METHOD_CHANNELS = {
  get: "terminal-config:get",
  setScrollback: "terminal-config:set-scrollback",
  setPerformanceMode: "terminal-config:set-performance-mode",
  setFontSize: "terminal-config:set-font-size",
  setFontFamily: "terminal-config:set-font-family",
  setHybridInputEnabled: "terminal-config:set-hybrid-input-enabled",
  setHybridInputAutoFocus: "terminal-config:set-hybrid-input-auto-focus",
  setColorScheme: "terminal-config:set-color-scheme",
  setCustomSchemes: "terminal-config:set-custom-schemes",
  setRecentSchemeIds: "terminal-config:set-recent-scheme-ids",
  setScreenReaderMode: "terminal-config:set-screen-reader-mode",
  setResourceMonitoring: "terminal-config:set-resource-monitoring",
  setMemoryLeakDetection: "terminal-config:set-memory-leak-detection",
  setMemoryLeakAutoRestartThresholdMb: "terminal-config:set-memory-leak-auto-restart",
  setCachedProjectViews: "terminal-config:set-cached-project-views",
} as const satisfies Record<string, keyof IpcInvokeMap>;

type Methods = typeof TERMINAL_CONFIG_METHOD_CHANNELS;

export type TerminalConfigPreloadBindings = {
  [M in keyof Methods]: (
    ...args: IpcInvokeMap[Methods[M]]["args"]
  ) => Promise<IpcInvokeMap[Methods[M]]["result"]>;
};

type Invoker = (channel: string, ...args: unknown[]) => Promise<unknown>;

export function buildTerminalConfigPreloadBindings(invoke: Invoker): TerminalConfigPreloadBindings {
  const out: Record<string, (...args: unknown[]) => Promise<unknown>> = {};
  for (const method of Object.keys(TERMINAL_CONFIG_METHOD_CHANNELS) as Array<keyof Methods>) {
    const channel = TERMINAL_CONFIG_METHOD_CHANNELS[method];
    out[method as string] = (...args) => invoke(channel, ...args);
  }
  return out as unknown as TerminalConfigPreloadBindings;
}
