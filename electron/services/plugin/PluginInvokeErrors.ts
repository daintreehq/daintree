import { DaintreeError } from "../../utils/errorTypes.js";

/**
 * Thrown when a `plugin:invoke` targets a `pluginId` that is not a loaded
 * plugin. The renderer is a single shared `app://daintree` WebContents in which
 * every plugin runs in the same JS realm, so the host cannot bind an invocation
 * to a particular plugin by sender identity. The achievable ownership guarantee
 * is therefore: a sender may only address plugins the host has actually loaded —
 * an unknown or unloaded `pluginId` is rejected before any handler runs.
 *
 * Kept in its own module (importing only {@link DaintreeError}) so both
 * `PluginService` and the `plugin:invoke` IPC handler can reference it without a
 * circular import.
 */
export class PluginInvokeOwnershipError extends DaintreeError {
  constructor(
    public readonly pluginId: string,
    public readonly channel: string
  ) {
    super(`plugin:invoke rejected: plugin "${pluginId}" is not loaded`, { pluginId, channel });
  }
}

export function isPluginInvokeOwnershipError(error: unknown): error is PluginInvokeOwnershipError {
  return error instanceof PluginInvokeOwnershipError;
}
