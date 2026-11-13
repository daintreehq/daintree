import { setPluginHostTargets } from "../../services/plugin/pluginHostTargets.js";
import {
  HostPluginControlClient,
  type HostPluginControlClientDeps,
} from "./HostPluginControlClient.js";

/**
 * Hands this Shell's installed plugins their reach into its Remote Hosts
 * (#16767). The client holds no listener, timer or link: nothing runs until a
 * plugin the person let target hosts makes a call.
 */
export function installHostPluginControlClient(deps: HostPluginControlClientDeps): () => void {
  return setPluginHostTargets(new HostPluginControlClient(deps));
}
