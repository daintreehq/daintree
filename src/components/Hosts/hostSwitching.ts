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
import { usePendingHostSwitchStore } from "@/store/pendingHostSwitchStore";
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
 * The host list says this machine has never had a link up to the host. A host
 * the list doesn't have yet (it loads after a restore's toast can arrive) is
 * not known to be new.
 */
function neverReached(hostId: HostId): boolean {
  const entry = getHostListSnapshot().hosts.find((candidate) => candidate.descriptor.id === hostId);
  return entry !== undefined && entry.descriptor.lastSeenAt === null;
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

/** The one recovery a failed switch to a host offers. */
export interface HostSwitchRecovery {
  label: string;
  run: () => void;
}

/**
 * Whether main kept this failure on the window's switch screen, which says it
 * already: the caller adds nothing.
 */
export function isFailureOnSwitchScreen(error: unknown): boolean {
  return isClientAppError(error) && error.details?.code === "HOST_SWITCH_ON_SCREEN";
}

/**
 * Run `callback` once the failed switch's screen goes with nothing in its
 * place: Cancel took the window back to where it was. A Retry or any other
 * switch that takes the screen over ends the watch without it.
 */
function whenSwitchScreenCancelled(error: unknown, callback: () => void): void {
  const switchId = isClientAppError(error)
    ? error.details?.code === "HOST_SWITCH_ON_SCREEN" && error.details.switchId
    : null;
  if (!switchId) return;
  const store = usePendingHostSwitchStore;
  const stop = store.subscribe((state) => {
    if (state.pending?.switchId === switchId) return;
    stop();
    // After the screen has gone, so focus put back lands on the project.
    if (state.pending === null) setTimeout(callback, 0);
  });
}

/**
 * The one recovery that gets that host back, whichever control started the
 * switch and wherever its failure shows: an update for a host on another
 * build, setting up Host mode on a host never reached, the host's details
 * where ssh couldn't log in, another project where the host says this one is
 * gone, otherwise trying the same switch again.
 */
export function hostSwitchRecovery(
  hostId: HostId,
  error: unknown,
  retry: () => void
): HostSwitchRecovery {
  // Refused for its build: the update is what gets this host back, so it is
  // offered right here as well as in the host menu.
  const entry =
    isClientAppError(error) && error.code === "HOST_VERSION_MISMATCH"
      ? getHostListSnapshot().hosts.find((candidate) => candidate.descriptor.id === hostId)
      : undefined;
  // Host mode off on a host this machine has never reached: setting it up is
  // what gets it working. One it has reached is set up already, and its
  // Daintree not listening is retried once it is running there again.
  const update = entry
    ? hostUpdateOffer(entry)
    : isClientAppError(error) && error.code === "HOST_MODE_OFF" && neverReached(hostId)
      ? { hostId, target: "host" as const, label: "Set up…" }
      : null;
  if (update) {
    return { label: update.label, run: () => runHostUpdate(update.target, update.hostId) };
  }
  // ssh couldn't log in: fixed outside Daintree, and the host's details show
  // everything ssh said. Retrying first would only fail the same way.
  if (isClientAppError(error) && error.code === "HOST_SSH_ACCESS_DENIED") {
    return {
      label: "Settings…",
      run: () => {
        requestHostSettings({ kind: "detail", hostId });
        openHostsSettingsTab();
      },
    };
  }
  // The host said the project is gone: trying again can't help, picking another
  // can. A host that is itself gone from the list is a different miss.
  if (
    isClientAppError(error) &&
    error.code === "NOT_FOUND" &&
    getHostListSnapshot().hosts.some((candidate) => candidate.descriptor.id === hostId)
  ) {
    return { label: "Choose project…", run: () => void requestHostProjectPicker(hostId) };
  }
  return { label: "Retry", run: retry };
}

/**
 * The one way a failed switch to another host reads, whichever control started
 * it: the host's own words for what went wrong (never the IPC wire prefix), and
 * the one recovery {@link hostSwitchRecovery} picks. Silent for a failure the
 * window's switch screen is already showing.
 */
export function notifyHostSwitchFailure(
  hostId: HostId,
  error: unknown,
  retry: () => void,
  options?: { title?: string }
): void {
  if (isFailureOnSwitchScreen(error)) return;
  const recovery = hostSwitchRecovery(hostId, error, retry);
  notify({
    type: "error",
    context: { eventKind: "connectivity" },
    title: options?.title ?? `Couldn't switch to ${hostName(hostId)}`,
    message: clientErrorText(error, "The window stayed on its current host."),
    actions: [
      {
        label: recovery.label,
        variant: "primary",
        onClick: recovery.run,
      },
    ],
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
    // The window is on the switch's screen, saying why: it stays only once
    // the person cancels there, and then whoever asked hears so.
    if (isFailureOnSwitchScreen(error)) {
      const onStayed = options?.onStayed;
      if (onStayed) whenSwitchScreenCancelled(error, onStayed);
      return;
    }
    options?.onStayed?.();
    // The retry is the same switch, heard by the same caller.
    notifyHostSwitchFailure(
      hostId,
      error,
      () => void switchToHost(hostId, newWindow, projectId, options)
    );
  }
}
