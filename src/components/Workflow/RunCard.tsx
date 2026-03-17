import { X } from "lucide-react";
import { cn } from "@/lib/utils";
import type { WorkflowRunIpc } from "@shared/types/ipc/api";
import type { WorkflowRunStatus } from "@shared/types/workflowRun";
import { NodeStatusBadge } from "./NodeStatusBadge";

interface RunCardProps {
  run: WorkflowRunIpc;
  onCancel?: (runId: string) => void;
}

const RUN_STATUS_LABELS: Record<WorkflowRunStatus, { label: string; color: string }> = {
  running: { label: "Running", color: "text-status-info" },
  completed: { label: "Completed", color: "text-status-success" },
  failed: { label: "Failed", color: "text-status-danger" },
  cancelled: { label: "Cancelled", color: "text-text-muted" },
};

function formatTimeAgo(timestamp: number): string {
  const seconds = Math.floor((Date.now() - timestamp) / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

export function RunCard({ run, onCancel }: RunCardProps) {
  const statusConfig = RUN_STATUS_LABELS[run.status];
  const nodes = run.definition.nodes;

  return (
    <div className="px-3 py-2 border-b border-divider last:border-b-0">
      <div className="flex items-center justify-between gap-2 mb-1">
        <div className="flex items-center gap-1.5 min-w-0">
          <span className="text-xs font-medium text-canopy-text truncate">
            {run.definition.name}
          </span>
          <span className={cn("text-[10px]", statusConfig.color)}>{statusConfig.label}</span>
        </div>
        <div className="flex items-center gap-1 shrink-0">
          <span className="text-[10px] text-text-muted">{formatTimeAgo(run.startedAt)}</span>
          {run.status === "running" && onCancel && (
            <button
              onClick={() => onCancel(run.runId)}
              className="p-0.5 rounded hover:bg-tint/[0.06] text-text-muted hover:text-canopy-text transition-colors"
              aria-label="Cancel workflow run"
            >
              <X className="w-3 h-3" />
            </button>
          )}
        </div>
      </div>

      <div className="space-y-0.5">
        {nodes.map((node) => {
          const nodeState = run.nodeStates[node.id];
          const status = nodeState?.status ?? "queued";
          const error = nodeState?.result?.error;

          return (
            <div key={node.id}>
              <div className="flex items-center gap-1.5">
                <NodeStatusBadge status={status} />
                <span className="text-[11px] text-canopy-text/70 truncate">{node.id}</span>
              </div>
              {error && (
                <div className="ml-5.5 text-[10px] text-status-danger truncate" title={error}>
                  {error}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
