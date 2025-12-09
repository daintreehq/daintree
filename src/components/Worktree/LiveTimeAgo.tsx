import { useMemo } from "react";
import { useGlobalSecondTicker } from "@/hooks/useGlobalSecondTicker";
import { cn } from "@/lib/utils";

interface LiveTimeAgoProps {
  timestamp?: number | null;
  className?: string;
}

function formatTimeAgo(diffMs: number): { label: string; fullLabel: string } {
  const seconds = Math.floor(diffMs / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  let label: string;
  let fullLabel: string;

  if (seconds < 5) {
    label = "now";
    fullLabel = "just now";
  } else if (seconds < 60) {
    label = `${seconds}s`;
    fullLabel = `${seconds} seconds ago`;
  } else if (minutes < 60) {
    label = `${minutes}m`;
    fullLabel = `${minutes} minute${minutes !== 1 ? "s" : ""} ago`;
  } else if (hours < 24) {
    label = `${hours}h`;
    fullLabel = `${hours} hour${hours !== 1 ? "s" : ""} ago`;
  } else if (days < 7) {
    label = `${days}d`;
    fullLabel = `${days} day${days !== 1 ? "s" : ""} ago`;
  } else if (days < 30) {
    const weeks = Math.floor(days / 7);
    label = `${weeks}w`;
    fullLabel = `${weeks} week${weeks !== 1 ? "s" : ""} ago`;
  } else if (days < 365) {
    const months = Math.floor(days / 30);
    label = `${months}mo`;
    fullLabel = `${months} month${months !== 1 ? "s" : ""} ago`;
  } else {
    const years = Math.floor(days / 365);
    label = `${years}y`;
    fullLabel = `${years} year${years !== 1 ? "s" : ""} ago`;
  }

  return { label, fullLabel };
}

export function LiveTimeAgo({ timestamp, className }: LiveTimeAgoProps) {
  const globalTick = useGlobalSecondTicker();

  const timeData = useMemo(() => {
    void globalTick;

    if (timestamp == null) {
      return null;
    }

    const diffMs = Date.now() - timestamp;
    const { label, fullLabel } = formatTimeAgo(diffMs);
    const formattedDate = new Date(timestamp).toLocaleString();

    return { label, fullLabel, formattedDate };
  }, [timestamp, globalTick]);

  if (!timeData) {
    return null;
  }

  return (
    <span
      className={cn("tabular-nums", className)}
      title={`${timeData.fullLabel} (${timeData.formattedDate})`}
      aria-label={timeData.fullLabel}
    >
      {timeData.label}
    </span>
  );
}
