import { SquareTerminal } from "lucide-react";
import { BrandMark } from "@/components/icons/BrandMark";
import { getAgentConfig } from "@/config/agents";

/**
 * One row of the menus that start a session on a chosen agent (#13442): the
 * agent's mark in the menu's icon gutter, then "New session with <agent>".
 */
export function NewSessionWithAgentLabel({ agentId }: { agentId: string }) {
  const config = getAgentConfig(agentId);
  const Icon = config?.icon ?? SquareTerminal;
  return (
    <>
      <span
        data-menu-icon
        aria-hidden="true"
        className="mr-2 inline-flex h-3.5 w-3.5 shrink-0 items-center justify-center"
      >
        <BrandMark brandColor={config?.color}>
          <Icon className="h-3.5 w-3.5" />
        </BrandMark>
      </span>
      New session with {config?.name ?? agentId}
    </>
  );
}
