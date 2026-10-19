import type { Ref } from "react";
import { MemoryStick } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { PaneState, PaneStateActions } from "@/components/ui/PaneState";
import { getAgentConfig } from "@/config/agents";

/**
 * What an agent pane shows while its launch waits out critical kernel memory
 * pressure (#13530). States the reading, never a cause, and keeps both ways
 * out in reach: start now, or drop the launch.
 */
export function MemoryPressureGate({
  agentId,
  onLaunchAnyway,
  onCancel,
  containerRef,
}: {
  agentId?: string;
  onLaunchAnyway: () => void;
  onCancel: () => void;
  /** Where the pane's focus handler lands keyboard navigation into the gate. */
  containerRef?: Ref<HTMLDivElement>;
}) {
  const agentName = agentId ? (getAgentConfig(agentId)?.name ?? agentId) : "agent";
  return (
    <div
      ref={containerRef}
      tabIndex={-1}
      className="relative flex-1 min-h-0 focus-visible:-outline-offset-2"
    >
      <PaneState
        icon={<MemoryStick className="text-text-secondary" />}
        title={`Waiting to start ${agentName}`}
        description="macOS reports memory pressure at its critical level. It starts on its own once that eases."
      >
        <PaneStateActions>
          <Button size="sm" variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
          <Button size="sm" variant="outline" onClick={onLaunchAnyway}>
            Launch anyway
          </Button>
        </PaneStateActions>
      </PaneState>
    </div>
  );
}
