import { ShieldOff } from "lucide-react";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/EmptyState";
import { useHostConnection } from "@/hooks/useHostConnection";

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
