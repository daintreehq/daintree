import type * as PluginServiceModule from "../../../services/PluginService.js";

export type PluginServiceSingleton = typeof PluginServiceModule.pluginService;

// Lazy accessor (mirrors helpAssistant.ts): PluginService is ~3,200 lines and
// pulls semver/ajv/yauzl — a static import here would re-anchor it on the
// eager startup path that #9285 deferred it off of.
let cachedPluginService: PluginServiceSingleton | null = null;
export async function getPluginService(): Promise<PluginServiceSingleton> {
  if (!cachedPluginService) {
    const mod = await import("../../../services/PluginService.js");
    cachedPluginService = mod.pluginService;
  }
  return cachedPluginService;
}

// The service if a plugin IPC call has already resolved it, for callers that
// must stay synchronous and have nothing to do before then.
export function peekPluginService(): PluginServiceSingleton | null {
  return cachedPluginService;
}
