import { cn } from "@/lib/utils";
import type { NodeStatus } from "@shared/types/workflowRun";
import { Tooltip, TooltipContent, TooltipTrigger, TooltipProvider } from "@/components/ui/tooltip";

interface NodeStatusBadgeProps {
  status: NodeStatus;
  className?: string;
}

const STATUS_CONFIG: Record<
  NodeStatus,
  { icon: string; color: string; pulse: boolean; label: string }
> = {
  running: { icon: "▶", color: "text-status-info", pulse: true, label: "Running" },
  completed: { icon: "✓", color: "text-status-success", pulse: false, label: "Completed" },
  failed: { icon: "✗", color: "text-status-danger", pulse: false, label: "Failed" },
  cancelled: { icon: "—", color: "text-text-muted", pulse: false, label: "Cancelled" },
  queued: { icon: "○", color: "text-text-muted", pulse: false, label: "Queued" },
  draft: { icon: "○", color: "text-text-muted", pulse: false, label: "Pending" },
  blocked: { icon: "⏸", color: "text-status-warning", pulse: false, label: "Blocked" },
  "awaiting-approval": {
    icon: "⏳",
    color: "text-status-warning",
    pulse: true,
    label: "Awaiting Approval",
  },
};

export function NodeStatusBadge({ status, className }: NodeStatusBadgeProps) {
  const config = STATUS_CONFIG[status];

  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <span
            className={cn(
              "inline-flex items-center justify-center w-4 h-4 text-[10px] font-bold rounded-full shrink-0",
              config.color,
              config.pulse && "animate-agent-pulse",
              className
            )}
            role="status"
            aria-label={config.label}
          >
            {config.icon}
          </span>
        </TooltipTrigger>
        <TooltipContent side="right">{config.label}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
