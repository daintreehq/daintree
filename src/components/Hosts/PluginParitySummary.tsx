import type { HostId } from "@shared/types/remoteHosts";
import { usePluginParity } from "@/components/Plugin/usePluginParity";
import { summarizePluginParity } from "@/components/Plugin/pluginParityCopy";

/**
 * The compact plugin line for a host's overview card: "plugins: 1 missing ·
 * 1 older". Renders nothing until the host is connected and compared, or
 * when both machines have the same plugins.
 */
export function PluginParitySummary({
  hostId,
  connected,
  className,
}: {
  hostId: HostId;
  connected: boolean;
  className?: string;
}) {
  const { state } = usePluginParity(hostId, connected);
  if (state.status !== "ready") return null;
  const line = summarizePluginParity(state.rows);
  if (line === null) return null;
  return (
    <span
      className={className ?? "text-xs text-text-secondary"}
      data-testid="plugin-parity-summary"
    >
      {line}
    </span>
  );
}
