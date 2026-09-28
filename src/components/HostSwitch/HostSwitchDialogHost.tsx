import { useEffect, useSyncExternalStore } from "react";
import { useProjectStore } from "@/store/projectStore";
import { HostSwitchDialog } from "./HostSwitchDialog";
import { HostProjectPicker } from "./HostProjectPicker";
import {
  currentHostProjectPickerRequest,
  dismissHostProjectPicker,
  registerHostProjectPickerHost,
  subscribeHostProjectPicker,
} from "./hostProjectPickerRequests";
import { runPendingHostSetup } from "./pendingHostSetup";
import {
  completeHostSwitchRequest,
  currentHostSwitchRequest,
  dismissHostSwitchRequest,
  registerHostSwitchDialogHost,
  subscribeHostSwitchRequests,
} from "./hostSwitchRequests";

/**
 * Shows the switch dialog when an action asks for it, a host's project list
 * when a switch to that host had nothing to return to, and runs a setup
 * recipe left behind by a clone onto this view's host. Mount once per view.
 */
export function HostSwitchDialogHost() {
  const request = useSyncExternalStore(
    subscribeHostSwitchRequests,
    currentHostSwitchRequest,
    () => null
  );
  const pickerRequest = useSyncExternalStore(
    subscribeHostProjectPicker,
    currentHostProjectPickerRequest,
    () => null
  );
  const projectId = useProjectStore((state) => state.currentProject?.id ?? null);

  useEffect(() => registerHostSwitchDialogHost(), []);
  useEffect(() => registerHostProjectPickerHost(), []);

  useEffect(() => {
    if (!projectId) return;
    const remoteHosts = window.electron?.remoteHosts;
    if (typeof remoteHosts?.isInUse !== "function") return;
    let cancelled = false;
    void remoteHosts
      .isInUse()
      .then((inUse) => (inUse && !cancelled ? runPendingHostSetup(projectId) : undefined))
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  return (
    <>
      {request && (
        <HostSwitchDialog
          key={request.id}
          request={request}
          onClose={() => dismissHostSwitchRequest(request.id)}
          onComplete={() => completeHostSwitchRequest(request.id)}
        />
      )}
      {pickerRequest && (
        <HostProjectPicker
          key={pickerRequest.id}
          hostId={pickerRequest.hostId}
          onClose={() => dismissHostProjectPicker(pickerRequest.id)}
        />
      )}
    </>
  );
}
