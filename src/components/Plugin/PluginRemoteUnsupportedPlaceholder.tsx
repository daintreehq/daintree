import { Monitor } from "lucide-react";
import { EmptyState } from "@/components/ui/EmptyState";
import { useHostConnection } from "@/hooks/useHostConnection";

/**
 * Shown in place of a plugin view the host declined to start for this window:
 * the plugin declares `"remote": "unsupported"`, so it only works for a person
 * sitting at the machine it runs on.
 */
export function PluginRemoteUnsupportedPlaceholder({
  pluginDisplayName,
}: {
  pluginDisplayName: string;
}) {
  const { hostName } = useHostConnection();
  const machine = hostName ?? "its host";
  return (
    <div className="flex h-full w-full" data-testid="plugin-remote-unsupported">
      <EmptyState
        variant="zero-data"
        scale="canvas"
        className="my-auto w-full shrink-0"
        icon={<Monitor />}
        title={`${pluginDisplayName} only works when you're sitting at ${machine}`}
        description={`Open this project on ${machine} itself to use it.`}
      />
    </div>
  );
}
