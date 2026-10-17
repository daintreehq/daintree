import type { PluginIpcContext } from "../../../../shared/types/plugin.js";

type Handler = (ctx: PluginIpcContext, ...args: unknown[]) => unknown;

/**
 * The plugin runtime behind `plugin:invoke`, reduced to a handler table: a
 * real plugin needs its own worker process, which the harness can't start.
 * Everything in front of it (the link, the dispatcher registration, the
 * remote-unsupported refusal, invocation scope) is the real code.
 */
export const pluginHandlers = new Map<string, Handler>();
export const remoteUnsupported = new Set<string>();

export const fakePluginService = {
  listPlugins: () => [],
  getPluginRootByAuthority: () => undefined,
  isRemoteUnsupported: (pluginId: string) => remoteUnsupported.has(pluginId),
  getActiveWorktreeIdForWindow: async () => null,
  async dispatchHandler(pluginId: string, channel: string, ctx: PluginIpcContext, args: unknown[]) {
    const handler = pluginHandlers.get(`${pluginId}:${channel}`);
    if (!handler) throw new Error(`No plugin handler registered for ${pluginId}:${channel}`);
    return handler(ctx, ...args);
  },
};

export function resetFakePlugins(): void {
  pluginHandlers.clear();
  remoteUnsupported.clear();
}
