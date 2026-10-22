import type { PanelLifecycleSourceHandle } from "../../services/plugin/PluginPanelLifecycleBroker.js";
import type { ClientEndpoint } from "../endpoint.js";
import type { IpcContext } from "../types.js";

type EndpointSource = PanelLifecycleSourceHandle & { isDestroyed(): boolean };

const endpointSources = new WeakMap<ClientEndpoint, EndpointSource>();

/**
 * A remote view's endpoint, shaped like the `WebContents` the lifecycle broker
 * watches. Only the endpoint closing counts as the view going away: a link
 * drop that resumes keeps the same endpoint, and its panels with it.
 */
function endpointSource(endpoint: ClientEndpoint): EndpointSource {
  let source = endpointSources.get(endpoint);
  if (!source) {
    const subscriptions = new Map<() => void, { dispose(): void }>();
    source = {
      id: endpoint.handle,
      isDestroyed: () => endpoint.isClosed(),
      once: (_event, listener) => {
        subscriptions.get(listener)?.dispose();
        subscriptions.set(listener, endpoint.onClose(listener));
      },
      removeListener: (_event, listener) => {
        subscriptions.get(listener)?.dispose();
        subscriptions.delete(listener);
      },
    };
    endpointSources.set(endpoint, source);
  }
  return source;
}

/**
 * What the lifecycle broker should watch to forget a reporter's panels: the
 * local view's `WebContents`, or the endpoint of a remote view (whose context
 * carries no `event`).
 */
export function panelLifecycleSourceFor(ctx: IpcContext): PanelLifecycleSourceHandle | undefined {
  if (ctx.event) return ctx.event.sender;
  return ctx.endpoint.kind === "remote-view" ? endpointSource(ctx.endpoint) : undefined;
}
