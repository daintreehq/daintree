import type { IpcDispatcher, RemoteRouter } from "../../ipc/endpoint.js";
import type { IpcContext } from "../../ipc/types.js";
import { getIpcDispatcher } from "../../ipc/dispatcher.js";
import { installNotificationHostRelay, installRemoteNotificationSink } from "./notifications.js";
import { installRemoteProjectResidency } from "./residency.js";
import { HYBRID_HOST_LEGS, HYBRID_SPLITS } from "./splits.js";
import { installEndpointVisibility } from "./visibility.js";

export { acceptHostPush, acceptLocalPushForRemoteView, eventsPushSource } from "./eventsPush.js";
export { NOTIFICATION_SHOW_METHOD, showHostNotification } from "./notifications.js";
export { ViewVisibilityReporter } from "./visibility.js";

type Dispatcher = Pick<IpcDispatcher<IpcContext>, "registerHybridSplit" | "allowHybridOverLink">;

function disposeAll(disposers: Array<() => void>): () => void {
  return () => {
    for (const dispose of disposers.splice(0).reverse()) dispose();
  };
}

/**
 * Shell side: register every hybrid split so a remote-bound window's hybrid
 * calls are divided between this machine and its host. With a router, the
 * sends whose deciding half runs on the host are relayed there too.
 */
export function installHybridSplits(
  options: {
    dispatcher?: Dispatcher;
    router?: Pick<RemoteRouter, "hostForSender" | "forwardSend">;
  } = {}
): () => void {
  const dispatcher = options.dispatcher ?? getIpcDispatcher();
  const disposers = Object.entries(HYBRID_SPLITS).map(([channel, split]) =>
    dispatcher.registerHybridSplit(channel, split)
  );
  if (options.router) disposers.push(installNotificationHostRelay(options.router));
  return disposeAll(disposers);
}

/**
 * Host side: admit the host legs of those splits for link calls, route
 * notifications decided for a remote view to its Shell, keep each remote
 * view's project resident, and track which remote views are on screen.
 */
export function admitHybridHostLegs(options: { dispatcher?: Dispatcher } = {}): () => void {
  const dispatcher = options.dispatcher ?? getIpcDispatcher();
  const disposers = HYBRID_HOST_LEGS.map((channel) => dispatcher.allowHybridOverLink(channel));
  disposers.push(installRemoteNotificationSink());
  disposers.push(installRemoteProjectResidency());
  disposers.push(installEndpointVisibility());
  return disposeAll(disposers);
}
