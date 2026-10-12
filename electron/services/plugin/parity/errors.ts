import {
  LOCAL_HOST_ID,
  type HostId,
  type PluginIncompatibleReason,
} from "../../../../shared/types/remoteHosts.js";
import type { AppErrorDetails } from "../../../../shared/types/appError.js";
import { AppError } from "../../../utils/errorTypes.js";
import { PluginInvokeOwnershipError } from "../PluginInvokeErrors.js";

/**
 * A plugin a window on another machine asked for isn't loaded on this host.
 * `hostId` names the host as it sees itself ("local") unless the caller knows
 * the name the window uses; the window names its host from its own binding.
 */
export function pluginNotOnHostError(
  pluginId: string,
  hostId: HostId = LOCAL_HOST_ID,
  userMessage = "This plugin isn't installed on the host this window is attached to."
): AppError {
  return new AppError({
    code: "PLUGIN_NOT_ON_HOST",
    message: `Plugin "${pluginId}" is not installed on host ${hostId}`,
    userMessage,
    details: { code: "PLUGIN_NOT_ON_HOST", pluginId, hostId },
  });
}

export function pluginIncompatibleError(
  pluginId: string,
  reason: PluginIncompatibleReason,
  userMessage: string,
  hostId: HostId = LOCAL_HOST_ID
): AppError {
  return new AppError({
    code: "PLUGIN_INCOMPATIBLE",
    message: `Plugin "${pluginId}" can't run on host ${hostId} (${reason.kind})`,
    userMessage,
    details: { code: "PLUGIN_INCOMPATIBLE", pluginId, hostId, reason },
  });
}

/**
 * `plugin:invoke` from a window on another machine for a plugin this host
 * hasn't loaded. Still an ownership refusal, so it is audited as one, but it
 * carries the typed code and details the window builds its placeholder from.
 */
export class PluginNotOnHostInvokeError extends PluginInvokeOwnershipError {
  readonly code = "PLUGIN_NOT_ON_HOST" as const;
  readonly userMessage = "This plugin isn't installed on the host this window is attached to.";
  readonly details: AppErrorDetails;

  constructor(pluginId: string, channel: string) {
    super(pluginId, channel);
    this.name = "AppError";
    this.details = { code: "PLUGIN_NOT_ON_HOST", pluginId, hostId: LOCAL_HOST_ID };
  }
}
