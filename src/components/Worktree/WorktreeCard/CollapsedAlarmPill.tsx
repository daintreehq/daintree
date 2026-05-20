import { CircleAlert } from "lucide-react";
import { cn } from "@/lib/utils";
import type { AlarmDescriptor } from "@/lib/worktreeAlarmTier";

interface CollapsedAlarmPillProps {
  alarm: AlarmDescriptor;
}

export function CollapsedAlarmPill({ alarm }: CollapsedAlarmPillProps) {
  if (alarm.tier === 0) return null;

  const isError = alarm.tone === "error";

  return (
    <span
      data-testid="collapsed-alarm-pill"
      data-alarm-kind={alarm.kind}
      aria-label={alarm.label}
      className={cn(
        "inline-flex items-center gap-1 text-xs px-1.5 py-0.5 rounded shrink-0 transition-colors pointer-events-none",
        isError
          ? "bg-status-error/10 text-status-error"
          : "bg-status-warning/10 text-status-warning"
      )}
    >
      <CircleAlert className="w-3 h-3 shrink-0" aria-hidden="true" />
      <span>{alarm.label}</span>
    </span>
  );
}
