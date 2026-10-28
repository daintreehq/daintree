import type { Ref } from "react";
import { Lock } from "lucide-react";
import { PaneState } from "@/components/ui/PaneState";
import { getAgentConfig } from "@/config/agents";

/**
 * What a pane shows while its launch waits for this window to have control of
 * the project (#13913): the host refuses to start it for a window that only
 * watches. Not a failure, so no error tone; taking control is the read-only
 * strip's action, and the launch starts on its own once control arrives.
 */
export function DriveLeaseGate({
  agentId,
  containerRef,
}: {
  agentId?: string;
  /** Where the pane's focus handler lands keyboard navigation into the gate. */
  containerRef?: Ref<HTMLDivElement>;
}) {
  const subject = agentId ? (getAgentConfig(agentId)?.name ?? agentId) : "The terminal";
  return (
    <div
      ref={containerRef}
      tabIndex={-1}
      className="relative flex-1 min-h-0 focus-visible:-outline-offset-2"
    >
      <PaneState
        icon={<Lock className="text-text-secondary" />}
        title="Waiting for control"
        description={`${subject} starts here once this window has control of the project.`}
      />
    </div>
  );
}
