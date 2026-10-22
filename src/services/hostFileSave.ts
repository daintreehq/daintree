import type { FileTransferEvent } from "@shared/types/ipc/fileTransfer";
import { formatErrorMessage } from "@shared/utils/errorMessage";
import { mintOperationId } from "@/clients/operationsClient";
import { currentHostId, isRemoteWindow } from "@/hooks/useHostPlatform";
import { notify } from "@/lib/notify";
import { isMac } from "@/lib/platform";
import { getDriveLeaseSnapshot } from "@/services/terminal/inputGate";
import { useHostConnectionStore } from "@/store/hostConnectionStore";
import { useNotificationStore } from "@/store/notificationStore";
import { getViewWorkspaceId } from "@/store/viewWorkspaceId";
import { isClientAppError } from "@/utils/clientAppError";
import { safeFireAndForget } from "@/utils/safeFireAndForget";

/**
 * Saving a remote window's host file to this computer: the way out for a
 * file the viewer can't show, since a default app here can't open a path on
 * another machine. The file lands in this computer's Downloads, verified and
 * quarantined like any download, and is never opened.
 */

/** This computer as a save names it, the way the host menu names it. */
export function thisComputerName(): string {
  return isMac() ? "this Mac" : "this machine";
}

export function saveHostFileLabel(): string {
  return `Save to ${thisComputerName()}`;
}

function hostLabel(): string {
  const state = useHostConnectionStore.getState();
  return state.hostName ?? state.hostId ?? "the host";
}

function baseName(filePath: string): string {
  const trimmed = filePath.replace(/[/\\]+$/, "");
  return trimmed.slice(Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\")) + 1);
}

/** Who has control of this view's project while another window does; null when this one may save. */
function controllerName(): string | null {
  const lease = getDriveLeaseSnapshot();
  if (!lease || lease.projectId !== getViewWorkspaceId() || lease.drivingHere) return null;
  return lease.holder?.clientName ?? null;
}

function takeControlOfThisProject(): void {
  // This view's own project: a lease snapshot can name another.
  const projectId = getViewWorkspaceId();
  if (!projectId) return;
  void import("@/components/Recovery/takeControl").then(({ takeControl }) =>
    takeControl(projectId)
  );
}

/** Downloads go only to the window with control: say so, with the way to get it. */
function reportControl(fileName: string, driver: string | null): void {
  notify({
    type: "info",
    title: "Another window has control",
    message: `${driver ?? "Another window"} has control of this project on ${hostLabel()}. Take control to save ${fileName} here.`,
    context: { eventKind: "host" },
    action: { label: "Take control", variant: "primary", onClick: takeControlOfThisProject },
  });
}

/** One save per host file at a time: a second click while it runs adds nothing. */
const saving = new Set<string>();

/**
 * Save a host file into this computer's Downloads, with progress and Cancel
 * on one toast. Never rejects: every outcome is reported, and a cancel is
 * silent.
 */
export async function saveHostFile(hostPath: string): Promise<void> {
  if (!isRemoteWindow() || saving.has(hostPath)) return;
  const fileName = baseName(hostPath) || hostPath;
  const driver = controllerName();
  if (driver !== null) {
    reportControl(fileName, driver);
    return;
  }

  saving.add(hostPath);
  const opId = mintOperationId();
  const host = hostLabel();
  const progressLabel = `Saving ${fileName}`;
  // Threads the save and its outcome together in the inbox.
  const correlationId = `host-file-save:${opId}`;
  const toastId = notify({
    type: "info",
    title: progressLabel,
    message: `From ${host} to Downloads on ${thisComputerName()}.`,
    duration: 0,
    progress: { value: null, label: progressLabel },
    correlationId,
    context: { eventKind: "host" },
    action: {
      label: "Cancel",
      onClick: () =>
        safeFireAndForget(window.electron.fileTransfer.cancel({ opId }), {
          context: "Cancelling a host file save",
        }),
    },
  });
  const offProgress = window.electron.fileTransfer.onEvent((event: FileTransferEvent) => {
    if (event.type !== "progress" || event.opId !== opId || event.totalBytes <= 0) return;
    useNotificationStore.getState().updateNotification(toastId, {
      progress: { value: event.transferredBytes / event.totalBytes, label: progressLabel },
    });
  });

  try {
    const result = await window.electron.fileTransfer.download({
      hostId: currentHostId(),
      hostPath,
      opId,
    });
    useNotificationStore.getState().dismissNotification(toastId);
    notify({
      type: "success",
      title: "File saved",
      message: `${baseName(result.localPath)} is in Downloads on ${thisComputerName()}.`,
      correlationId,
      context: { eventKind: "host" },
    });
  } catch (error) {
    useNotificationStore.getState().dismissNotification(toastId);
    const appError = isClientAppError(error) ? error : null;
    if (appError?.code === "CANCELLED") return;
    if (appError?.code === "DRIVEN_ELSEWHERE") {
      reportControl(fileName, controllerName());
      return;
    }
    notify({
      type: "error",
      title: "Couldn't save file",
      message:
        appError?.userMessage ??
        formatErrorMessage(error, `${fileName} couldn't be saved from ${host}.`),
      context: { eventKind: "host" },
      action: { label: "Retry", variant: "primary", onClick: () => void saveHostFile(hostPath) },
    });
  } finally {
    offProgress();
    saving.delete(hostPath);
  }
}
