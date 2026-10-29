import { sendCliRequest } from "../ipc/client.js";

interface UninstallOptions {
  /** Also delete the plugin's settings, accounts and stored data on this machine (repository .daintree/ settings are always kept). */
  deleteSettings?: boolean;
}

/**
 * Uninstall a plugin by its scoped id (`publisher.name`) from the running
 * Daintree instance. The host validates the id format and removes the install;
 * throws with a clear message if Daintree isn't running or the id is rejected.
 * Pass `deleteSettings` to also delete the plugin's settings, secrets, connected
 * accounts and stored data on this machine.
 */
export async function runUninstall(
  pluginId: string,
  options: UninstallOptions = {}
): Promise<void> {
  const { deleteSettings } = options;
  await sendCliRequest("plugin.uninstall", { pluginId, deleteSettings });
  console.log(
    deleteSettings
      ? `Uninstalled ${pluginId} and deleted its settings, accounts and stored data`
      : `Uninstalled ${pluginId}`
  );
}
