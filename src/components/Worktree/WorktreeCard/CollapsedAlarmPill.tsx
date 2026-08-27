import { CircleAlert } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import type { AlarmDescriptor } from "@/lib/worktreeAlarmTier";

interface CollapsedAlarmPillProps {
  alarm: AlarmDescriptor;
}

export function CollapsedAlarmPill({ alarm }: CollapsedAlarmPillProps) {
  if (alarm.tier === 0) return null;

  return (
    <Badge
      tone={alarm.tone === "error" ? "error" : "warning"}
      data-testid="collapsed-alarm-pill"
      data-alarm-kind={alarm.kind}
      aria-label={alarm.label}
      className="pointer-events-none"
    >
      <CircleAlert aria-hidden="true" />
      <span>{alarm.label}</span>
    </Badge>
  );
}
