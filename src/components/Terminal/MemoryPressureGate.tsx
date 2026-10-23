import type { Ref } from "react";
import { MemoryStick } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { PaneState, PaneStateActions } from "@/components/ui/PaneState";
import { getAgentConfig } from "@/config/agents";
import { formatBytes } from "@/lib/formatBytes";
import { pluralize } from "@/lib/pluralize";
import type { AgentLaunchHoldDetail } from "@/store/memoryPressureWaitStore";

const KERNEL_CRITICAL_COPY =
  "macOS reports memory pressure at its critical level. It starts on its own once that eases.";

/** The host's figures as it read them; the limit is its own, never a forecast. */
function holdDescription(detail: AgentLaunchHoldDetail | undefined): string {
  if (!detail || detail.reason === "kernel-critical") return KERNEL_CRITICAL_COPY;
  const { runningAgents, startingAgents, agentLaunchLimit, memoryTotalBytes } = detail.observation;
  const count =
    runningAgents === null
      ? "This host is at its agent limit."
      : startingAgents > 0
        ? `${pluralize(runningAgents + startingAgents, "agent is", "agents are")} running or starting on this host.`
        : `${pluralize(runningAgents, "agent is", "agents are")} running on this host.`;
  const limit =
    agentLaunchLimit === null
      ? ""
      : memoryTotalBytes === null
        ? ` It starts up to ${agentLaunchLimit} at once.`
        : ` With ${formatBytes(memoryTotalBytes)} of memory, it starts up to ${agentLaunchLimit} at once.`;
  return `${count}${limit} This one starts on its own when there's room.`;
}

/**
 * What an agent pane shows while its launch waits: out critical kernel memory
 * pressure (#13530), or for the host to run fewer agents than its memory
 * allows (#14221). States the reading, never a cause, and keeps both ways
 * out in reach: start now, or drop the launch.
 */
export function MemoryPressureGate({
  agentId,
  detail,
  onLaunchAnyway,
  onCancel,
  containerRef,
}: {
  agentId?: string;
  /** Why it waits and what the host showed; absent reads as the kernel hold. */
  detail?: AgentLaunchHoldDetail;
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
        description={holdDescription(detail)}
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
