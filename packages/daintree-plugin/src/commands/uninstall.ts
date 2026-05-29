import { sendCliRequest } from "../ipc/client.js";

/**
 * Uninstall a plugin by its scoped id (`publisher.name`) from the running
 * Daintree instance. The host validates the id format and removes the install;
 * throws with a clear message if Daintree isn't running or the id is rejected.
 */
export async function runUninstall(pluginId: string): Promise<void> {
  await sendCliRequest("plugin.uninstall", { pluginId });
  console.log(`Uninstalled ${pluginId}`);
}
