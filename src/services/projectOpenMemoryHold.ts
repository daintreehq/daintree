import { notify } from "@/lib/notify";
import { useNotificationStore } from "@/store/notificationStore";
import {
  cancelMemoryPressureHold,
  holdForMemoryPressure,
  launchDespiteMemoryPressure,
  PROJECT_OPEN_HOLD_KEY,
} from "@/store/memoryPressureWaitStore";

const HOLD_TOAST_KEY = "memory-pressure-project-open";

/**
 * Hold a project open that main refused at critical kernel memory pressure
 * (#13530). The outgoing view stays as it is; a toast says what was read and
 * offers to open anyway, and the open goes ahead on its own once pressure
 * eases. One per view: a newer open replaces it, and dismissing the toast
 * drops it.
 */
export function holdProjectOpenForMemoryPressure(
  projectName: string | undefined,
  open: (ignoreMemoryPressure: boolean) => void
): void {
  let toastId: string | null = null;
  const withdrawToast = () => {
    if (toastId) useNotificationStore.getState().dismissNotification(toastId);
    toastId = null;
  };
  holdForMemoryPressure(PROJECT_OPEN_HOLD_KEY, {
    resume: (anyway) => {
      withdrawToast();
      open(anyway);
    },
    onCancel: withdrawToast,
  });
  toastId = notify({
    type: "warning",
    title: projectName ? `Waiting to open ${projectName}` : "Waiting to open project",
    message:
      "macOS reports memory pressure at its critical level. It opens on its own once that eases.",
    actions: [
      {
        label: "Open anyway",
        variant: "primary",
        onClick: () => launchDespiteMemoryPressure(PROJECT_OPEN_HOLD_KEY),
      },
    ],
    onDismiss: () => cancelMemoryPressureHold(PROJECT_OPEN_HOLD_KEY),
    replaceKey: HOLD_TOAST_KEY,
    // The answer to an open the user just asked for, and the only place its
    // "Open anyway" lives, so quiet hours must not hold it back.
    urgent: true,
  });
}
