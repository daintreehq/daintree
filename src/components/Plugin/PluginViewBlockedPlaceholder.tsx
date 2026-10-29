import { useEffect, useRef } from "react";
import { Lock, ShieldOff } from "lucide-react";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/EmptyState";
import { drivenElsewhereBy, useHostConnection, useLinkDownHost } from "@/hooks/useHostConnection";
import { useControlFacts, useDriveLeaseView } from "@/components/Recovery/driveLeaseState";
import { getControlRefusalCopy } from "@/components/Recovery/recoveryCopy";
import { TakeControlOffer } from "@/components/Recovery/TakeControlOffer";

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
  pluginDisplayName,
  onRetry,
  leave,
}: {
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
        description={`Its view comes from ${machine} and runs here only with your yes. To be asked again, reset it in Settings → Hosts → ${machine} → Plugin views, then try again.`}
        action={
          <div className="flex flex-wrap items-center justify-center gap-2">
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
