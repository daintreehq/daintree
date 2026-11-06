import { store } from "../../store.js";
import {
  admitRestoredPluginLaunches,
  attachPluginLaunchPersistence,
  type PluginLaunchPersistence,
} from "./pluginLaunchedAgents.js";

/** Where the plugin launch ledger lives between runs (#16240). */
export const storePluginLaunchPersistence: PluginLaunchPersistence = {
  load: () => store.get("pluginLaunchedAgents"),
  save: (records) => store.set("pluginLaunchedAgents", records),
};

/**
 * Hand the panes a hydrate restores to the ledger. A restored project can
 * hydrate before the plugin host starts, so this attaches the disk itself.
 */
export function admitRestoredPluginLaunchesFromStore(
  panes: ReadonlyArray<{ id?: unknown; launchedByPluginId?: unknown }>
): void {
  attachPluginLaunchPersistence(storePluginLaunchPersistence);
  admitRestoredPluginLaunches(panes);
}
