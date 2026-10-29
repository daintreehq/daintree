import { SquareTerminal } from "lucide-react";
import { BrandMark } from "@/components/icons/BrandMark";
import { getAgentConfig } from "@/config/agents";
import { cn } from "@/lib/utils";

/**
 * The mark of the agent CLI another host saw running, for rows that name a
 * remote agent. A plain terminal when the host didn't say which agent it was.
 */
export function RemoteAgentMark({
  agentId,
  className,
}: {
  agentId: string | null | undefined;
  className?: string;
}) {
  const config = agentId ? getAgentConfig(agentId) : undefined;
  const Icon = config?.icon ?? SquareTerminal;
  return (
    <span
      aria-hidden="true"
      className={cn("inline-flex h-3.5 w-3.5 shrink-0 items-center justify-center", className)}
    >
      <BrandMark brandColor={config?.color}>
        <Icon className={cn("h-3.5 w-3.5", !config && "text-text-secondary")} />
      </BrandMark>
    </span>
  );
}
