import type { ReactNode } from "react";
import { Loader2, Play } from "lucide-react";
import { cn } from "@/lib/utils";
import type { AgentState } from "@/types";

interface StateBadgeProps {
  state: AgentState;
  className?: string;
}

const STATE_CONFIG: Record<
  Exclude<AgentState, "idle" | "waiting">,
  {
    icon: ReactNode;
    label: string;
    className: string;
    tooltip: string;
  }
> = {
  working: {
    icon: <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />,
    label: "Busy",
    className:
      "bg-[color-mix(in_oklab,var(--color-state-working)_15%,transparent)] text-[var(--color-state-working)] border-[var(--color-state-working)]/40",
    tooltip: "Agent is working on your request",
  },
  running: {
    icon: <Play className="h-3 w-3 text-[var(--color-status-info)]" aria-hidden="true" />,
    label: "Running",
    className:
      "bg-[color-mix(in_oklab,var(--color-status-info)_15%,transparent)] text-[var(--color-status-info)] border-[var(--color-status-info)]/40",
    tooltip: "Process is running",
  },
  completed: {
    icon: (
      <span className="text-[var(--color-status-success)]" aria-hidden="true">
        ✓
      </span>
    ),
    label: "Done",
    className:
      "bg-[color-mix(in_oklab,var(--color-status-success)_15%,transparent)] text-[var(--color-status-success)] border-[var(--color-status-success)]/40",
    tooltip: "Agent finished this task",
  },
  failed: {
    icon: (
      <span className="text-[var(--color-status-error)]" aria-hidden="true">
        ✗
      </span>
    ),
    label: "Failed",
    className:
      "bg-[color-mix(in_oklab,var(--color-status-error)_15%,transparent)] text-[var(--color-status-error)] border-[var(--color-status-error)]/40",
    tooltip: "Agent ran into an issue",
  },
};

export function StateBadge({ state, className }: StateBadgeProps) {
  // Don't show badge for idle or waiting states - only show when busy or exited
  if (state === "idle" || state === "waiting") {
    return null;
  }

  const config = STATE_CONFIG[state];
  if (!config) {
    return null;
  }

  return (
    <div
      className={cn(
        "inline-flex items-center gap-1.5 px-2 py-0.5 rounded border text-xs font-mono",
        config.className,
        className
      )}
      role="status"
      aria-live="polite"
      title={config.tooltip}
    >
      {config.icon}
      <span>{config.label}</span>
    </div>
  );
}

export default StateBadge;
