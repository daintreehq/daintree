import { useEffect, useRef } from "react";
import { ShieldOff, Users } from "lucide-react";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/EmptyState";
import { drivenElsewhereBy, useHostConnection } from "@/hooks/useHostConnection";
import { useDriveLeaseView } from "@/components/Recovery/driveLeaseState";

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
}: {
  pluginDisplayName: string;
  onRetry: () => void;
}) {
  const { hostName } = useHostConnection();
  const machine = hostName ?? "this window's host";
  const lease = useDriveLeaseView();
  const driver = drivenElsewhereBy(lease);
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

  if (driver !== null && lease) {
    const projectId = lease.projectId;
    return (
      <div className="flex h-full w-full" data-testid="plugin-view-driven-elsewhere">
        <EmptyState
          variant="zero-data"
          scale="canvas"
          className="my-auto w-full shrink-0"
          icon={<Users />}
          title={`${pluginDisplayName} shows in the window driving this project`}
          description={`${driver} has control of it on ${machine}. Take control to show ${pluginDisplayName} here.`}
          action={
            <Button
              variant="outline"
              size="sm"
              // Loaded on use: the shared action reaches the panel store, which
              // a plugin pane's placeholder has no other reason to pull in.
              onClick={() =>
                void import("@/components/Recovery/takeControl").then(({ takeControl }) =>
                  takeControl(projectId)
                )
              }
            >
              Take control
            </Button>
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
          <Button variant="outline" size="sm" onClick={onRetry}>
            Try again
          </Button>
        }
      />
    </div>
  );
}
