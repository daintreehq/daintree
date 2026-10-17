import type { MouseEvent } from "react";
import { LOCAL_HOST_ID, type HostId } from "@shared/types/remoteHosts";
import type { SwitchWindowHostResult } from "@shared/types/ipc/remoteHosts";
import type { ProjectFocusOnActivateIntent } from "@shared/types/ipc/project";
import { isMac } from "@/lib/platform";
import { notify } from "@/lib/notify";
import { clientErrorText, isClientAppError } from "@/utils/clientAppError";
import { requestHostProjectPicker } from "@/components/HostSwitch/hostProjectPickerRequests";
import {
  openHostsSettingsTab,
  requestHostSettings,
} from "@/components/Settings/Hosts/hostSettingsRequests";
import { getHostListSnapshot } from "./hostList";
import { clientPlatform, localHostLabel } from "./hostModel";
import { hostUpdateOffer, runHostUpdate } from "./hostUpdate";

/** Cmd-click on macOS, Ctrl-click elsewhere: open the host in a new window. */
export function isNewWindowClick(event: Pick<MouseEvent, "metaKey" | "ctrlKey">): boolean {
  return isMac() ? event.metaKey : event.ctrlKey;
}

/** The host as the host menu names it. */
function hostName(hostId: HostId): string {
  if (hostId === LOCAL_HOST_ID) return localHostLabel(clientPlatform());
  const entry = getHostListSnapshot().hosts.find((candidate) => candidate.descriptor.id === hostId);
  return entry?.descriptor.name ?? hostId;
}

/**
 * Where a switch that named no project lands when the host had nothing to
 * return to: that host's project list, shown in this window to pick from.
 */
export function followSwitchResult(result: SwitchWindowHostResult | null | undefined): void {
  if (result?.outcome !== "choose-project") return;
  if (requestHostProjectPicker(result.hostId)) return;
  notify({
    type: "info",
    context: { eventKind: "connectivity" },
    title: `No project to return to on ${hostName(result.hostId)}`,
    message:
      "Pick one from the project switcher, or Cmd/Ctrl-click the host to open it in a new window.",
  });
}

/**
 * The one way a failed switch to another host reads, whichever control started
 * it: the host's own words for what went wrong (never the IPC wire prefix), and
 * the one recovery that gets that host back — an update for a host on another
 * build, setting up Host mode where it's off, the host's details where ssh
 * couldn't log in, otherwise trying the same switch again.
 */
export function notifyHostSwitchFailure(
  hostId: HostId,
  error: unknown,
  retry: () => void,
  options?: { title?: string }
): void {
  // Refused for its build: the update is what gets this host back, so it is
  // offered right here as well as in the host menu.
  const entry =
    isClientAppError(error) && error.code === "HOST_VERSION_MISMATCH"
      ? getHostListSnapshot().hosts.find((candidate) => candidate.descriptor.id === hostId)
      : undefined;
  // Host mode off there: setting it up is what gets this host working.
  const update = entry
    ? hostUpdateOffer(entry)
    : isClientAppError(error) && error.code === "HOST_MODE_OFF"
      ? { hostId, target: "host" as const, label: "Set up…" }
      : null;
  // The host said the project is gone: trying again can't help, picking another
  // can. A host that is itself gone from the list is a different miss.
  // ssh couldn't log in: fixed outside Daintree, and the host's details show
  // everything ssh said. Retrying first would only fail the same way.
  const accessDenied = isClientAppError(error) && error.code === "HOST_SSH_ACCESS_DENIED";
  const missing =
    !update &&
    !accessDenied &&
    isClientAppError(error) &&
    error.code === "NOT_FOUND" &&
    getHostListSnapshot().hosts.some((candidate) => candidate.descriptor.id === hostId);
  notify({
    type: "error",
    context: { eventKind: "connectivity" },
    title: options?.title ?? `Couldn't switch to ${hostName(hostId)}`,
    message: clientErrorText(error, "The window stayed on its current host."),
    actions: update
      ? [
          {
            label: update.label,
            variant: "primary",
            onClick: () => runHostUpdate(update.target, update.hostId),
          },
        ]
      : accessDenied
        ? [
            {
              label: "Settings…",
              variant: "primary",
              onClick: () => {
                requestHostSettings({ kind: "detail", hostId });
                openHostsSettingsTab();
              },
            },
          ]
        : missing
          ? [
              {
                label: "Choose project…",
                variant: "primary",
                onClick: () => void requestHostProjectPicker(hostId),
              },
            ]
          : [{ label: "Retry", variant: "primary", onClick: retry }],
  });
}

export interface SwitchToHostOptions {
  /** The window ended up where it was: the switch failed, or was cancelled or overtaken. */
  onStayed?: () => void;
  /** What to focus in the project once it is showing; ignored without a project. */
  focusIntent?: ProjectFocusOnActivateIntent;
  /**
   * The project is showing, here, in a new window, or in the window that
   * already had it — heard on a Retry from the failure toast as well.
   */
  onLanded?: () => void;
}

/**
 * Switch this window (or a new one) to a host, optionally straight into one of
 * its projects, and with that project a pane to focus once it is showing.
 */
export async function switchToHost(
  hostId: HostId,
  newWindow: boolean,
  projectId?: string,
  options?: SwitchToHostOptions
): Promise<void> {
  const focusIntent = projectId === undefined ? undefined : options?.focusIntent;
  try {
    const result = await window.electron.remoteHosts.switchWindowHost({
      hostId,
      newWindow,
      ...(projectId === undefined ? {} : { projectId }),
      ...(focusIntent === undefined ? {} : { focusIntent }),
    });
    if (result?.outcome === "superseded") options?.onStayed?.();
    if (result?.outcome === "switched" || result?.outcome === "focused-elsewhere") {
      options?.onLanded?.();
    }
    followSwitchResult(result);
  } catch (error) {
    options?.onStayed?.();
    // The retry is the same switch, heard by the same caller.
    notifyHostSwitchFailure(
      hostId,
      error,
      () => void switchToHost(hostId, newWindow, projectId, options)
    );
  }
}
