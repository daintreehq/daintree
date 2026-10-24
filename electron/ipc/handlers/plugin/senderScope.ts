import { AppError } from "../../../utils/errorTypes.js";
import type { IpcContext } from "../../types.js";
import {
  projectIdFromPluginInstanceKey,
  PROJECT_PLUGIN_INSTANCE_PREFIX,
} from "../../../services/plugin/projectPluginIdentity.js";
import { isRemoteEndpointHandle } from "../../endpoint.js";
import { LOCAL_HOST_ID } from "../../../../shared/types/remoteHosts.js";

/**
 * A project plugin's actions answer only to its own project's renderers.
 *
 * The instance key names its project and is not a secret, so without this a
 * renderer for project B could register — or silently unregister — actions
 * owned by project A's plugin. Same rule, and the same reason, as
 * `plugin:invoke` and the settings bridge.
 */
export function assertSenderOwnsPluginInstance(ctx: IpcContext, pluginId: string): void {
  const boundProjectId = projectIdFromPluginInstanceKey(pluginId);
  // A `null` here means "not a project instance key" — which covers both a bare
  // app-global id and a malformed one like `project____acme.dashboard`, whose
  // separator sits at offset zero. Only the first is legitimately unconstrained,
  // so reject anything that merely looks project-scoped rather than letting the
  // guard skip and lean on an exact-match lookup further down.
  if (boundProjectId === null && pluginId.startsWith(PROJECT_PLUGIN_INSTANCE_PREFIX)) {
    throw new Error("plugin action rejected: malformed project plugin id");
  }
  if (boundProjectId !== null && boundProjectId !== ctx.projectId) {
    throw new Error("plugin action rejected: plugin belongs to a different project");
  }
}

/**
 * A call that arrived over a link from a window on another machine. Read from
 * the context's own fields so a local call never builds its endpoint.
 */
export function isRemoteCaller(ctx: IpcContext): boolean {
  return ctx.event === null && isRemoteEndpointHandle(ctx.webContentsId);
}

/**
 * The plugin declared `"remote": "unsupported"`. `hostId` is this host from
 * its own point of view; the window that shows the placeholder names the host
 * the way its person knows it.
 */
export function remoteUnsupportedError(pluginId: string): AppError {
  return new AppError({
    code: "PLUGIN_INCOMPATIBLE",
    message: `Plugin "${pluginId}" only works for a person sitting at the machine it runs on`,
    userMessage: "This plugin only works on the machine it runs on.",
    details: {
      code: "PLUGIN_INCOMPATIBLE",
      pluginId,
      hostId: LOCAL_HOST_ID,
      reason: { kind: "remote-unsupported" },
    },
  });
}
