import { defineIpcNamespace, op } from "../define.js";
import type { IpcContext } from "../types.js";
import { requireRemoteService } from "../../remote/runtime.js";
import { HOST_SWITCH_METHOD_CHANNELS } from "./hostSwitch.preload.js";
import type {
  HostProjectPresence,
  HostSwitchCheckDestinationPayload,
  HostSwitchExecutePayload,
  HostSwitchExecuteResult,
  HostSwitchListDirectoryPayload,
  HostSwitchLocatePayload,
  HostSwitchOpPayload,
  HostSwitchPickerRootsPayload,
  HostSwitchPlan,
  HostSwitchPlanPayload,
  HostSwitchPreparation,
  HostSwitchStatus,
  HostSwitchSuggestClonePayload,
} from "../../../shared/types/ipc/hostSwitch.js";
import type { DestinationCheck } from "../../../shared/types/ipc/projectMatch.js";
import type { HostDirectoryListing, HostPickerRoots } from "../../../shared/types/ipc/hostFiles.js";

/**
 * Getting a project onto another host through git. The Shell runs the steps
 * on the source and target hosts over their links (or here, for this
 * machine); each outward step is its own call the dialog confirms first.
 */
export const hostSwitchNamespace = defineIpcNamespace({
  name: "hostSwitch",
  ops: {
    plan: op(
      HOST_SWITCH_METHOD_CHANNELS.plan,
      async (ctx: IpcContext, payload: HostSwitchPlanPayload): Promise<HostSwitchPlan> =>
        requireRemoteService("hostSwitchService").plan(ctx, payload),
      { withContext: true }
    ),
    prepare: op(
      HOST_SWITCH_METHOD_CHANNELS.prepare,
      async (ctx: IpcContext, payload: HostSwitchPlanPayload): Promise<HostSwitchPreparation> =>
        requireRemoteService("hostSwitchService").prepare(ctx, payload),
      { withContext: true }
    ),
    checkDestination: op(
      HOST_SWITCH_METHOD_CHANNELS.checkDestination,
      async (payload: HostSwitchCheckDestinationPayload): Promise<DestinationCheck> =>
        requireRemoteService("hostSwitchService").checkDestination(payload)
    ),
    execute: op(
      HOST_SWITCH_METHOD_CHANNELS.execute,
      async (
        ctx: IpcContext,
        payload: HostSwitchExecutePayload
      ): Promise<HostSwitchExecuteResult> =>
        requireRemoteService("hostSwitchService").execute(ctx, payload),
      { withContext: true }
    ),
    status: op(
      HOST_SWITCH_METHOD_CHANNELS.status,
      async (payload: HostSwitchOpPayload): Promise<HostSwitchStatus> =>
        requireRemoteService("hostSwitchService").status(payload)
    ),
    locate: op(
      HOST_SWITCH_METHOD_CHANNELS.locate,
      async (ctx: IpcContext, payload: HostSwitchLocatePayload): Promise<HostProjectPresence[]> =>
        requireRemoteService("hostSwitchService").locate(ctx, payload),
      { withContext: true }
    ),
    suggestCloneDestination: op(
      HOST_SWITCH_METHOD_CHANNELS.suggestCloneDestination,
      async (payload: HostSwitchSuggestClonePayload): Promise<DestinationCheck> =>
        requireRemoteService("hostSwitchService").suggestCloneDestination(payload)
    ),
    listDirectory: op(
      HOST_SWITCH_METHOD_CHANNELS.listDirectory,
      async (payload: HostSwitchListDirectoryPayload): Promise<HostDirectoryListing> =>
        requireRemoteService("hostSwitchService").listDirectory(payload)
    ),
    pickerRoots: op(
      HOST_SWITCH_METHOD_CHANNELS.pickerRoots,
      async (payload: HostSwitchPickerRootsPayload): Promise<HostPickerRoots> =>
        requireRemoteService("hostSwitchService").pickerRoots(payload)
    ),
    cancel: op(
      HOST_SWITCH_METHOD_CHANNELS.cancel,
      async (payload: HostSwitchOpPayload): Promise<boolean> =>
        requireRemoteService("hostSwitchService").cancel(payload)
    ),
  },
});

export function registerHostSwitchHandlers(): () => void {
  return hostSwitchNamespace.register();
}
