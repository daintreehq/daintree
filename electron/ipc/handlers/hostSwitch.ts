import { defineIpcNamespace, op } from "../define.js";
import { pendingRemoteHostsHandler } from "../../remote/pendingHandler.js";
import { HOST_SWITCH_METHOD_CHANNELS } from "./hostSwitch.preload.js";
import type {
  HostSwitchPlan,
  HostSwitchPlanPayload,
} from "../../../shared/types/ipc/hostSwitch.js";

export const hostSwitchNamespace = defineIpcNamespace({
  name: "hostSwitch",
  ops: {
    plan: op(
      HOST_SWITCH_METHOD_CHANNELS.plan,
      async (_payload: HostSwitchPlanPayload): Promise<HostSwitchPlan> =>
        pendingRemoteHostsHandler(HOST_SWITCH_METHOD_CHANNELS.plan)
    ),
  },
});

export function registerHostSwitchHandlers(): () => void {
  return hostSwitchNamespace.register();
}
