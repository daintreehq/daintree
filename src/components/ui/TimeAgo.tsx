import { cn } from "@/lib/utils";
import { formatTimeAgo } from "@/utils/timeAgo";
import { formatRelativeTime } from "@/lib/formatRelativeTime";

interface TimeAgoProps {
  timestamp: number | string;
  /** Injected clock for surfaces that tick their own `now`; defaults to the wall clock. */
  now?: number;
  /** "5 minutes ago" for settings tables and logs; rows default to the compact "5m ago". */
  verbose?: boolean;
  /** Leading words that belong inside the label, e.g. "Checked " or "connected ". */
  prefix?: string;
  className?: string;
}

/**
 * A static relative time with the exact time one hover (or one screen-reader
 * read) away. Every row that prints an age renders it through here — or
 * `LiveTimeAgo` when the label has to tick on its own — so no age on screen is
 * a dead end. A native `title` rather than a `Tooltip`: these sit inside
 * options and buttons, where a nested tooltip trigger would steal the row's
 * pointer and focus handling.
 */
export function TimeAgo({ timestamp, now, verbose, prefix, className }: TimeAgoProps) {
  const date = new Date(timestamp);
  const valid = !isNaN(date.getTime());
  const ms = date.getTime();
  const label = !valid
    ? formatTimeAgo(timestamp)
    : verbose
      ? formatRelativeTime(ms, now)
      : formatTimeAgo(ms, now);
  return (
    <time
      dateTime={valid ? date.toISOString() : undefined}
      title={valid ? date.toLocaleString() : undefined}
      className={cn("tabular-nums", className)}
    >
      {prefix}
      {label}
    </time>
  );
}
