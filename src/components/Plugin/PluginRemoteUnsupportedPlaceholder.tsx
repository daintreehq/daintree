import { Monitor } from "lucide-react";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/EmptyState";
import { useHostConnection } from "@/hooks/useHostConnection";

/**
 * Shown in place of a plugin view the host declined to start for this window:
 * the plugin declares `"remote": "unsupported"`, so it only works for a person
 * sitting at the machine it runs on.
 */
export function PluginRemoteUnsupportedPlaceholder({
  pluginDisplayName,
  leave,
}: {
  pluginDisplayName: string;
  /** A host's way out of the view, drawn as the one action (the sidebar's "Show worktrees"). */
  leave?: { label: string; onClick: () => void };
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
        action={
          leave ? (
            <Button variant="outline" size="sm" onClick={() => leave.onClick()}>
              {leave.label}
            </Button>
          ) : undefined
        }
      />
    </div>
  );
}
