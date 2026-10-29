import { useEffect, useEffectEvent, useRef } from "react";
import { Lock, ShieldOff } from "lucide-react";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/EmptyState";
import { drivenElsewhereBy, useHostConnection, useLinkDownHost } from "@/hooks/useHostConnection";
import { useControlFacts, useDriveLeaseView } from "@/components/Recovery/driveLeaseState";
import { getControlRefusalCopy } from "@/components/Recovery/recoveryCopy";
import { TakeControlOffer } from "@/components/Recovery/TakeControlOffer";
import {
  HOST_PLUGIN_VIEWS_SECTION_ID,
  hostPluginsSettingsTarget,
} from "@/components/Settings/Hosts/hostPluginRequests";
import { onPluginViewConsentReset } from "@/components/Settings/Hosts/pluginViewConsentResets";
import { actionService } from "@/services/ActionService";
import { pluginViewHostId } from "./remotePluginView";

/** Thrown when this computer won't run a host plugin's view: the person said no, or it couldn't be checked. */
export class PluginViewBlockedError extends Error {
  constructor(pluginId: string) {
    super(`The view of plugin "${pluginId}" from this window's host is blocked on this computer`);
    this.name = "PluginViewBlockedError";
  }
}

export function isPluginViewBlockedError(error: unknown): boolean {
  return error instanceof Error && error.name === "PluginViewBlockedError";
}

/**
 * Shown in place of a host plugin's view that this computer didn't run. Not a
 * failure of the plugin: the person here chose not to, or the host's bundle
 * couldn't be checked against what they allowed.
 */
export function PluginViewBlockedPlaceholder({
  pluginId,
  pluginDisplayName,
  onRetry,
  leave,
}: {
  /** The plugin's instance id on the host, which this computer's answer is kept under. */
  pluginId: string;
  pluginDisplayName: string;
  onRetry: () => void;
  /** A host's way out of the view, beside the placeholder's own action (the sidebar's "Show worktrees"). */
  leave?: { label: string; onClick: () => void };
}) {
  const leaveButton = leave ? (
    <Button variant="ghost" size="sm" onClick={() => leave.onClick()}>
      {leave.label}
    </Button>
  ) : null;
  const { hostName } = useHostConnection();
  const machine = hostName ?? "this window's host";
  const lease = useDriveLeaseView();
  const driver = drivenElsewhereBy(lease);
  const facts = useControlFacts();
  const linkDownHost = useLinkDownHost();
  // The host serves a plugin's view only to the window driving its project:
  // once this one drives it, the view loads without being asked.
  const wasDrivenElsewhere = useRef(driver !== null);
  useEffect(() => {
    if (driver !== null) {
      wasDrivenElsewhere.current = true;
      return;
    }
    if (wasDrivenElsewhere.current && lease?.drivingHere) {
      wasDrivenElsewhere.current = false;
      onRetry();
    }
  }, [driver, lease?.drivingHere, onRetry]);

  // Reset in Settings, the view asks again by itself once Settings closes.
  const hostId = pluginViewHostId();
  const blockedHere = driver === null || !lease || facts === null;
  const retryAfterReset = useEffectEvent(() => onRetry());
  useEffect(() => {
    if (hostId === null || !blockedHere) return undefined;
    return onPluginViewConsentReset(hostId, pluginId, () => retryAfterReset());
  }, [hostId, pluginId, blockedHere]);

  if (driver !== null && lease && facts !== null) {
    // Held like a file preview or a launch: the host serves the view only to
    // the window with control, and it loads by itself once this one has it.
    const copy = getControlRefusalCopy(pluginDisplayName, facts, linkDownHost);
    return (
      <div className="flex h-full w-full" data-testid="plugin-view-driven-elsewhere">
        <EmptyState
          variant="zero-data"
          scale="canvas"
          className="my-auto w-full shrink-0"
          icon={<Lock />}
          title={copy.title}
          description={copy.description}
          action={
            linkDownHost === null ? (
              <TakeControlOffer projectId={lease.projectId} facts={facts}>
                {leaveButton}
              </TakeControlOffer>
            ) : (
              leaveButton
            )
          }
        />
      </div>
    );
  }

  return (
    <div className="flex h-full w-full" data-testid="plugin-view-blocked">
      <EmptyState
        variant="zero-data"
        scale="canvas"
        className="my-auto w-full shrink-0"
        icon={<ShieldOff />}
        title={`${pluginDisplayName} is blocked on this computer`}
        description={`Its view comes from ${machine} and runs here only with your yes. Reset that answer in ${machine}'s plugin views and it asks again when you close Settings.`}
        action={
          <div className="flex flex-wrap items-center justify-center gap-2">
            {hostId !== null && (
              <Button
                variant="outline"
                size="sm"
                onClick={() =>
                  void actionService.dispatch(
                    "app.settings.openTab",
                    hostPluginsSettingsTarget(hostId, HOST_PLUGIN_VIEWS_SECTION_ID),
                    { source: "user" }
                  )
                }
              >
                Open plugin views
              </Button>
            )}
            <Button variant="outline" size="sm" onClick={onRetry}>
              Try again
            </Button>
            {leaveButton}
          </div>
        }
      />
    </div>
  );
}
